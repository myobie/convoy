// The pty host, native. Where the Swift PtyHost shelled `pty list/tag/restart/kill` and parsed JSON,
// the TS port drives `@compoundingtech/pty/client` directly — the same lib pty's own TUIs consume. Typed
// SessionMetadata (tags, exitedAt, command/args) instead of a JSON re-parse; `spawnDaemon` for respawn
// instead of `pty restart` (the spec §5.3 respawn primitive); `updateTags` for the strategy tags.

import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  cleanupAll,
  isGone,
  listSessions,
  readPtyFile,
  spawnDaemon,
  updateTags,
  type PtySessionDef,
  type SessionInfo,
} from "@compoundingtech/pty/client";
import { commandFingerprint, parseStrategyTags, type StrategyTags } from "./flapping-cap.ts";
import { CONVOY_DIR, stRootOf } from "./paths.ts";
import { childEnv, run } from "./exec.ts";

function cleanEnv(overlay: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(childEnv(overlay))) if (v !== undefined) out[k] = v;
  return out;
}

/** Spawn the sessions declared in `<dir>/pty.toml` natively via `spawnDaemon` — convoy owns the
 *  spawn (the port's launch-absorb). `st launch` writes the wiring (pty.toml/persona) but its OWN
 *  pty registration is a no-op post-cutover, so convoy does the spawn itself: reads the manifest
 *  (readPtyFile), then spawnDaemon each session with the enriched PATH + the session's env, tagging
 *  the ptyfile pair so `convoy up` recognizes + hosts it. */
export async function spawnFromPtyFile(dir: string, root: string | null): Promise<{ spawned: string[]; failed: string[] }> {
  if (root) process.env["PTY_ROOT"] = `${root}/pty`;
  // The manifest lives in the workspace's .convoy/ overlay; the SESSIONS still run in the workspace
  // (cwd: dir, via spawnManifestSession), which decouples the manifest location from the working dir.
  const file = readPtyFile(join(dir, CONVOY_DIR));
  const spawned: string[] = [];
  const failed: string[] = [];
  for (const def of file.sessions) {
    try {
      spawned.push(await spawnManifestSession(dir, def, root));
    } catch {
      failed.push(def.shortName);
    }
  }
  return { spawned, failed };
}

/** Spawn ONE session def from a pty.toml manifest via `spawnDaemon` — the port's launch-absorb, per session.
 *  Shared by `spawnFromPtyFile` (bring up the whole manifest) and the reconcile respawn / ding-health
 *  recovery (replay a single session). Bakes the durable ST_ROOT/PTY_ROOT so a replay never loses the network
 *  pin; the session's own env (incl. ST_AGENT) rides in `def.env`. `workspace` is the session cwd (the manifest
 *  lives in `<workspace>/.convoy/`). Returns the spawned session name. Does NOT free a stale record — a REPLAY
 *  caller `freeSession()`s the id first (see `respawn` / the ding-health pass); a fresh bring-up has no record. */
export async function spawnManifestSession(workspace: string, def: PtySessionDef, root: string | null): Promise<string> {
  const tomlPath = join(workspace, CONVOY_DIR, "pty.toml");
  const name = def.id ?? `${def.shortName}-${randomBytes(3).toString("hex")}`;
  const tags: Record<string, string> = { ...(def.tags ?? {}), ptyfile: tomlPath, "ptyfile.session": def.shortName };
  const env = cleanEnv({ ...process.env, ...(def.env ?? {}), ...(root ? { ST_ROOT: stRootOf(root), PTY_ROOT: `${root}/pty` } : {}) });
  await spawnDaemon({ name, command: "sh", args: ["-c", def.command], displayCommand: def.command, cwd: workspace, displayName: def.displayName, tags, env });
  return name;
}

/** Read a single session def (by its toml key / `shortName`) from the pty.toml at `ptyfile` — the
 *  `<workspace>/.convoy/pty.toml` path stored in a session's `ptyfile` tag. The manifest is the source of
 *  truth for the verbatim command + durable env, so a respawn REPLAYS it rather than reconstructing from
 *  live pty metadata (which dropped the `sh -c "exec claude …"` wrapper and came back a bare shell — the
 *  capstone LOOP-CLOSED regression). Returns null if the file/def is unreadable or absent. */
export function readManifestDef(ptyfile: string, shortName: string): PtySessionDef | null {
  try {
    const file = readPtyFile(dirname(ptyfile)); // ptyfile is <ws>/.convoy/pty.toml; readPtyFile takes the dir
    return file.sessions.find((d) => d.shortName === shortName) ?? null;
  } catch {
    return null;
  }
}

/** Free a session's on-disk record + socket (pty's `cleanupAll`) so its stable id can be re-spawned cleanly.
 *  Called before a manifest REPLAY drops the stale (gone) record. Safe on a non-existent name (no-op). */
export function freeSession(name: string): void {
  cleanupAll(name);
}

/** One session as convoy's host sees it, projected from pty's typed `SessionInfo` + `SessionMetadata`. */
export interface SupervisedSession {
  name: string; // pty id (stable across respawn; survives kill)
  cwd: string | null;
  command: string;
  args: string[];
  status: SessionInfo["status"];
  pid: number | null; // the session's process pid (for the adopt-alive liveness probe)
  exitedAt: Date | null;
  exitCode: number | null; // the process exit code when the daemon wrote an exit record (null if none / vanished)
  tags: Record<string, string>;
}

export function toSupervised(i: SessionInfo): SupervisedSession {
  const m = i.metadata;
  return {
    name: i.name,
    cwd: m?.cwd ?? null,
    command: m?.command ?? "",
    args: m?.args ?? [],
    status: i.status,
    pid: i.pid,
    exitedAt: m?.exitedAt ? new Date(m.exitedAt) : null,
    exitCode: typeof m?.exitCode === "number" ? m.exitCode : null,
    tags: m?.tags ?? {},
  };
}

/** Is a process with `pid` actually alive? `process.kill(pid, 0)` probes existence WITHOUT signalling:
 *  it succeeds → alive; throws ESRCH → dead; throws EPERM → alive but not ours (still alive). Used by the
 *  adopt-alive guard so convoy never tries to respawn a session whose process is still running. */
export function processAlive(pid: number | null): boolean {
  if (pid === null || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists but owned by another user → alive
  }
}

export function strategyOf(s: SupervisedSession): StrategyTags {
  return parseStrategyTags(s.tags);
}

/** Permanence per the DECLARED session (the `strategy` tag) — note `pty kill` strips it, so convoy up
 *  also remembers it (see the reconcile loop). */
export function isPermanent(s: SupervisedSession): boolean {
  return s.tags["strategy"] === "permanent";
}

/** Gone = exited or vanished (no live daemon). Uses pty's own `isGone` semantics. */
export function gone(s: SupervisedSession): boolean {
  return isGone(s.status);
}

/** The 16-hex fingerprint of the declared command (for the flapping-cap command-change reset). */
export function commandHashOf(s: SupervisedSession): string {
  return commandFingerprint(s.command, s.args);
}

/** The workspace dir a ptyfile tag points into: `<workspace>/.convoy/pty.toml` → `<workspace>` (strip
 *  the overlay segment). Tolerates a bare `<workspace>/pty.toml` too. */
export function workspaceOfPtyfile(ptyfile: string): string {
  const d = dirname(ptyfile);
  return basename(d) === CONVOY_DIR ? dirname(d) : d;
}

/** The workspace whose MANIFEST owns this session — `<workspace>` recovered from its `ptyfile` tag. Null
 *  when the session carries no manifest (e.g. a hand-spawned permanent session convoy never launched):
 *  there is no launch spec to replay, so recovery falls back to the in-place restart. Sessions sharing a
 *  workspace are LIMBS OF ONE AGENT — this is the key recovery groups on, so a provider and its ding
 *  sidecar are replayed together exactly once. */
export function manifestWorkspace(s: SupervisedSession): string | null {
  const pf = s.tags["ptyfile"];
  return pf ? workspaceOfPtyfile(pf) : null;
}

/** The manifest session key that names the DING SIDECAR limb — the subordinate watcher, as opposed to the
 *  PROVIDER limb that actually runs the harness (`claude` / `codex`). */
export const DING_SESSION_KEY = "ding";

/** Is this session an agent's ding SIDECAR rather than its provider? The two limbs are not peers, and
 *  recovery must not treat them as such: the provider IS the agent (it holds the conversation and the
 *  in-progress work), while the sidecar is a replaceable watcher bound to it. A sidecar's death says
 *  nothing about the provider's health, so it is never grounds for tearing the provider down. */
export function isSidecarLimb(s: SupervisedSession): boolean {
  return s.tags["ptyfile.session"] === DING_SESSION_KEY;
}

/** Is the PROVIDER limb of `workspace`'s agent still standing? Recovery's routing question: a dead sidecar
 *  next to a live provider is a sidecar-scale problem (restart the sidecar alone), whereas a dead sidecar
 *  next to a dead provider is agent-scale (replay the whole manifest). Uses the same adopt-alive liveness
 *  reading as everywhere else — reported-gone but pid-alive still counts as ALIVE. */
export function providerAlive(workspace: string, sessions: readonly SupervisedSession[]): boolean {
  return sessions.some((s) => manifestWorkspace(s) === workspace && !isSidecarLimb(s) && (!gone(s) || processAlive(s.pid)));
}

/** A stable, human-readable logical id — `<agent-dir>/<session-key>` (e.g. `convoy/claude`) from the
 *  persistent ptyfile tags; survives respawns + `pty kill`. Falls back to the pty id. */
export function logicalId(s: SupervisedSession): string {
  const session = s.tags["ptyfile.session"];
  if (!session) return s.name;
  const ptyfile = s.tags["ptyfile"];
  // ptyfile is `<workspace>/.convoy/pty.toml` — strip the `.convoy` segment so the logical id names the
  // WORKSPACE, not the overlay dir (basename(dirname()) alone would yield ".convoy" for every agent).
  const dir = ptyfile ? basename(workspaceOfPtyfile(ptyfile)) : s.cwd ? basename(s.cwd) : "";
  return dir ? `${dir}/${session}` : session;
}

/** The two effects `replayManifest` sequences — stopping a live limb, and cold-booting the manifest.
 *  Injectable so replay's ORDERING and error handling can be asserted without spawning real processes. */
export interface ReplayIO {
  kill: (name: string) => Promise<boolean>;
  spawn: (workspace: string) => Promise<{ spawned: string[]; failed: string[] }>;
}

/** Drives pty natively via `@compoundingtech/pty/client`. `root` pins the network's `PTY_ROOT`. */
export class PtyHost {
  readonly root: string | null;

  constructor(root: string | null) {
    this.root = root;
    // The client reads PTY_ROOT from the environment; pin the network for this host process.
    if (root) process.env["PTY_ROOT"] = `${root}/pty`;
  }

  async sessions(): Promise<SupervisedSession[]> {
    return (await listSessions()).map(toSupervised);
  }

  async permanentSessions(): Promise<SupervisedSession[]> {
    return (await this.sessions()).filter(isPermanent);
  }

  /** Write `strategy.*` bookkeeping tags (spec §5.3: persist before respawn). */
  setTags(name: string, kv: Record<string, string>): void {
    if (Object.keys(kv).length > 0) updateTags(name, kv);
  }

  removeTag(name: string, key: string): void {
    updateTags(name, {}, [key]);
  }

  /** Respawn a gone session by REPLAYING its pty.toml manifest via `spawnDaemon` — NOT `pty restart`.
   *  `pty restart` is unusable for a headless supervisor (VERIFIED): pty's stateful-agent guard makes it
   *  `exit 1` on a `role=agent` session unless `--force` (so a dead permanent AGENT was never respawned —
   *  reconcile only bumped `failed`; the root of issue #82), and it otherwise tries to ATTACH after the
   *  respawn, which HANGS a non-TTY host. Replaying the manifest re-runs the verbatim stored command with
   *  the durable ST_ROOT/PTY_ROOT env — the primitive `convoy reload`/`spawnFromPtyFile` already use and
   *  that convoy-rust independently adopted (pty rm + pty up). `freeSession` drops the stale (gone) record so
   *  the stable id re-spawns cleanly. Returns false if the manifest/def can't be resolved or the spawn throws
   *  (honest failure the caller surfaces — better than the old silent `pty restart` no-op). */
  async respawn(s: SupervisedSession): Promise<boolean> {
    const ptyfile = s.tags["ptyfile"];
    const sessionKey = s.tags["ptyfile.session"];
    if (!ptyfile || !sessionKey) return false; // not a convoy manifest session — nothing to replay
    const def = readManifestDef(ptyfile, sessionKey);
    if (!def) return false;
    try {
      freeSession(s.name); // free the stale record + socket before re-spawning the same stable id
      await spawnManifestSession(workspaceOfPtyfile(ptyfile), def, this.root);
      return true;
    } catch {
      return false;
    }
  }

  /** Stop a session (teardown). Residual `pty kill` shell — the client doesn't export a daemon-kill;
   *  PTY_ROOT is already pinned in the process env by the constructor. */
  async kill(name: string): Promise<boolean> {
    return (await run("pty", ["kill", name])).ok;
  }

  /** REPLAY an agent's manifest — the recovery primitive (convoy#82). `respawn` above cannot serve this
   *  case, for two independent reasons found by reproducing a provider death:
   *
   *    1. `pty restart` REFUSES agent-shaped sessions. pty's stateful-agent guard rejects any session
   *       tagged `role=agent` unless `--force`, and its own message points the operator at the
   *       supervisor: "Cycle it through its supervisor (e.g. `convoy up`) instead." convoy up's respawn
   *       WAS `pty restart -y`, so the two sides deadlocked — pty deferred to convoy, convoy called the
   *       refused command, and every permanent agent respawn failed. The guard is RIGHT (blindly
   *       re-running stored argv can wedge a `claude --resume`); convoy was using the wrong primitive.
   *    2. After a HARD death there is no daemon left to restart at all — nothing to `restart` onto.
   *
   *  Replay is what the guard defers to: not a blind argv re-run, but a fresh COLD BOOT from
   *  `.convoy/pty.toml` — the launch spec. It re-reads the manifest and spawns the agent's whole limb set
   *  from it, so the agent comes back running its declared boot ritual with no conversation pinned.
   *
   *  ALL limbs are relaunched together, and surviving ones are killed FIRST. The manifest pins stable
   *  session ids (`<prefix>` / `<prefix>.ding`), so spawning over a live sidecar would collide on that id;
   *  worse, a reused sidecar stays bound to the provider that just died. Tearing both down and replaying
   *  the manifest is the only state that is simple to reason about: whatever the manifest says, is what
   *  runs. */
  async replayManifest(
    workspace: string,
    survivors: readonly SupervisedSession[],
    // The two EFFECTS this method sequences, injected so the sequencing itself is testable. Everything
    // that makes replay correct is ordering and result-propagation — kill before spawn, never the
    // reverse; a throw becomes a reported failure, not an exception escaping into the reconcile loop —
    // and none of that is observable without a seam. The defaults bind the real pty operations, so every
    // caller is unchanged; only tests pass this third argument.
    io: ReplayIO = { kill: (n) => this.kill(n), spawn: (w) => spawnFromPtyFile(w, this.root) },
  ): Promise<{ spawned: string[]; failed: string[] }> {
    for (const s of survivors) await io.kill(s.name);
    try {
      return await io.spawn(workspace);
    } catch {
      return { spawned: [], failed: ["<manifest unreadable>"] }; // a missing/corrupt pty.toml is a failed attempt, not a crash
    }
  }
}
