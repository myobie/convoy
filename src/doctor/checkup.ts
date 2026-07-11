// Claude Code checkup — surface `claude doctor` (the CLI form of the in-session `/doctor`, alias `/checkup`) as
// an ADVISORY leg of `convoy doctor`. It's COMPLEMENTARY, not a duplicate: convoy doctor checks the NETWORK side
// (auth probe, hooks, bus, PTY_ROOT, TMPDIR); `/checkup` checks the CLAUDE-CODE side (install health, invalid
// settings files, unused extensions, duplicate subagent names, Remote Control eligibility).
//
// Advisory ONLY — it does NOT gate convoy doctor's pass/fail: `claude doctor` emits human-readable TEXT with no
// JSON and no documented exit code, so there's nothing reliable to gate on. We run it read-only, print its text,
// and recommend the in-session fix path. Version-gated: the enhanced checkup landed in claude 2.1.205, so on an
// older (or absent) claude we skip cleanly with a note, never a failure.

import { execFile } from "node:child_process";
import { childEnv, type ExecResult } from "../exec.ts";

export interface Version {
  major: number;
  minor: number;
  patch: number;
}

/** The enhanced `/checkup` (settings/dupe-subagent/RC checks) landed in Claude Code 2.1.205. */
export const CHECKUP_MIN: Version = { major: 2, minor: 1, patch: 205 };

/** Parse a Version from `claude --version` output ("2.1.207 (Claude Code)"). Null if no x.y.z is found. */
export function parseClaudeVersion(output: string): Version | null {
  const m = output.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** a >= b ? */
export function versionGte(a: Version, b: Version): boolean {
  if (a.major !== b.major) return a.major > b.major;
  if (a.minor !== b.minor) return a.minor > b.minor;
  return a.patch >= b.patch;
}

export type CheckupState = "unavailable" | "too-old" | "ran";

export interface CheckupResult {
  state: CheckupState;
  version?: string; // raw version string when claude is present
  text?: string; // `claude doctor` output when it ran
  note: string; // one-line advisory summary
  recommend?: string; // the in-session fix recommendation (when it ran)
}

export type Runner = (cmd: string, args: string[]) => Promise<ExecResult>;

/** Default runner: execFile with a timeout so a wedged `claude` can't stall the preflight. */
function timedRun(cmd: string, args: string[], timeoutMs = 15_000): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { env: childEnv(process.env), timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const e = err as (Error & { code?: unknown }) | null;
      const status = e && typeof e.code === "number" ? e.code : e ? 1 : 0;
      resolve({
        status,
        stdout: stdout ?? "",
        stderr: stderr ?? "",
        get ok() {
          return this.status === 0;
        },
      });
    });
  });
}

/** Run the Claude Code checkup as a read-only ADVISORY. Version-gated (claude >= 2.1.205). Never throws / never a
 *  hard failure — returns a state + text the caller surfaces informationally. Runner injectable for tests. */
export async function claudeCheckup(runner: Runner = timedRun): Promise<CheckupResult> {
  const ver = await runner("claude", ["--version"]);
  if (!ver.ok || !ver.stdout.trim()) {
    return { state: "unavailable", note: "Claude Code (`claude`) not found — skipped (install Claude Code for the /checkup install/settings health check)" };
  }
  const parsed = parseClaudeVersion(ver.stdout);
  const v = parsed ? `${parsed.major}.${parsed.minor}.${parsed.patch}` : ver.stdout.trim();
  if (!parsed || !versionGte(parsed, CHECKUP_MIN)) {
    return { state: "too-old", version: v, note: `Claude Code ${v} — /checkup needs ≥ 2.1.205; upgrade Claude Code (\`claude update\`) for the install/settings health check` };
  }
  const doc = await runner("claude", ["doctor"]);
  const text = (doc.stdout.trim() || doc.stderr.trim());
  return {
    state: "ran",
    version: v,
    text: text || "(claude doctor produced no output)",
    note: `Claude Code ${v} — \`claude doctor\` (advisory; not gated):`,
    recommend: "For Claude Code config issues, run `/doctor` (alias `/checkup`) in a session to review + apply fixes.",
  };
}
