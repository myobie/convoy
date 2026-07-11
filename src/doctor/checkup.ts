// Harness checkups — surface each installed harness's own doctor (`claude doctor` / `codex doctor`) as an
// ADVISORY leg of `convoy doctor`. Complementary, not a duplicate: convoy doctor checks the NETWORK side (auth
// probe, hooks, bus, PTY_ROOT, TMPDIR); a harness doctor checks the HARNESS side (install health, invalid
// settings, unused extensions, duplicate subagents, auth/runtime health).
//
// Advisory ONLY — never gates convoy's pass/fail: these doctors emit human-readable TEXT with no JSON / no
// documented exit code, so there's nothing reliable to gate on. We run each read-only (timeout-guarded), and —
// because the raw output can be a verbose wall of text with a couple of buried warnings — pipe it through THAT
// harness's OWN headless LLM (`claude -p` / `codex exec`, already signed in, no API keys) to DISTILL the
// actionable issues. Distill only when the raw output has issues (a clean "no issues" passes through), with a
// tight timeout and a FALL BACK to the raw text if the distill call fails/times out — never stall the preflight.
// Version-gated per harness (claude's enhanced doctor landed in 2.1.205); older/absent → a clean note.

import { execFile } from "node:child_process";
import { childEnv, type ExecResult } from "../exec.ts";

export type Harness = "claude" | "codex";

export interface Version {
  major: number;
  minor: number;
  patch: number;
}

/** The enhanced Claude Code doctor (settings/dupe-subagent/RC checks) landed in 2.1.205. */
export const CLAUDE_DOCTOR_MIN: Version = { major: 2, minor: 1, patch: 205 };

/** Parse a Version from a `--version` line ("2.1.207 (Claude Code)", "codex-cli 0.142.5"). Null if none. */
export function parseVersion(output: string): Version | null {
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

/** Does a doctor's raw output look like it has ACTIONABLE issues (→ worth distilling)? A clean "no issues found"
 *  passes through raw; warning/error glyphs (codex uses ⚠/✗) or explicit failure words mean distill. */
export function hasActionableIssues(raw: string): boolean {
  if (/no (installation )?issues? found/i.test(raw)) return false;
  return /[⚠✗✘❌]/u.test(raw) || /\b(error|failed|invalid|missing|incomplete)\b/i.test(raw);
}

interface HarnessSpec {
  harness: Harness;
  label: string;
  bin: string;
  minVersion: Version | null; // claude: 2.1.205; codex: capability-only
  distillArgs: (prompt: string) => string[];
  recommend: string;
}

const DISTILL_PROMPT = (bin: string, raw: string): string =>
  `Summarize the output of \`${bin} doctor\` (a local install/config health check) as 1-3 short bullet points — ONLY real issues a user should fix, each with the fix if obvious. Ignore routine version-update notices. If nothing is actionable, reply with exactly: OK. Output follows:\n\n${raw}`;

const SPECS: Record<Harness, HarnessSpec> = {
  claude: {
    harness: "claude",
    label: "Claude Code",
    bin: "claude",
    minVersion: CLAUDE_DOCTOR_MIN,
    distillArgs: (prompt) => ["-p", prompt, "--model", "claude-haiku-4-5-20251001", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'],
    recommend: "For Claude Code config issues, run `/doctor` in a Claude Code session to review + apply fixes.",
  },
  codex: {
    harness: "codex",
    label: "Codex",
    bin: "codex",
    minVersion: null,
    distillArgs: (prompt) => ["exec", "--skip-git-repo-check", prompt],
    recommend: "For Codex config issues, `codex doctor` prints the details + fixes inline.",
  },
};

export type CheckupState = "unavailable" | "too-old" | "no-doctor" | "ran";

export interface CheckupResult {
  harness: Harness;
  label: string;
  state: CheckupState;
  version?: string;
  raw?: string; // raw doctor output (shown when clean or when distill fell back)
  distilled?: string; // LLM-distilled summary (when it ran)
  note: string;
  recommend?: string;
}

export type Runner = (cmd: string, args: string[], timeoutMs?: number) => Promise<ExecResult>;

/** Default runner: execFile with a timeout so a wedged harness can't stall the preflight. */
function timedRun(cmd: string, args: string[], timeoutMs = 15_000): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { env: childEnv(process.env), timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
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
    child.stdin?.end();
  });
}

/** How many issues a doctor's raw output flags (warning/error glyphs; at least 1 when hasActionableIssues). */
export function countIssues(raw: string): number {
  const glyphs = (raw.match(/[⚠✗✘❌]/gu) ?? []).length;
  return glyphs > 0 ? glyphs : 1;
}

/** Run ONE harness's checkup (advisory, read-only, version/capability-gated). `distill` controls the ISSUES case:
 *  when true (the full `convoy doctor`), the issues are LLM-distilled to 1-3 actionable bullets by that harness's
 *  own CLI; when false (the fast, LLM-FREE `--quick` preflight), it stays deterministic — just the issue COUNT +
 *  a pointer to the full doctor for the distilled explanation. A clean result is a one-liner either way. Never
 *  throws. Runner injectable for tests. */
export async function harnessCheckup(harness: Harness, distill: boolean, runner: Runner = timedRun): Promise<CheckupResult> {
  const spec = SPECS[harness];
  const base = { harness, label: spec.label };

  const ver = await runner(spec.bin, ["--version"], 10_000);
  if (!ver.ok || !ver.stdout.trim()) {
    return { ...base, state: "unavailable", note: `${spec.label} (\`${spec.bin}\`) not installed — skipped` };
  }
  const parsed = parseVersion(ver.stdout);
  const v = parsed ? `${parsed.major}.${parsed.minor}.${parsed.patch}` : ver.stdout.trim();
  if (spec.minVersion && (!parsed || !versionGte(parsed, spec.minVersion))) {
    const min = `${spec.minVersion.major}.${spec.minVersion.minor}.${spec.minVersion.patch}`;
    return { ...base, state: "too-old", version: v, note: `${spec.label} ${v} — doctor needs ≥ ${min}; upgrade for the health check` };
  }

  const doc = await runner(spec.bin, ["doctor"], 15_000);
  const raw = (doc.stdout.trim() || doc.stderr.trim());
  if (!raw) {
    return { ...base, state: "no-doctor", version: v, note: `${spec.label} ${v} — \`${spec.bin} doctor\` produced no output (may be an older ${spec.bin})` };
  }

  // A clean result is a concise one-liner either way (no LLM call, no dump).
  if (!hasActionableIssues(raw)) {
    return { ...base, state: "ran", version: v, note: `${spec.label} ${v} — \`${spec.bin} doctor\`: no issues found` };
  }

  // Has issues. In the LLM-FREE mode (--quick), stay fast + deterministic: report the count + point at the full
  // doctor. Only the full `convoy doctor` pays the LLM to distill (advisory, slow, non-deterministic).
  const n = countIssues(raw);
  if (!distill) {
    return { ...base, state: "ran", version: v, note: `${spec.label} ${v} — \`${spec.bin} doctor\`: ${n} issue${n === 1 ? "" : "s"} — run \`convoy doctor\` for the distilled explanation` };
  }
  const d = await runner(spec.bin, spec.distillArgs(DISTILL_PROMPT(spec.bin, raw)), 25_000);
  const summary = d.ok ? d.stdout.trim() : "";
  return {
    harness,
    label: spec.label,
    state: "ran",
    version: v,
    ...(summary ? { distilled: summary } : { raw }), // distilled summary, or FALL BACK to raw text
    note: summary ? `${spec.label} ${v} — \`${spec.bin} doctor\` (${n} issue${n === 1 ? "" : "s"}, distilled; advisory, not gated):` : `${spec.label} ${v} — \`${spec.bin} doctor\` (advisory, not gated; distill unavailable — raw):`,
    recommend: spec.recommend,
  };
}

/** Run the installed harnesses' checkups in PARALLEL (latency = the slowest single harness, not the sum).
 *  `distill` (= NOT --quick) gates the LLM distill of any issues onto the full `convoy doctor` only. */
export async function harnessCheckups(distill: boolean, runner: Runner = timedRun): Promise<CheckupResult[]> {
  return Promise.all((["claude", "codex"] as Harness[]).map((h) => harnessCheckup(h, distill, runner)));
}
