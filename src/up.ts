// `convoy up <network>` — the foreground host (ported from Sources/convoy/Commands/Up.swift). The
// reboot's load-bearing verb: it brings the network's permanent sessions up as its own children (TCC
// anchor) and reconciles them every interval — respawn on exit (resuming), crash-loop flapping-cap.
// Built on the NATIVE host (src/host.ts, @myobie/pty/client) + the §5 classifier (src/flapping-cap.ts).

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { run } from "./exec.ts";
import { pretrustDirs, pretrustDirsCodex } from "./trust.ts";
import {
  classify,
  effectiveLimit,
  effectiveWindow,
  isFlapping,
  isoString,
  parseStrategyTags,
  TAG,
  writtenTags,
  type StrategyTags,
} from "./flapping-cap.ts";
import { HostLock } from "./host-lock.ts";
import { commandHashOf, gone, isPermanent, logicalId, PtyHost, type SupervisedSession } from "./host.ts";

export interface UpOptions {
  network?: string | undefined;
  fastFailWindow?: number | undefined;
  fastFailLimit?: number | undefined;
  reconcileInterval?: number | undefined;
  json?: boolean;
  once?: boolean;
  keepSessions?: boolean;
  /** Extra identities to ding on a crash/flap, on top of the auto-derived orchestrators (permanent members). */
  notify?: string[];
}

/** The BUS IDENTITY of a supervised session — the id `st message send` needs. It's NOT `logicalId` (that's a
 *  display id `dir/session-key`); the real bus id is the session's `ST_AGENT`, written into its pty.toml. Reads
 *  the toml at the `ptyfile` tag. Null if unreadable/absent. */
export function busIdOf(s: SupervisedSession): string | null {
  const pf = s.tags["ptyfile"];
  if (!pf || !existsSync(pf)) return null;
  try {
    const m = readFileSync(pf, "utf8").match(/ST_AGENT\s*=\s*"([^"]+)"/);
    return m ? (m[1] ?? null) : null;
  } catch {
    return null;
  }
}

/** Did a gone WORKER (non-permanent) session CRASH (→ ding) vs exit cleanly (→ silent)? The negative-control
 *  gate cos made hard: a nonzero exitCode (the process failed) or a `vanished` hard death dings; a clean exit
 *  (code 0 = the worker finished its task) stays SILENT. Pure → unit-testable. */
export function workerCrashed(status: SupervisedSession["status"], exitCode: number | null): boolean {
  return status === "vanished" || (exitCode !== null && exitCode !== 0);
}

/** The ORCHESTRATORS to ding when a session crash-loops or gives up: convoy can't read a role off a pty session,
 *  but permanence is a clean proxy — the CoS + supervisors run `--permanent`, workers don't — so the permanent
 *  convoy agents ARE the cos+supervisor tier. Plus any explicit `notify` ids. The crashing agent itself is
 *  excluded (no self-ding). Targets are BUS IDENTITIES (via `resolve`, injectable for tests), deduped. Pure. */
export function crashDingTargets(
  sessions: readonly SupervisedSession[],
  crasherBusId: string | null,
  notify: readonly string[],
  resolve: (s: SupervisedSession) => string | null,
): string[] {
  const ids = new Set<string>();
  for (const s of sessions) {
    if (s.tags["ptyfile.session"] === undefined) continue; // a convoy agent, not a bare pty session
    if (s.tags["strategy"] !== "permanent") continue; // orchestrators are permanent (cos + supervisors)
    const bid = resolve(s);
    if (bid && bid !== crasherBusId) ids.add(bid);
  }
  for (const n of notify) if (n && n !== crasherBusId) ids.add(n);
  return [...ids];
}

/** Send a crash/flap ding to a recipient's inbox (best-effort; a failed ding never disturbs the reconcile loop).
 *  Uses `st message send --from convoy-up` via execFile (no shell → the body is passed literally, backtick-safe). */
const DING_SENDER = "convoy-up";
async function sendDing(root: string, to: string, subject: string, body: string): Promise<boolean> {
  try {
    // st requires the SENDER to have a bus folder; convoy-up is a system pseudo-agent, so ensure its folder.
    mkdirSync(join(root, DING_SENDER, "inbox"), { recursive: true });
    mkdirSync(join(root, DING_SENDER, "archive"), { recursive: true });
    const r = await run("st", ["message", "send", to, "--from", DING_SENDER, "--subject", subject, "--priority", "high", "-m", body], {
      env: { ...process.env, ST_ROOT: root },
    });
    return r.ok;
  } catch {
    return false;
  }
}

function defaultRoot(): string {
  const env = process.env;
  if (env["ST_ROOT"]) return env["ST_ROOT"];
  return `${env["HOME"] ?? homedir()}/.local/state/smalltalk`;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function up(opts: UpOptions): Promise<number> {
  const root = opts.network ?? defaultRoot();
  const interval = opts.reconcileInterval ?? 30;
  const cliWindow = opts.fastFailWindow ?? null;
  const cliLimit = opts.fastFailLimit ?? null;
  const json = opts.json === true;
  const host = new PtyHost(opts.network ?? null);
  const lock = new HostLock(root);

  // Single-owner guard (shared with the menubar app via HostLock).
  const owner = lock.liveOwner();
  if (owner !== null) {
    process.stderr.write(`convoy up: ${lock.busyWarning(owner)}\n`);
    return 1;
  }
  lock.acquire();

  let stop = false;
  const onSignal = (): void => {
    stop = true;
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  // The human line always goes to stderr; stdout carries the JSONL stream when --json, else the line.
  const emit = (obj: Record<string, unknown>, human: string): void => {
    process.stderr.write(`${human}\n`);
    process.stdout.write(json ? `${JSON.stringify(obj)}\n` : `${human}\n`);
  };

  emit(
    { type: "up", network: root, reconcileInterval: interval },
    `hosting ${root} (reconcile every ${interval}s, cap ${effectiveLimit(null, cliLimit)} fails / ${effectiveWindow(null, cliWindow)}s)`,
  );

  // Up-scope batch pre-trust: mark every member's workspace trusted BEFORE the reconcile loop respawns any of
  // them, so an initial multi-session bring-up (all permanents gone) or a post-crash multi-respawn never races
  // the workspace-trust lost-update (a sibling's booting Claude clobbers another's just-written entry — see
  // src/trust.ts). One idempotent atomic write, up front. This is the convoy-core half of the fix; a caller
  // spawning agents outside `convoy up` uses `convoy pretrust <dirs>` before its back-to-back `convoy add`s.
  {
    const dirs = new Set<string>();
    for (const s of await host.sessions()) {
      const pf = s.tags["ptyfile"];
      const dir = pf ? dirname(pf) : s.cwd || null;
      if (dir) dirs.add(dir);
    }
    if (dirs.size > 0) {
      // Pre-trust BOTH harness configs for every member — the host doesn't track per-member harness, and a
      // cross-write is inert (a claude agent's dir listed in ~/.codex is never consulted, and vice versa).
      const { trusted } = pretrustDirs([...dirs]);
      pretrustDirsCodex([...dirs]);
      emit({ type: "pretrust", network: root, dirs: trusted.length }, `[convoy-up] pre-trusted ${trusted.length} member dir(s) (claude + codex) before reconcile`);
    }
  }

  // Classifier state keyed on the pty id; permanence remembered (pty kill strips the strategy tag).
  const state = new Map<string, StrategyTags>();
  const permanentKeys = new Set<string>();
  const supervised = new Set<string>();
  const workerDinged = new Set<string>(); // gone workers aren't respawned → dedup so we ding each once
  const notify = opts.notify ?? [];
  const dingTargets = (sessions: readonly SupervisedSession[], crasherBusId: string | null): string[] => crashDingTargets(sessions, crasherBusId, notify, busIdOf);

  const tick = async (): Promise<void> => {
    const now = new Date();
    const sessions = await host.sessions();
    for (const s of sessions) {
      if (isPermanent(s)) permanentKeys.add(s.name);
      const permanent = isPermanent(s) || permanentKeys.has(s.name);

      // WORKER-CRASH: a gone NON-permanent convoy agent (a worker). convoy up does NOT respawn it — workers are
      // ephemeral (Nomad no-respawn) — but a CRASH is ding-worthy so its supervisor + cos know. Gate on the exit
      // (workers have no fast-fail loop, since they're never respawned): a nonzero exitCode or a hard `vanished`
      // death dings; a CLEAN exit (code 0 = the worker finished its task) stays SILENT (routine). Dedup: a gone
      // worker re-appears every tick, so ding ONCE. Target = cos + all permanent supervisors (no spawner tag
      // exists to derive the specific owner yet — a follow-up).
      if (!permanent && s.tags["ptyfile.session"] !== undefined) {
        if (!gone(s) || workerDinged.has(s.name)) continue;
        workerDinged.add(s.name); // mark regardless — a clean-exit worker must not be re-checked either
        if (!workerCrashed(s.status, s.exitCode)) continue; // routine clean exit (code 0) → silent
        const id = busIdOf(s) ?? logicalId(s);
        const reason = s.status === "vanished" ? "vanished (hard death — no exit record)" : `exit ${s.exitCode}`;
        const targets = dingTargets(sessions, busIdOf(s));
        const body = `Worker ${id} CRASHED (${reason}) on network ${root} — it is NOT auto-respawned (workers are ephemeral). NEEDS ATTENTION: its supervisor should decide whether to re-spawn or redirect it. Inspect: pty peek ${s.name}.`;
        for (const t of targets) await sendDing(root, t, `worker crash: ${id}`, body);
        emit(
          { type: "worker_crash", identity: id, session: s.name, exitCode: s.exitCode, status: s.status, dinged: targets.length, ts: isoString(now) },
          `[convoy-up] worker crash ${id} session=${s.name} (${reason}) — dinged ${targets.length} orchestrator(s)`,
        );
        continue;
      }

      if (!permanent) continue; // a non-convoy-agent, non-permanent session — not ours to supervise
      supervised.add(s.name);
      if (!gone(s)) continue;

      const key = s.name;
      let prior = state.get(key) ?? parseStrategyTags(s.tags);

      // §5.5 manual reset — operator cleared strategy.status on disk; honor it (status + counter).
      if (isFlapping(prior) && s.tags[TAG.status] === undefined) {
        prior = { ...prior, status: null, consecutiveFastFails: 0 };
        state.set(key, prior);
        emit(
          { type: "reset", identity: logicalId(s), session: s.name, reason: "manual", ts: isoString(now) },
          `[convoy-up] reset ${logicalId(s)} session=${s.name} — operator cleared strategy.status; retrying.`,
        );
      }

      const window = effectiveWindow(prior.fastFailWindowOverride, cliWindow);
      const limit = effectiveLimit(prior.fastFailLimitOverride, cliLimit);
      const decision = classify({ session: s.name, exitedAt: s.exitedAt, tags: prior, currentHash: commandHashOf(s), window, limit, now });

      if (decision.kind === "skip") continue;

      if (decision.kind === "respawn") {
        state.set(key, decision.tags);
        const ok = await host.respawn(s); // pty restart -y — preserves the real command (strips tags)
        // Re-assert permanence + the counter AFTER the restart (it strips runtime tags) — for pty's
        // display + so a fresh host still recognizes this session. convoy's own store is authoritative.
        host.setTags(s.name, { ...writtenTags(decision.tags), strategy: "permanent" });
        emit(
          { type: "respawn", identity: logicalId(s), session: s.name, reason: "exited", attempt: decision.tags.consecutiveFastFails, cap: limit, ok, ts: isoString(now) },
          `[convoy-up] respawn ${logicalId(s)} session=${s.name} reason=exited attempt=${decision.tags.consecutiveFastFails}/${limit}${ok ? "" : " (spawn FAILED)"}`,
        );
        // Ding the orchestrators on a fast-fail CRASH (consecutiveFastFails ≥ 1) — the agent died fast + is being
        // respawned; gate OUT routine respawns (counter 0 = a normal/slow exit, not a crash) as noise.
        if (decision.tags.consecutiveFastFails >= 1) {
          const id = busIdOf(s) ?? logicalId(s);
          const targets = dingTargets(sessions, busIdOf(s));
          const body = `Agent ${id} CRASHED (fast-fail ${decision.tags.consecutiveFastFails}/${limit}) on network ${root} — convoy up is auto-respawning it. NEEDS ATTENTION if it keeps crashing: pty peek ${s.name} to see why.`;
          for (const t of targets) await sendDing(root, t, `crash: ${id}`, body);
        }
      } else {
        state.set(key, decision.tags);
        host.setTags(s.name, writtenTags(decision.tags)); // strategy.status=flapping for pty's badge
        const e = decision.event;
        emit(
          { session: s.name, type: "session_flapping", ts: isoString(e.ts), counter: e.counter, limit: e.limit, window: e.window },
          `[convoy-up] flapping ${logicalId(s)} session=${s.name} — parked after ${e.counter} fast fails (cap ${e.limit}/${e.window}s). \`pty tag ${s.name} --rm strategy.status\` to retry.`,
        );
        // Ding the orchestrators on a GAVE-UP (flapping) — the strongest signal: convoy up stopped respawning it.
        // This fires once (the tick that transitions to flapping; subsequent ticks `skip`), so no ding spam.
        const id = busIdOf(s) ?? logicalId(s);
        const targets = dingTargets(sessions, busIdOf(s));
        const body = `Agent ${id} GAVE UP — flapping/parked after ${e.counter} fast fails (cap ${e.limit}/${e.window}s) on network ${root}. NEEDS ATTENTION: it is crash-looping and convoy up stopped respawning it. Inspect (pty peek ${s.name}), fix the cause, then clear its strategy.status to retry.`;
        for (const t of targets) await sendDing(root, t, `flapping: ${id}`, body);
      }
    }
  };

  do {
    await tick();
    if (opts.once === true) break;
    for (let left = interval * 4; left > 0 && !stop; left--) await sleep(250);
  } while (!stop);

  // teardown — DECOUPLED (Nomad model): stopping OR crashing the supervisor NEVER tears down the
  // workloads. Agents are long-lived and keep running their last orders; a supervisor restart
  // re-adopts the still-running sessions (the reconcile skips live ones — `if (!gone(s)) continue`).
  // To intentionally stop the network, use `convoy down` (explicit teardown), not a `convoy up` stop.
  void opts.keepSessions; // retained for API compat; teardown no longer kills regardless.
  emit(
    { type: "teardown", stopped: 0, kept: supervised.size },
    `[convoy-up] stopping host; leaving ${supervised.size} session(s) running — agents are decoupled from the supervisor (use \`convoy down\` to tear down).`,
  );
  lock.release();
  return 0;
}

export interface DownOptions {
  network?: string | undefined;
  json?: boolean;
  dryRun?: boolean;
  force?: boolean;
}

/** `convoy down [<network>]` — explicit teardown; the ONLY path that kills sessions. Mirror of the
 *  Nomad model: stopping `convoy up` DETACHES (agents keep running), `convoy down` TEARS DOWN. Scope
 *  is convoy's own agents (sessions spawned from a pty.toml — the `ptyfile.session` tag), so it never
 *  nukes unrelated pty sessions. Refuses while a `convoy up`/app host holds the lock — it would respawn
 *  what we kill (reconcile respawns gone permanent sessions) — unless `--force`. */
export async function down(opts: DownOptions): Promise<number> {
  const root = opts.network ?? defaultRoot();
  const host = new PtyHost(opts.network ?? null);
  const lock = new HostLock(root);
  const json = opts.json === true;
  const out = (s = ""): void => {
    process.stdout.write(`${s}\n`);
  };

  // convoy's own agents (spawned from a pty.toml) that are still LIVE. Excludes `gone` sessions:
  // their metadata lingers on disk after exit, but a teardown only kills the running ones — counting
  // already-dead sessions would fail their `pty kill` and mis-report a clean teardown as a failure.
  const agents = (await host.sessions()).filter((s) => s.tags["ptyfile.session"] !== undefined && !gone(s));

  if (agents.length === 0) {
    if (json) out(JSON.stringify({ type: "down", network: root, planned: 0, stopped: 0, failed: 0 }));
    else out(`convoy down: no live agent sessions on ${root} — already down.`);
    return 0;
  }

  if (!json) {
    out(`convoy down — tearing down ${agents.length} agent session(s) on ${root}:`);
    for (const s of agents) out(`  kill ${logicalId(s)} (${s.name})`);
  }

  // Dry-run is read-only — never gated on the host lock (a preview must work even while `up` hosts).
  if (opts.dryRun === true) {
    if (json) out(JSON.stringify({ type: "down", network: root, dryRun: true, planned: agents.length, sessions: agents.map((s) => ({ id: logicalId(s), session: s.name })) }));
    else out(`\n✓ Dry run only. Re-run without --dry-run to tear down.`);
    return 0;
  }

  // Real teardown — a live `convoy up`/app host would RESPAWN gone permanent sessions (reconcile:
  // `if (!gone(s)) continue`), fighting the kill. Refuse unless --force, and point at the owner.
  const owner = lock.liveOwner();
  if (owner !== null && opts.force !== true) {
    process.stderr.write(
      `convoy down: convoy up is hosting this network (pid ${owner}) — it would respawn what we tear down.\n` +
        `Stop the host first (Ctrl-C / kill ${owner}), then \`convoy down\` — or \`convoy down --force\` to override.\n`,
    );
    return 1;
  }

  // Claim the lock for the teardown so a `convoy up` can't start mid-kill and re-adopt/respawn what we
  // stop. Skip when --force overrides a live owner (we must never clobber another host's lock).
  const acquired = owner === null;
  if (acquired) lock.acquire();
  try {
    const stopped: string[] = [];
    const failed: string[] = [];
    for (const s of agents) {
      const ok = await host.kill(s.name);
      (ok ? stopped : failed).push(s.name);
      if (!json) out(ok ? `✓ stopped ${logicalId(s)} (${s.name})` : `• ${logicalId(s)} (${s.name}) didn't stop cleanly (already exited?)`);
    }
    if (json) out(JSON.stringify({ type: "down", network: root, planned: agents.length, stopped: stopped.length, failed: failed.length }));
    else out(`✓ convoy down complete — ${stopped.length}/${agents.length} stopped${failed.length ? `, ${failed.length} failed` : ""}.`);
    return failed.length > 0 ? 1 : 0;
  } finally {
    if (acquired) lock.release();
  }
}
