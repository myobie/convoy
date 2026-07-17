// Shared path helpers. Kept dependency-light so both the CLI handlers (commands.ts) and the supervisor
// (up.ts) can import it without a heavy/circular dependency.

import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/** The per-workspace overlay directory convoy writes into a composed repo: `<workspace>/.convoy/`
 *  holds PERSONA.md, DING-BUS.md, and pty.toml — everything moved OUT of the repo root so the product
 *  repo stays pristine. The whole dir is git-excluded (`.git/info/exclude`). Shared so launch.ts (write),
 *  host.ts (read the manifest + derive the workspace from the ptyfile tag), and commands.ts (clobber
 *  guard / reload) all agree on the location. */
export const CONVOY_DIR = ".convoy";

/** convoy's HOME for all networks: `($XDG_STATE_HOME | ~/.local/state)/convoy`. Named networks live
 *  side-by-side underneath it (`<home>/<name>`). */
export function convoyHome(): string {
  return join(process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state"), "convoy");
}

/** The name of the default network when none is given. */
export const DEFAULT_NETWORK_NAME = "default";

/** The dir for a NAMED network: `<home>/<name>`. */
export function networkDirForName(name: string): string {
  return join(convoyHome(), name);
}

/** Is `value` a bare network NAME (resolves under convoy's home) vs a filesystem PATH (used as-is)?
 *  A name is a single token — starts alphanumeric, then `[A-Za-z0-9._-]`, and contains NO path
 *  separator. So `default` / `my-net` are names; `/tmp/n`, `./n`, `~/n`, `../n` are paths. */
export function isNetworkName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && !value.includes("/");
}

/** convoy's OWN default NETWORK: `<home>/default`. Used only as the last-resort fallback (an explicit
 *  network name/path, `--network`, or ambient `ST_ROOT` all still win) — so `convoy init` then
 *  `convoy up` works with zero config. Standalone `st` keeps its own `~/.local/state/smalltalk` default;
 *  this changes only how CONVOY resolves its default. */
export function defaultConvoyNetwork(): string {
  return networkDirForName(DEFAULT_NETWORK_NAME);
}

/** The on-disk layout INSIDE a network dir. `ST_ROOT` points at `smalltalk/` (the bus — SYNCED across
 *  machines), NOT the network dir itself; `pty/` (runtime, machine-local) + `worktrees/` (workspaces)
 *  are siblings OUTSIDE the sync boundary. Shared so every ST_ROOT/PTY_ROOT wiring site agrees. */
export interface NetworkLayout {
  dir: string;
  stRoot: string;
  ptyRoot: string;
  worktrees: string;
}
export function networkLayout(dir: string): NetworkLayout {
  return { dir, stRoot: join(dir, "smalltalk"), ptyRoot: join(dir, "pty"), worktrees: join(dir, "worktrees") };
}

/** The bus root (`ST_ROOT`) for a network dir: `<dir>/smalltalk`. */
export function stRootOf(dir: string): string {
  return join(dir, "smalltalk");
}

/** Recover the network DIR from an `ST_ROOT` value — the inverse of `stRootOf` for the common case. Since
 *  the folder-layout redesign, `ST_ROOT` points at the BUS root (`<net>/smalltalk`), NOT the network dir; a
 *  value whose last segment is `smalltalk` is therefore a bus root → the network dir is its parent. Anything
 *  else is taken as an already-network dir (best-effort back-compat — e.g. a test/legacy caller that set
 *  ST_ROOT to a bare dir). Callers that resolve a network dir from ambient `ST_ROOT` MUST go through this,
 *  else they footgun: `convoy add` fell back to `ST_ROOT` verbatim and wrote the catalog under
 *  `<net>/smalltalk/catalog/` — a dir the catalog sync does NOT watch — so the agent silently never synced
 *  or launched. Note a network literally named `smalltalk` still resolves correctly: its bus root is
 *  `<home>/smalltalk/smalltalk`, whose parent is the (correct) `<home>/smalltalk`. */
export function networkDirOfStRoot(stRoot: string): string {
  return basename(stRoot) === "smalltalk" ? dirname(stRoot) : stRoot;
}
