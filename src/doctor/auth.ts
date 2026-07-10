// Auth-readiness preflight: verify the active harness(es) can ACTUALLY authenticate — not merely that a
// credential file exists. This closes the machine-wide-signout failure mode: a signed-out (or server-side
// revoked) harness is otherwise invisible until its next real spawn fails with "Not logged in". A file/keychain
// check is INSUFFICIENT here — in the signout incident the credential was present on disk but the token was
// REVOKED, so `claude auth status` / `codex login status` (both fast but LOCAL — they decode the cached cred,
// they don't call the server) report logged-in while calls actually 401. So the probe makes a real minimal call
// (a tiny `claude -p` / `codex exec`, a few seconds) that either succeeds or returns the not-signed-in signal.

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv } from "../exec.ts";

export type Harness = "claude" | "codex";

/** Normalized outcome of one harness's auth probe.
 *  - `live`         — a real call SUCCEEDED (auth verified end-to-end).
 *  - `signed-out`   — the call returned a clear not-signed-in / 401 / expired signal.
 *  - `unavailable`  — the harness binary isn't installed (capability-detected → skipped, not a failure).
 *  - `inconclusive` — the call errored in a way we can't attribute to auth (network / timeout). */
export type AuthSignal = "live" | "signed-out" | "unavailable" | "inconclusive";

export interface AuthOutcome {
  harness: Harness;
  /** true = live, false = signed-out/inconclusive (a preflight failure), null = not installed (skipped). */
  ok: boolean | null;
  detail: string;
  fix?: string;
}

const HARNESS_NAME: Record<Harness, string> = { claude: "Claude", codex: "Codex" };
const RELOGIN: Record<Harness, string> = { claude: "run `claude` then `/login`", codex: "run `codex login`" };

/** PURE classifier: map a probe signal to a preflight outcome. This is the unit-tested core — it needs no real
 *  auth, so a test can inject any signal and assert the outcome (live → pass, signed-out → fail + actionable). */
export function classifyAuthSignal(harness: Harness, signal: AuthSignal): AuthOutcome {
  const name = HARNESS_NAME[harness];
  switch (signal) {
    case "live":
      return { harness, ok: true, detail: `${name} is signed in — verified with a live probe (not just a cred on disk)` };
    case "signed-out":
      return {
        harness,
        ok: false,
        detail: `${name} is NOT signed in — a credential may be present on disk but the session is expired or was revoked, so real calls will fail`,
        fix: `${RELOGIN[harness]}, then re-run \`convoy doctor --quick\``,
      };
    case "unavailable":
      return { harness, ok: null, detail: `${name} not installed — skipped (capability-detected)` };
    case "inconclusive":
      return {
        harness,
        ok: false,
        detail: `could not verify ${name} auth — the probe errored (network / timeout?), so readiness is unconfirmed`,
        fix: `ensure you're online and signed in (${RELOGIN[harness]}), then re-run \`convoy doctor --quick\``,
      };
  }
}

/** Auth-failure keywords shared across both harnesses' signed-out output. rc≠0 already means "failed"; this only
 *  refines the MESSAGE (signed-out vs inconclusive), so a miss still fails the gate — just less precisely. */
const AUTH_FAIL = /log\s?in|logged in|authenticat|unauthor|\b401\b|invalid api key|api key|expired|not signed|credential|sign in|please run/i;

interface ProbeExec { code: number | null; stdout: string; stderr: string; timedOut: boolean; }

/** Run a real minimal call for a harness in a throwaway cwd (so no CLAUDE.md / project hooks / MCP load), close
 *  stdin (so `-p`/`exec` don't wait on piped input), and normalize to an AuthSignal. NOT unit-tested — it needs
 *  real auth; `classifyAuthSignal` is the tested part and this is injected in tests. */
export async function probeHarness(harness: Harness): Promise<AuthSignal> {
  const dir = mkdtempSync(join(tmpdir(), "cvd-auth-"));
  try {
    const spec: Record<Harness, string[]> = {
      claude: ["-p", "Reply with exactly: ok", "--model", "claude-haiku-4-5-20251001", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'],
      codex: ["exec", "--skip-git-repo-check", "Reply with exactly: ok"],
    };
    const res = await execProbe(harness, spec[harness], dir);
    // Order matters: `claude -p` prints "Not logged in · Please run /login" but EXITS 0, so a rc check alone
    // would false-pass a signed-out harness (the exact failure mode). Classify on the OUTPUT signal FIRST.
    if (AUTH_FAIL.test(`${res.stdout}\n${res.stderr}`)) return "signed-out";
    if (res.timedOut) return "inconclusive";
    if (res.code === 0) return "live";
    return "inconclusive";
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function execProbe(cmd: string, args: string[], cwd: string): Promise<ProbeExec> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { cwd, env: childEnv({ ...process.env }), timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const e = err as (Error & { killed?: boolean; signal?: string; code?: unknown }) | null;
      const timedOut = e?.killed === true && e.signal === "SIGTERM";
      const code = e && typeof e.code === "number" ? e.code : e ? 1 : 0;
      resolve({ code: timedOut ? null : code, stdout: stdout ?? "", stderr: stderr ?? "", timedOut });
    });
    child.stdin?.end(); // don't block on stdin
  });
}

/** Injectable for tests: given a present harness, return its probe signal. */
export type Prober = (harness: Harness) => Promise<AuthSignal>;
/** Injectable for tests: is this harness's binary on PATH? */
export type Detector = (harness: Harness) => Promise<boolean>;

function onPath(harness: Harness): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("/usr/bin/env", ["sh", "-c", `command -v ${harness}`], (err, stdout) => resolve(!err && Boolean(stdout.trim())));
  });
}

/** Capability-detect the installed harnesses and probe each — IN PARALLEL so total latency is the slowest single
 *  probe, not the sum. A harness that isn't installed is skipped (ok:null), never a failure. Returns one outcome
 *  per harness (installed or not). Both `prober` + `detector` are injectable for tests. */
export async function authReadiness(prober: Prober = probeHarness, detector: Detector = onPath): Promise<AuthOutcome[]> {
  const harnesses: Harness[] = ["claude", "codex"];
  return Promise.all(
    harnesses.map(async (h) => ((await detector(h)) ? classifyAuthSignal(h, await prober(h)) : classifyAuthSignal(h, "unavailable"))),
  );
}
