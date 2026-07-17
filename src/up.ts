// `convoy up <network>` — the foreground host (ported from Sources/convoy/Commands/Up.swift). The
// reboot's load-bearing verb: it brings the network's permanent sessions up as its own children (TCC
// anchor) and reconciles them every interval — respawn on exit (resuming), crash-loop flapping-cap.
// Built on the NATIVE host (src/host.ts, @myobie/pty/client) + the §5 classifier (src/flapping-cap.ts).

import { existsSync, mkdirSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import { run } from "./exec.ts";
import { pretrustDirs, pretrustDirsCodex } from "./trust.ts";
import { defaultConvoyNetwork, isNetworkName, networkDirForName, networkDirOfStRoot, stRootOf } from "./paths.ts";
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
import { commandHashOf, gone, isPermanent, logicalId, processAlive, PtyHost, type SupervisedSession } from "./host.ts";
import { agentBusId, readCatalog, reconcilePlan } from "./reconcile.ts";
import { agentFileToSpec, catalogDir } from "./agent-file.ts";
import { nativeLaunch } from "./launch.ts";
import { shortHostname } from "./agent-spec.ts";

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

/** Did a gone WORKER (non-permanent) session CRASH (→ ding) vs exit cleanly (→ silent)? ONLY a clean exit (status
 *  "exited" with code 0) stays SILENT; everything else — nonzero exit, a NULL exit (daemon wrote no exit code), or
 *  a hard `vanished` death (daemon died without an exit record) — DINGS. Pure → unit-testable.
 *
 *  OOM COVERAGE — resolved w/ pty-claude + evals (2026-07-11). An OOM/SIGKILL surfaces in one of three ways:
 *    • The whole session/daemon dies → `vanished` (no exit record) → DINGS ✓.
 *    • CASE A — the AGENT PROCESS ITSELF is OOM/SIGKILL-killed. Convoy execs the harness (`sh -c "exec claude …"`), so
 *      the harness IS node-pty's direct child; pty ≥ #72 records its signal-death as exitCode = 128+signal (137 for
 *      SIGKILL) → the existing `exitCode !== 0` gate DINGS it, NO convoy change. (pty < #72 dropped the signal and
 *      recorded exit 0 → silently missed — so the OOM catch REQUIRES pty ≥ #72.) This is the real agent-crash OOM case.
 *    • CASE B — a reaped GRANDCHILD: a harness spawns a sub-worker, the sub-worker is OOM-killed, the harness reaps it
 *      and itself exits 0. pty legitimately records exit 0 (byte-identical to a clean finish) → SILENT. A fundamental
 *      blind spot at the exit-record layer (not fixable in pty); needs OS-level detection (dmesg / cgroup memory.events).
 *      NOT how convoy agents run (they exec the harness = Case A), so it's a rare OS-level follow-up, not an agent gap.
 *  The `!== 0` also-dings-on-null leg is defense-in-depth for a genuine no-record death. `vanished` + (pty ≥ #72) nonzero
 *  together cover an agent OOM; only the reaped-grandchild (Case B) remains, upstream of the exit record. See PR #41. */
export function workerCrashed(status: SupervisedSession["status"], exitCode: number | null): boolean {
  return status === "vanished" || (status === "exited" && exitCode !== 0); // !== 0 dings nonzero (incl. an agent OOM = 137 via pty ≥ #72) AND a no-record null; only a reaped-grandchild OOM (Case B) escapes — OS-level follow-up
}

/** Who to ding when `crashed` crash-loops / vanishes: (a) the CoS — ALWAYS (a network-wide backstop),
 *  resolved by its `convoy.tier=cos` tag (no hardcoded id); plus (b) `crashed`'s ACTUAL supervisor — the
 *  `convoy.spawner` bus id recorded on it at `convoy add` (whoever spawned it owns it); plus any explicit
 *  `notify` ids. NOT every `--permanent` agent: permanence is long-lived-ness, NOT "orchestrator" — every
 *  repo-owner runs `--permanent`, so the old permanent-set target paged the ENTIRE standing crew on one
 *  throwaway worker crash (Nathan-flagged). The crashing agent itself is excluded (no self-ding). Targets
 *  are BUS IDENTITIES (via `resolve`, injectable for tests), deduped. Pure. */
export function crashDingTargets(
  crashed: SupervisedSession,
  sessions: readonly SupervisedSession[],
  notify: readonly string[],
  resolve: (s: SupervisedSession) => string | null,
): string[] {
  const ids = new Set<string>();
  // (a) the CoS — always, resolved by tag so it survives naming/id churn.
  for (const s of sessions) {
    if (s.tags["convoy.tier"] !== "cos") continue;
    const bid = resolve(s);
    if (bid) ids.add(bid);
  }
  // (b) the crashed agent's actual supervisor — the spawner recorded at add-time.
  const spawner = crashed.tags["convoy.spawner"];
  if (spawner) ids.add(spawner);
  // explicit extras.
  for (const n of notify) if (n) ids.add(n);
  // never self-ding.
  const crasherBusId = resolve(crashed);
  if (crasherBusId) ids.delete(crasherBusId);
  return [...ids];
}

/** Send a crash/flap ding to a recipient's inbox (best-effort; a failed ding never disturbs the reconcile loop).
 *  Uses `st message send --from convoy-up` via execFile (no shell → the body is passed literally, backtick-safe). */
const DING_SENDER = "convoy-up";
async function sendDing(root: string, to: string, subject: string, body: string): Promise<boolean> {
  try {
    // The bus lives at <net>/smalltalk (ST_ROOT), not the network dir. st requires the SENDER to have a
    // bus folder; convoy-up is a system pseudo-agent, so ensure its folder under the smalltalk root.
    const stRoot = stRootOf(root);
    mkdirSync(join(stRoot, DING_SENDER, "inbox"), { recursive: true });
    mkdirSync(join(stRoot, DING_SENDER, "archive"), { recursive: true });
    const r = await run("st", ["message", "send", to, "--from", DING_SENDER, "--subject", subject, "--priority", "high", "-m", body], {
      env: { ...process.env, ST_ROOT: stRoot },
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** up/down's network fallback: prefer CONVOY_NETWORK (the network dir, set by `convoy env`/`shell`), else
 *  legacy ambient ST_ROOT, else convoy's OWN default network (not st/pty's global ~/.local/state/smalltalk
 *  root — the ST_ROOT-unset footgun). Used only when no explicit `up/down <network>` arg is given. ST_ROOT
 *  is the BUS root (`<net>/smalltalk`), so recover the network dir via networkDirOfStRoot — else up/down
 *  would target `<net>/smalltalk` as the network and read the catalog/pty from the wrong (bus-root) subtree
 *  (the same footgun as `convoy add`; CONVOY_NETWORK usually masks it, but not when only ST_ROOT is set). */
function defaultRoot(): string {
  const cn = process.env["CONVOY_NETWORK"];
  if (cn) return cn;
  const st = process.env["ST_ROOT"];
  return st ? networkDirOfStRoot(st) : defaultConvoyNetwork();
}

/** Resolve up/down's `<network>` arg to a network DIR — a bare NAME (`default`, `my-net`) resolves under
 *  convoy's home (`<home>/<name>`), a PATH is used as-is; no arg falls back via `defaultRoot()`. Mirrors
 *  `resolveNetworkRoot` (commands.ts) but keeps the CONVOY_NETWORK fallback and lives here to avoid a
 *  commands.ts↔up.ts import cycle. It ALWAYS returns a concrete dir, so the caller can pin `PtyHost`'s
 *  PTY_ROOT to the target network's pty registry unconditionally — the fix for `up`/`down` launching into
 *  the wrong (ambient) pty registry when invoked by name or with no arg (see `up`). */
export function resolveRoot(network: string | undefined): string {
  if (network) return isNetworkName(network) ? networkDirForName(network) : network;
  return defaultRoot();
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function up(opts: UpOptions): Promise<number> {
  const root = resolveRoot(opts.network);
  const interval = opts.reconcileInterval ?? 30;
  const cliWindow = opts.fastFailWindow ?? null;
  const cliLimit = opts.fastFailLimit ?? null;
  const json = opts.json === true;
  // Pin PtyHost to the RESOLVED root (not raw opts.network) so PTY_ROOT always points at THIS network's pty
  // registry — for a bare NAME or a no-arg default alike. A null root left PTY_ROOT unpinned, so host.sessions()
  // read the ambient PTY_ROOT (a stale/foreign registry) and reconcile launched 0 against the wrong session set.
  const host = new PtyHost(root);
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
  const results = { spawned: 0, adopted: 0, failed: 0, flapping: 0, retired: 0 }; // one-shot reconcile summary (--once)
  const thisHost = shortHostname(); // the catalog host-filter key — up only launches/adopts agents whose host is us
  const notify = opts.notify ?? [];
  const dingTargets = (crashed: SupervisedSession, sessions: readonly SupervisedSession[]): string[] => crashDingTargets(crashed, sessions, notify, busIdOf);

  const tick = async (): Promise<void> => {
    const now = new Date();

    // PIECE 3 — CATALOG-DRIVEN reconcile (desired state). Read the SYNCED catalog, host-filter to THIS machine,
    // and: LAUNCH this host's active agents that aren't running yet (add now only DECLARES — up is what
    // launches), and TEAR DOWN retired agents (decommission = an edit `retired=true`, honored here). A
    // host=OTHER agent is SKIPPED — its own machine's `convoy up` launches it once the catalog syncs there
    // (the cross-machine scheduler). Gone PERMANENTS are re-launched by the session loop below (which carries
    // the flapping-cap — launching them here would bypass the crash-loop guard); non-permanents are ephemeral
    // (Nomad no-respawn). Malformed job files are skipped, never fatal.
    const { entries, errors } = readCatalog(root);
    for (const e of errors) emit({ type: "catalog_error", path: e.path, error: e.error, ts: isoString(now) }, `[convoy-up] skipping malformed agent file ${e.path}: ${e.error}`);
    const catalogSessions = await host.sessions();
    const plan = reconcilePlan(entries, catalogSessions, thisHost, busIdOf);
    const retiredBusIds = new Set<string>(entries.filter((e) => e.af.retired && (e.af.host ?? thisHost) === thisHost).map((e) => agentBusId(e.af, thisHost)));
    for (const t of plan.teardown) {
      for (const s of t.sessions) await host.kill(s.name);
      results.retired++;
      emit({ type: "retire", identity: t.entry.af.identity, sessions: t.sessions.map((s) => s.name), ts: isoString(now) }, `[convoy-up] retire ${t.entry.af.identity} — retired=true → tore down ${t.sessions.length} session(s)`);
    }
    const anySession = new Set(catalogSessions.map(busIdOf).filter((x): x is string => x !== null));
    for (const e of plan.launch) {
      if (anySession.has(agentBusId(e.af, thisHost))) continue; // has a (gone) session → the session loop respawns it with the cap
      const { spawned, failed } = await nativeLaunch(agentFileToSpec(e.af, { networkRoot: root }));
      if (spawned.length > 0) results.spawned++;
      else results.failed++;
      emit({ type: "launch", identity: e.af.identity, host: thisHost, spawned, failed, ts: isoString(now) }, `[convoy-up] launch ${e.af.identity} (host ${thisHost}) — ${spawned.length} session(s)${failed.length ? ` (${failed.length} FAILED)` : ""}`);
    }

    const sessions = await host.sessions();
    for (const s of sessions) {
      if (retiredBusIds.has(busIdOf(s) ?? "")) continue; // retired agent → don't respawn (the catalog pass tore it down)
      if (isPermanent(s)) permanentKeys.add(s.name);
      const permanent = isPermanent(s) || permanentKeys.has(s.name);

      // WORKER-CRASH: a gone NON-permanent convoy agent (a worker's HARNESS session — NOT its ding sidecar,
      // which would double-ding the same busId). convoy up does NOT respawn it — workers are ephemeral (Nomad
      // no-respawn) — but a CRASH is ding-worthy so its supervisor + cos know. Gate on the exit (workers have no
      // fast-fail loop, since they're never respawned): a nonzero exitCode or a hard `vanished` death dings; a
      // CLEAN exit (code 0 = the worker finished its task) stays SILENT (routine). Dedup: a gone worker re-appears
      // every tick, so ding ONCE. Target = cos + the worker's actual supervisor (its `convoy.spawner` tag) — see
      // crashDingTargets.
      if (!permanent && s.tags["ptyfile.session"] !== undefined && s.tags["ptyfile.session"] !== "ding") {
        if (!gone(s) || workerDinged.has(s.name)) continue;
        workerDinged.add(s.name); // mark regardless — a clean-exit worker must not be re-checked either
        if (!workerCrashed(s.status, s.exitCode)) continue; // routine clean exit (code 0) → silent
        const id = busIdOf(s) ?? logicalId(s);
        const reason = s.status === "vanished" ? "vanished (hard death — no exit record)" : s.exitCode === null ? "killed with no exit code (hard kill / OOM)" : `exit ${s.exitCode}`;
        const targets = dingTargets(s, sessions);
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

      // ADOPT-ALIVE: pty can report a session "gone" transiently (a health-check timeout during a CPU
      // spike) while its PROCESS is actually alive. NEVER respawn a live process — trying to respawn a
      // `claude --resume <id>` whose original still holds that id fails instantly, and a persistent host
      // then tight-loops on it (the cos-respawn CPU burn). Probe the pid: if alive, adopt it + skip.
      if (processAlive(s.pid)) {
        results.adopted++;
        emit(
          { type: "adopt", identity: logicalId(s), session: s.name, pid: s.pid, ts: isoString(now) },
          `[convoy-up] adopt ${logicalId(s)} session=${s.name} — reported gone but pid ${s.pid} is ALIVE; not respawning`,
        );
        continue;
      }

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
        if (ok) results.spawned++;
        else results.failed++;
        // Re-assert permanence + the counter AFTER the restart (it strips runtime tags) — for pty's
        // display + so a fresh host still recognizes this session. convoy's own store is authoritative. Also
        // re-assert the crash-ding targeting tags (convoy.tier/convoy.spawner) from the pre-respawn session, so
        // a permanent respawn (e.g. cos restarting) doesn't drop the CoS backstop / a supervisor's spawner link.
        host.setTags(s.name, {
          ...writtenTags(decision.tags),
          strategy: "permanent",
          ...(s.tags["convoy.tier"] ? { "convoy.tier": s.tags["convoy.tier"] } : {}),
          ...(s.tags["convoy.spawner"] ? { "convoy.spawner": s.tags["convoy.spawner"] } : {}),
        });
        emit(
          { type: "respawn", identity: logicalId(s), session: s.name, reason: "exited", attempt: decision.tags.consecutiveFastFails, cap: limit, ok, ts: isoString(now) },
          `[convoy-up] respawn ${logicalId(s)} session=${s.name} reason=exited attempt=${decision.tags.consecutiveFastFails}/${limit}${ok ? "" : " (spawn FAILED)"}`,
        );
        // Ding the orchestrators on a fast-fail CRASH (consecutiveFastFails ≥ 1) — the agent died fast + is being
        // respawned; gate OUT routine respawns (counter 0 = a normal/slow exit, not a crash) as noise. A ding
        // SIDECAR is still respawned above, but never generates its own crash-ding (the agent's covers it → no
        // double-ding).
        if (decision.tags.consecutiveFastFails >= 1 && s.tags["ptyfile.session"] !== "ding") {
          const id = busIdOf(s) ?? logicalId(s);
          const targets = dingTargets(s, sessions);
          const body = `Agent ${id} CRASHED (fast-fail ${decision.tags.consecutiveFastFails}/${limit}) on network ${root} — convoy up is auto-respawning it. NEEDS ATTENTION if it keeps crashing: pty peek ${s.name} to see why.`;
          for (const t of targets) await sendDing(root, t, `crash: ${id}`, body);
        }
      } else {
        results.flapping++;
        state.set(key, decision.tags);
        host.setTags(s.name, writtenTags(decision.tags)); // strategy.status=flapping for pty's badge
        const e = decision.event;
        emit(
          { session: s.name, type: "session_flapping", ts: isoString(e.ts), counter: e.counter, limit: e.limit, window: e.window },
          `[convoy-up] flapping ${logicalId(s)} session=${s.name} — parked after ${e.counter} fast fails (cap ${e.limit}/${e.window}s). \`pty tag ${s.name} --rm strategy.status\` to retry.`,
        );
        // Ding the orchestrators on a GAVE-UP (flapping) — the strongest signal: convoy up stopped respawning it.
        // This fires once (the tick that transitions to flapping; subsequent ticks `skip`), so no ding spam. A ding
        // SIDECAR is excluded (the agent's crash/flap ding covers the incident → no double-ding; independent
        // ding-health monitoring is a separate concern).
        if (s.tags["ptyfile.session"] !== "ding") {
          const id = busIdOf(s) ?? logicalId(s);
          const targets = dingTargets(s, sessions);
          const body = `Agent ${id} GAVE UP — flapping/parked after ${e.counter} fast fails (cap ${e.limit}/${e.window}s) on network ${root}. NEEDS ATTENTION: it is crash-looping and convoy up stopped respawning it. Inspect (pty peek ${s.name}), fix the cause, then clear its strategy.status to retry.`;
          for (const t of targets) await sendDing(root, t, `flapping: ${id}`, body);
        }
      }
    }
  };

  // WATCH + TIMER (Nathan): `convoy up` reconciles on a timer AND on catalog-folder changes, so a dropped or
  // edited agent file runs (or retires) IMMEDIATELY, not just at the next tick — the "declare → it runs"
  // immediacy that makes the synced folder a live scheduler. fs.watch is best-effort (some filesystems don't
  // support it); the timer is the always-on fallback. Not in --once (a single pass, no daemon).
  let catalogDirty = false;
  let watcher: FSWatcher | null = null;
  if (opts.once !== true) {
    try {
      watcher = watch(catalogDir(root), () => {
        catalogDirty = true;
      });
    } catch {
      // no watch support (or no catalog dir yet) → timer-only; a later reconcile still picks up changes.
    }
  }
  do {
    catalogDirty = false;
    await tick();
    if (opts.once === true) break;
    // Sleep the interval, but wake EARLY if the catalog changed (a new/edited/removed agent file) so it
    // reconciles right away.
    for (let left = interval * 4; left > 0 && !stop && !catalogDirty; left--) await sleep(250);
  } while (!stop);
  watcher?.close();

  // One-shot mode reports what the single reconcile pass did, then exits (no daemon) — for the shepherd
  // cron + manual healing. --json emits the structured summary (see emit); text prints the human line.
  if (opts.once === true) {
    emit(
      { type: "once_summary", network: root, spawned: results.spawned, adopted: results.adopted, failed: results.failed, flapping: results.flapping, retired: results.retired, ts: isoString(new Date()) },
      `[convoy-up] once: reconciled ${root} — launched/spawned ${results.spawned}, adopted ${results.adopted} (already alive), retired ${results.retired}, failed ${results.failed}, flapping ${results.flapping}`,
    );
  }

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
  const root = resolveRoot(opts.network);
  const host = new PtyHost(root); // pin PTY_ROOT to the resolved network — same by-name/no-arg fix as `up`
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
