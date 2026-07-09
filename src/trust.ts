// Pre-trust an agent's repo folder in Claude Code's config so a freshly-spawned agent never hits the
// "do you trust this folder?" workspace-trust dialog. Since the launch command is now a clean cold-start
// (no auto-poker — #17), nothing clears that dialog, so a fresh cos would sit OFFLINE waiting on it.
// convoy owns agent bootstrap, so it owns pre-trust: mark the folder `hasTrustDialogAccepted` in
// `~/.claude.json` before spawn. Deterministic, hands-off.

import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

/** Path to Claude Code's per-user config (honors $HOME so it's test-isolable). */
export function claudeConfigPath(): string {
  return `${process.env["HOME"] ?? homedir()}/.claude.json`;
}

/** Mark `dir` trusted in `~/.claude.json` so Claude Code doesn't prompt on launch. Keys the entry on the
 *  REAL path (`realpathSync` — resolves symlinks like `/tmp`→`/private/tmp` on macOS, home symlinks, etc.)
 *  because that's the canonical path Claude Code looks up; keying on the literal path would mismatch and it
 *  would still prompt. Merges into any existing project entry and writes atomically (temp + rename) to
 *  shrink the window for clobbering a concurrent Claude write. Best-effort: returns false (never throws) if
 *  the config can't be read/written — a launch must not fail because the trust pre-write hiccuped. Returns
 *  true when the folder is trusted (written now, or already was). */
export function pretrustDir(dir: string): boolean {
  let abs: string;
  try {
    abs = realpathSync(dir); // canonical path Claude checks (resolves symlinks); needs dir to exist
  } catch {
    abs = resolve(dir); // not on disk yet — fall back to the plain absolute path
  }
  const path = claudeConfigPath();
  try {
    const config: { projects?: Record<string, Record<string, unknown>> } = existsSync(path)
      ? JSON.parse(readFileSync(path, "utf8"))
      : {};
    const projects = config.projects ?? (config.projects = {});
    const entry = projects[abs] ?? (projects[abs] = {});
    if (entry["hasTrustDialogAccepted"] === true && entry["hasCompletedProjectOnboarding"] === true) {
      return true; // already trusted — nothing to write
    }
    entry["hasTrustDialogAccepted"] = true;
    entry["hasCompletedProjectOnboarding"] = true;
    const tmp = `${path}.convoy-${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(config, null, 2));
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}
