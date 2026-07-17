// Shared path helpers. Kept dependency-light so both the CLI handlers (commands.ts) and the supervisor
// (up.ts) can import it without a heavy/circular dependency.

import { homedir } from "node:os";
import { join } from "node:path";

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
