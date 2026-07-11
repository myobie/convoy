// `convoy install-cli` — put the three CLIs (convoy, st, pty) on PATH RELIABLY, without the `npm link` footgun
// (a global `npm link` polluted the shared @myobie/pty symlink and silently killed ding delivery network-wide).
// It symlinks each tool's repo bin into a writable PATH dir (default ~/.local/bin), idempotently, then verifies.
// The tools live in sibling repos (convoy + smalltalk + pty cloned side by side), so the sources resolve
// relative to the convoy clone. Pure node fs (portable macOS + Linux); the command layer prints the outcome.

import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

export type Tool = "convoy" | "st" | "pty";
export const TOOLS: readonly Tool[] = ["convoy", "st", "pty"];

/** The three tool bin sources, resolved relative to the convoy repo root: convoy ships its own `bin/convoy`;
 *  `st` + `pty` come from the sibling `smalltalk` + `pty` clones (the documented side-by-side layout). */
export function toolSources(convoyRoot: string): Record<Tool, string> {
  const siblings = dirname(convoyRoot);
  return {
    convoy: join(convoyRoot, "bin", "convoy"),
    st: join(siblings, "smalltalk", "bin", "st"),
    pty: join(siblings, "pty", "bin", "pty"),
  };
}

/** Default install dir: `$CONVOY_BIN_DIR`, else `~/.local/bin` (honors $HOME so it's test-isolable). */
export function defaultBinDir(env: NodeJS.ProcessEnv = process.env): string {
  return env["CONVOY_BIN_DIR"] || join(env["HOME"] ?? homedir(), ".local", "bin");
}

/** Is `dir` an entry on `$PATH`? (exact segment match — the way the shell resolves commands.) */
export function dirOnPath(dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return (env["PATH"] ?? "").split(delimiter).filter(Boolean).includes(dir);
}

/** The shell-specific line to put `dir` on PATH — chosen from `$SHELL` (never assume zsh). */
export function pathHint(dir: string, env: NodeJS.ProcessEnv = process.env): string {
  const shell = (env["SHELL"] ?? "").toLowerCase();
  if (shell.includes("fish")) return `fish_add_path ${dir}`;
  if (shell.includes("zsh")) return `echo 'export PATH="${dir}:$PATH"' >> ~/.zshrc  # then restart your shell`;
  if (shell.includes("bash")) return `echo 'export PATH="${dir}:$PATH"' >> ~/.bashrc  # then restart your shell`;
  return `add ${dir} to your PATH (e.g. 'export PATH="${dir}:$PATH"' in your shell's rc file), then restart your shell`;
}

export interface InstallResult {
  binDir: string;
  linked: Tool[]; // symlinked now, or already correctly linked
  missingSources: { tool: Tool; source: string }[]; // source repo/bin not found (e.g. sibling not cloned)
  conflicts: { tool: Tool; target: string }[]; // a NON-symlink already at the target — left untouched (never clobber)
  onPath: boolean;
  pathHint: string;
  ok: boolean;
}

/** Symlink each available tool source into `binDir`. Idempotent: a link already pointing at the right source is
 *  left as-is; a stale/wrong symlink is replaced; a real (non-symlink) file at the target is a CONFLICT we refuse
 *  to clobber. A tool whose source is missing is reported, not fatal for the others. */
export function installClis(convoyRoot: string, binDir: string, env: NodeJS.ProcessEnv = process.env): InstallResult {
  const sources = toolSources(convoyRoot);
  mkdirSync(binDir, { recursive: true });
  const linked: Tool[] = [];
  const missingSources: { tool: Tool; source: string }[] = [];
  const conflicts: { tool: Tool; target: string }[] = [];

  for (const tool of TOOLS) {
    const source = sources[tool];
    if (!existsSync(source)) {
      missingSources.push({ tool, source });
      continue;
    }
    const target = join(binDir, tool);
    let existing: "absent" | "symlink" | "other" = "absent";
    try {
      existing = lstatSync(target).isSymbolicLink() ? "symlink" : "other";
    } catch {
      existing = "absent";
    }
    if (existing === "other") {
      conflicts.push({ tool, target }); // a real file we didn't create — don't clobber
      continue;
    }
    if (existing === "symlink" && safeReadlink(target) === source) {
      linked.push(tool); // already correct — idempotent no-op
      continue;
    }
    if (existing === "symlink") {
      try {
        unlinkSync(target);
      } catch {
        // best-effort; symlinkSync below will surface a real problem
      }
    }
    symlinkSync(source, target);
    linked.push(tool);
  }

  return {
    binDir,
    linked,
    missingSources,
    conflicts,
    onPath: dirOnPath(binDir, env),
    pathHint: pathHint(binDir, env),
    ok: missingSources.length === 0 && conflicts.length === 0,
  };
}

function safeReadlink(p: string): string | null {
  try {
    return readlinkSync(p);
  } catch {
    return null;
  }
}
