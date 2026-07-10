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
  return pretrustDirs([dir]).failed.length === 0;
}

/** The canonical path Claude Code looks a folder up by: its realpath (resolves symlinks like `/tmp`→
 *  `/private/tmp`, home symlinks). Falls back to a plain absolute resolve if the dir isn't on disk yet
 *  (keying on the literal path then, which may still mismatch Claude's realpath lookup — so pre-trust a dir
 *  that already exists). */
function trustKey(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return resolve(dir);
  }
}

/** BATCH pre-trust: mark every `dir` trusted in one atomic read-modify-write of the config (`~/.claude.json`,
 *  or `<configDir>/.claude.json` when the agents will run under `CLAUDE_CONFIG_DIR=<configDir>`). This is the
 *  ONLY robust fix for the rapid-multi-spawn trust RACE: convoy's per-add pre-trust can't win it (agent N's
 *  booting Claude reads the config before agent N+1's entry exists, then flushes its stale copy and clobbers
 *  it — an ordering the per-add write can't beat), so every dir's entry must be present BEFORE any of those
 *  Claudes boot. `convoy up` (all members) and `convoy pretrust <dirs>` (any caller) both go through here, so
 *  the two layers share the identical write. Idempotent + atomic (temp+rename). Best-effort: a dir whose
 *  entry can't be written lands in `failed` (the whole batch fails together on a read/write error). */
export function pretrustDirs(dirs: string[], configDir?: string): { trusted: string[]; failed: string[] } {
  const path = configDir ? `${resolve(configDir)}/.claude.json` : claudeConfigPath();
  try {
    const config: { projects?: Record<string, Record<string, unknown>> } = existsSync(path)
      ? JSON.parse(readFileSync(path, "utf8"))
      : {};
    const projects = config.projects ?? (config.projects = {});
    const trusted: string[] = [];
    for (const dir of dirs) {
      const abs = trustKey(dir);
      const entry = projects[abs] ?? (projects[abs] = {});
      entry["hasTrustDialogAccepted"] = true;
      entry["hasCompletedProjectOnboarding"] = true;
      trusted.push(abs);
    }
    const tmp = `${path}.convoy-${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(config, null, 2));
    renameSync(tmp, path);
    return { trusted, failed: [] };
  } catch {
    return { trusted: [], failed: dirs };
  }
}
