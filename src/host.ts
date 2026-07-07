// The pty host, native. Where the Swift PtyHost shelled `pty list/tag/restart/kill` and parsed JSON,
// the TS port drives `@myobie/pty/client` directly — the same lib pty's own TUIs consume. Typed
// SessionMetadata (tags, exitedAt, command/args) instead of a JSON re-parse; `spawnDaemon` for respawn
// instead of `pty restart` (the spec §5.3 respawn primitive); `updateTags` for the strategy tags.

import { basename, dirname } from "node:path";
import {
  isGone,
  listSessions,
  spawnDaemon,
  updateTags,
  type SessionInfo,
} from "@myobie/pty/client";
import { commandFingerprint, parseStrategyTags, type StrategyTags } from "./flapping-cap.ts";

/** One session as convoy's host sees it, projected from pty's typed `SessionInfo` + `SessionMetadata`. */
export interface SupervisedSession {
  name: string; // pty id (stable across respawn; survives kill)
  cwd: string | null;
  command: string;
  args: string[];
  status: SessionInfo["status"];
  exitedAt: Date | null;
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

  /** Respawn a gone session IN PLACE via `spawnDaemon` with its stored metadata — the native
   *  equivalent of the Swift `pty restart -y` seam, and exactly the spec §5.3 respawn primitive. */
  async respawn(s: SupervisedSession): Promise<boolean> {
    try {
      await spawnDaemon({
        name: s.name,
        command: s.command,
        args: s.args,
        displayCommand: s.command,
        cwd: s.cwd ?? undefined,
        tags: { ...s.tags, strategy: "permanent" }, // re-assert permanence (kill strips it)
      });
      return true;
    } catch {
      return false;
    }
  }
}
