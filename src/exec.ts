// A thin promise wrapper around child_process for the few tools convoy still shells (`st`, `git`).
// Most pty interaction is native via @myobie/pty/client (src/host.ts); this is the residual seam.

import { execFile, execFileSync } from "node:child_process";
import { homedir } from "node:os";

export interface ExecResult {
  status: number;
  stdout: string;
  stderr: string;
  readonly ok: boolean;
}

// An enriched PATH resolved once from the login shell, unioned with common tool locations + the
// current PATH — ported from Swift's Shell.enrichedPath. A process launched with a minimal PATH (a
// GUI .app, or a test harness spawning convoy) inherits only `/usr/bin:/bin`, so st/pty/claude
// (installed under nvm etc.) wouldn't resolve. Forcing this on every child makes shell-outs and the
// native `spawnDaemon` leaf resolve their tools identically from a terminal or a minimal spawn env.
let _enriched: string | null = null;
export function enrichedPath(): string {
  if (_enriched !== null) return _enriched;
  const dirs: string[] = [];
  try {
    // The user's login shell resolves nvm/user PATH entries a minimal spawn env misses. Use $SHELL (Linux
    // defaults to bash, not zsh — hardcoding /bin/zsh silently skipped this on Linux), falling back to /bin/sh;
    // `-lc` + printf work for sh/bash/zsh (fish/others fail → caught → the common-dir fallback still applies). A
    // short timeout so a slow/hanging login shell can't wedge convoy.
    const shell = process.env["SHELL"] || "/bin/sh";
    const login = execFileSync(shell, ["-lc", 'printf %s "$PATH"'], { encoding: "utf8", timeout: 2000 });
    dirs.push(...login.split(":"));
  } catch {
    // no usable login shell — fall through to current PATH + common dirs
  }
  if (process.env["PATH"]) dirs.push(...process.env["PATH"].split(":"));
  const home = process.env["HOME"] ?? homedir();
  dirs.push("/opt/homebrew/bin", "/usr/local/bin", `${home}/.local/bin`, `${home}/bin`, "/usr/bin", "/bin", "/usr/sbin", "/sbin");
  const seen = new Set<string>();
  _enriched = dirs.filter((d) => d && !seen.has(d) && (seen.add(d), true)).join(":");
  return _enriched;
}

/** Build a child env with PATH forced to the enriched value (deterministic tool resolution). */
export function childEnv(overlay?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...(overlay ?? process.env), PATH: enrichedPath() };
}

export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      { cwd: opts.cwd, env: childEnv(opts.env), maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err && typeof err === "object" && "code" in err ? err.code : undefined;
        const status = typeof code === "number" ? code : err ? 1 : 0;
        resolve({ status, stdout: stdout ?? "", stderr: stderr ?? "", get ok() { return this.status === 0; } });
      },
    );
    if (opts.input !== undefined && child.stdin) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
  });
}
