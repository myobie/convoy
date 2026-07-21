// The flapping-cap classifier — convoy's respawn supervisor, implementing pty's lean-core
// supervision spec §5 verbatim. Ported 1:1 from Sources/ConvoyKit/FlappingCap.swift (the Swift build
// validated it live). Pure functions over the session's `strategy.*` tag state — no I/O, no clock —
// so every branch is unit-testable and the contract is independent of how convoy talks to pty.
//
// Wire-formats are FROZEN (spec §8.1): convoy's writer must match pty's reader byte-for-byte.

import { createHash } from "node:crypto";

export const FLAPPING_STATUS = "flapping";
export const DEFAULT_WINDOW_SECONDS = 60;
export const DEFAULT_LIMIT = 3;

// Tag keys (spec §8.1).
export const TAG = {
  consecutive: "strategy.consecutive-fast-fails",
  lastRespawn: "strategy.last-respawn-at",
  commandHash: "strategy.command-hash",
  status: "strategy.status",
  window: "strategy.fast-fail-window",
  limit: "strategy.fast-fail-limit",
} as const;

/** The `strategy.*` tag state shared with pty as the on-disk supervision contract. */
export interface StrategyTags {
  consecutiveFastFails: number;
  lastRespawnAt: Date | null;
  commandHash: string | null;
  status: string | null;
  fastFailWindowOverride: number | null;
  fastFailLimitOverride: number | null;
}

export function emptyStrategyTags(): StrategyTags {
  return {
    consecutiveFastFails: 0,
    lastRespawnAt: null,
    commandHash: null,
    status: null,
    fastFailWindowOverride: null,
    fastFailLimitOverride: null,
  };
}

export function isFlapping(t: StrategyTags): boolean {
  return t.status === FLAPPING_STATUS;
}

// ISO 8601 UTC with millisecond fraction + `Z` — the `new Date(ms).toISOString()` shape (spec §8.1).
export function isoString(d: Date): string {
  return d.toISOString();
}
export function isoDate(s: string): Date | null {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * `strategy.command-hash` — the 16-char lowercase-hex SHA-256 prefix of `<command>\0<args joined by
 * \0>`. Reproduces pty's helper verbatim: `sha256(command + "\0" + args.join("\0")).slice(0, 16)`.
 */
export function commandFingerprint(command: string, args: string[]): string {
  const joined = command + "\0" + args.join("\0");
  return createHash("sha256").update(joined).digest("hex").slice(0, 16);
}

// Effective thresholds (spec §5.2 — per-session tag > CLI global > default).
export function effectiveWindow(tag: number | null, cliGlobal: number | null | undefined): number {
  return tag ?? cliGlobal ?? DEFAULT_WINDOW_SECONDS;
}
export function effectiveLimit(tag: number | null, cliGlobal: number | null | undefined): number {
  return tag ?? cliGlobal ?? DEFAULT_LIMIT;
}

/** Parse the `strategy.*` subset out of a session's full tag map. Tolerant: bad ints/dates → absent. */
export function parseStrategyTags(tags: Record<string, string>): StrategyTags {
  const int = (v: string | undefined): number | null => {
    if (v === undefined) return null;
    const n = Number.parseInt(v, 10);
    return Number.isNaN(n) ? null : n;
  };
  const last = tags[TAG.lastRespawn];
  return {
    consecutiveFastFails: int(tags[TAG.consecutive]) ?? 0,
    lastRespawnAt: last ? isoDate(last) : null,
    commandHash: tags[TAG.commandHash] ?? null,
    status: tags[TAG.status] ?? null,
    fastFailWindowOverride: int(tags[TAG.window]),
    fastFailLimitOverride: int(tags[TAG.limit]),
  };
}

/** The classifier-owned `strategy.*` tags to WRITE for this state (frozen wire-format §8.1). */
export function writtenTags(t: StrategyTags): Record<string, string> {
  const out: Record<string, string> = { [TAG.consecutive]: String(t.consecutiveFastFails) };
  if (t.commandHash) out[TAG.commandHash] = t.commandHash;
  if (t.lastRespawnAt) out[TAG.lastRespawn] = isoString(t.lastRespawnAt);
  if (t.status) out[TAG.status] = t.status;
  return out;
}

/** The `session_flapping` event payload (spec §5.4 / §8.1). */
export interface FlappingEvent {
  session: string;
  type: "session_flapping";
  ts: Date;
  counter: number;
  limit: number;
  window: number;
}

/** The decision for one permanent-and-gone session on one reconcile tick. */
export type Decision =
  | { kind: "skip" }
  | { kind: "respawn"; tags: StrategyTags }
  | { kind: "flap"; tags: StrategyTags; event: FlappingEvent };

/**
 * Classify a recovery ATTEMPT THAT NEVER PRODUCED A LEAF — the spawn itself failed (convoy#82).
 *
 * `classify` below infers a fast fail from the leaf's own exit record: `exitedAt - lastRespawnAt < window`.
 * That inference is structurally BLIND when the spawn never happened, and the blindness is not theoretical
 * — it is what the convoy#82 reproduction actually showed. With respawn failing every tick, no NEW exit
 * record was ever written, so `exitedAt` stayed pinned at the original death, which is EARLIER than
 * `lastRespawnAt`; the interval went negative, `wasFastFail` stayed false, and the counter sat at `0/3`
 * across unbounded reconcile cycles. The cap never engaged, the agent never parked, and — because the
 * fast-fail ding gates on `consecutiveFastFails >= 1` — no one was ever told. A silent infinite retry.
 *
 * So a failed ATTEMPT is counted directly, on the attempt itself rather than on a leaf that does not
 * exist. An agent whose manifest cannot spawn at all now parks under the SAME cap as one that spawns and
 * dies fast, which is the honest reading: both are "convoy tried, convoy could not keep it up."
 * Deliberately reuses the existing cap rather than adding a second give-up mechanism — one counter, one
 * threshold, one operator gesture (`--rm strategy.status`) to clear either.
 */
export function classifyFailedAttempt(input: {
  session: string;
  tags: StrategyTags;
  currentHash: string;
  window: number;
  limit: number;
  now: Date;
}): Exclude<Decision, { kind: "skip" }> {
  // Never `skip`: a failed attempt always either retries or parks — the caller relies on that to
  // unconditionally persist the updated counter, which is what makes the cap actually advance.
  const { session, tags, currentHash, window, limit, now } = input;
  const nextCounter = tags.consecutiveFastFails + 1;
  if (nextCounter >= limit) {
    const flapped: StrategyTags = { ...tags, status: FLAPPING_STATUS, consecutiveFastFails: nextCounter, commandHash: currentHash };
    return { kind: "flap", tags: flapped, event: { session, type: "session_flapping", ts: now, counter: nextCounter, limit, window } };
  }
  return { kind: "respawn", tags: { ...tags, lastRespawnAt: now, consecutiveFastFails: nextCounter, commandHash: currentHash, status: null } };
}

/** Classify one permanent-and-gone session (spec §5.3). Pure: same inputs → same decision. */
export function classify(input: {
  session: string;
  exitedAt: Date | null;
  tags: StrategyTags;
  currentHash: string;
  window: number;
  limit: number;
  now: Date;
}): Decision {
  const { session, exitedAt, tags, currentHash, window, limit, now } = input;

  // A stored hash that differs ⇒ the operator edited the command. (No stored hash ⇒ first respawn.)
  const commandChanged = tags.commandHash !== null && tags.commandHash !== currentHash;

  if (isFlapping(tags) && !commandChanged) return { kind: "skip" };

  // Was the just-exited leaf a fast fail? Unknown exit time or no prior stamp ⇒ not fast.
  let wasFastFail = false;
  if (exitedAt && tags.lastRespawnAt) {
    const liveMs = exitedAt.getTime() - tags.lastRespawnAt.getTime();
    wasFastFail = liveMs >= 0 && liveMs < window * 1000;
  }

  const nextCounter = commandChanged ? 0 : wasFastFail ? tags.consecutiveFastFails + 1 : 0;

  if (nextCounter >= limit) {
    const flapped: StrategyTags = {
      ...tags,
      status: FLAPPING_STATUS,
      consecutiveFastFails: nextCounter,
      commandHash: currentHash,
      // preserve lastRespawnAt: it dates the last attempt, not this (skipped) one.
    };
    const event: FlappingEvent = { session, type: "session_flapping", ts: now, counter: nextCounter, limit, window };
    return { kind: "flap", tags: flapped, event };
  }

  const respawned: StrategyTags = {
    ...tags,
    lastRespawnAt: now,
    consecutiveFastFails: nextCounter,
    commandHash: currentHash,
    status: null, // this branch never flaps
  };
  return { kind: "respawn", tags: respawned };
}
