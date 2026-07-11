// The pty host, native. Where the Swift PtyHost shelled `pty list/tag/restart/kill` and parsed JSON,
// the TS port drives `@myobie/pty/client` directly — the same lib pty's own TUIs consume. Typed
// SessionMetadata (tags, exitedAt, command/args) instead of a JSON re-parse; `spawnDaemon` for respawn
// instead of `pty restart` (the spec §5.3 respawn primitive); `updateTags` for the strategy tags.

import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  isGone,
  listSessions,
  readPtyFile,
  spawnDaemon,
  updateTags,
  type SessionInfo,
} from "@myobie/pty/client";
import { commandFingerprint, parseStrategyTags, type StrategyTags } from "./flapping-cap.ts";
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
  const file = readPtyFile(dir);
  const tomlPath = join(dir, "pty.toml");
  const spawned: string[] = [];
  const failed: string[] = [];
  for (const def of file.sessions) {
    const name = def.id ?? `${def.shortName}-${randomBytes(3).toString("hex")}`;
    const tags: Record<string, string> = { ...(def.tags ?? {}), ptyfile: tomlPath, "ptyfile.session": def.shortName };
    const env = cleanEnv({ ...process.env, ...(def.env ?? {}), ...(root ? { ST_ROOT: root, PTY_ROOT: `${root}/pty` } : {}) });
    try {
      await spawnDaemon({ name, command: "sh", args: ["-c", def.command], displayCommand: def.command, cwd: dir, displayName: def.displayName, tags, env });
      spawned.push(name);
    } catch {
      failed.push(def.shortName);
    }
  }
  return { spawned, failed };
}

/** One session as convoy's host sees it, projected from pty's typed `SessionInfo` + `SessionMetadata`. */
export interface SupervisedSession {
  name: string; // pty id (stable across respawn; survives kill)
  cwd: string | null;
  command: string;
  args: string[];
  status: SessionInfo["status"];
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
    exitedAt: m?.exitedAt ? new Date(m.exitedAt) : null,
    exitCode: typeof m?.exitCode === "number" ? m.exitCode : null,
    tags: m?.tags ?? {},
  };
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

/** A stable, human-readable logical id — `<agent-dir>/<session-key>` (e.g. `convoy/claude`) from the
 *  persistent ptyfile tags; survives respawns + `pty kill`. Falls back to the pty id. */
export function logicalId(s: SupervisedSession): string {
  const session = s.tags["ptyfile.session"];
  if (!session) return s.name;
  const ptyfile = s.tags["ptyfile"];
  const dir = ptyfile ? basename(dirname(ptyfile)) : s.cwd ? basename(s.cwd) : "";
  return dir ? `${dir}/${session}` : session;
}

/** Drives pty natively via `@myobie/pty/client`. `root` pins the network's `PTY_ROOT`. */
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

  /** Respawn a gone session IN PLACE via `pty restart -y <name>` — SIGTERM + respawn using the STORED
   *  metadata.command, which PRESERVES the agent's real command verbatim (pty-claude's guidance).
   *  Reconstructing it via `spawnDaemon(command, args)` loses it — an agent's `sh -c "… exec claude …"`
   *  came back a bare shell, failing the capstone's LOOP-CLOSED gate. PTY_ROOT is pinned in the process
   *  env by the constructor, so the CLI targets the right registry. */
  async respawn(s: SupervisedSession): Promise<boolean> {
    return (await run("pty", ["restart", "-y", s.name])).ok;
  }

  /** Stop a session (teardown). Residual `pty kill` shell — the client doesn't export a daemon-kill;
   *  PTY_ROOT is already pinned in the process env by the constructor. */
  async kill(name: string): Promise<boolean> {
    return (await run("pty", ["kill", name])).ok;
  }
}
