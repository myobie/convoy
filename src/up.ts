// `convoy up <network>` — the foreground host (ported from Sources/convoy/Commands/Up.swift). The
// reboot's load-bearing verb: it brings the network's permanent sessions up as its own children (TCC
// anchor) and reconciles them every interval — respawn on exit (resuming), crash-loop flapping-cap.
// Built on the NATIVE host (src/host.ts, @myobie/pty/client) + the §5 classifier (src/flapping-cap.ts).

import { homedir } from "node:os";
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
import { commandHashOf, gone, isPermanent, logicalId, PtyHost } from "./host.ts";

export interface UpOptions {
  network?: string | undefined;
  fastFailWindow?: number | undefined;
  fastFailLimit?: number | undefined;
  reconcileInterval?: number | undefined;
  json?: boolean;
  once?: boolean;
  keepSessions?: boolean;
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

  // Classifier state keyed on the pty id; permanence remembered (pty kill strips the strategy tag).
  const state = new Map<string, StrategyTags>();
  const permanentKeys = new Set<string>();
  const supervised = new Set<string>();

  const tick = async (): Promise<void> => {
    const now = new Date();
    for (const s of await host.sessions()) {
      if (isPermanent(s)) permanentKeys.add(s.name);
      if (!isPermanent(s) && !permanentKeys.has(s.name)) continue;
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
      } else {
        state.set(key, decision.tags);
        host.setTags(s.name, writtenTags(decision.tags)); // strategy.status=flapping for pty's badge
        const e = decision.event;
        emit(
          { session: s.name, type: "session_flapping", ts: isoString(e.ts), counter: e.counter, limit: e.limit, window: e.window },
          `[convoy-up] flapping ${logicalId(s)} session=${s.name} — parked after ${e.counter} fast fails (cap ${e.limit}/${e.window}s). \`pty tag ${s.name} --rm strategy.status\` to retry.`,
        );
      }
    }
  };

  do {
    await tick();
    if (opts.once === true) break;
    for (let left = interval * 4; left > 0 && !stop; left--) await sleep(250);
  } while (!stop);

  // teardown
  if (opts.keepSessions === true) {
    emit({ type: "teardown", stopped: 0, kept: supervised.size }, `[convoy-up] stopping host; leaving ${supervised.size} session(s) running (--keep-sessions).`);
  } else {
    let stopped = 0;
    for (const name of supervised) if (await host.kill(name)) stopped++;
    emit({ type: "teardown", stopped }, `[convoy-up] stopped host; tore down ${stopped} session(s).`);
  }
  lock.release();
  return 0;
}
