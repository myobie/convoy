import { describe, it, expect } from "vitest";
import { authReadiness, classifyAuthSignal, classifyProbe, type AuthSignal, type Harness, type ProbeExec } from "./auth.ts";

describe("classifyProbe — probe result → signal (the false-negative fix: only a CLEAR signal is signed-out)", () => {
  const probe = (over: Partial<ProbeExec>): ProbeExec => ({ code: 0, stdout: "", stderr: "", timedOut: false, ...over });

  it("a CLEAR not-signed-in signal → signed-out — even when the process EXITS 0 (claude -p prints it but rc 0)", () => {
    expect(classifyProbe(probe({ code: 0, stdout: "Not logged in · Please run /login" }))).toBe("signed-out");
    expect(classifyProbe(probe({ code: 1, stderr: "Invalid API key · Please run /login" }))).toBe("signed-out");
    expect(classifyProbe(probe({ code: 1, stderr: "stream error: unexpected status 401 Unauthorized" }))).toBe("signed-out");
    expect(classifyProbe(probe({ code: 1, stdout: "OAuth token has expired" }))).toBe("signed-out");
    expect(classifyProbe(probe({ code: 1, stderr: "Please run `codex login` to authenticate" }))).toBe("signed-out");
  });

  it("rc 0 with no auth-failure signal → live", () => {
    expect(classifyProbe(probe({ code: 0, stdout: "ok" }))).toBe("live");
  });

  it("THE BUG: a signed-IN user whose probe fails for a NON-AUTH reason → inconclusive, NEVER signed-out", () => {
    // Johannes-class failures: sandbox restriction, a wrong/failed binary, a generic crash — none is an auth
    // verdict. The old regex matched loose words in this output and mislabeled these as "not signed in".
    expect(classifyProbe(probe({ code: 1, stderr: "Error: operation not permitted (sandbox)" }))).toBe("inconclusive");
    expect(classifyProbe(probe({ code: 127, stderr: "env: claude: No such file or directory" }))).toBe("inconclusive");
    expect(classifyProbe(probe({ code: 1, stderr: "Tip: set your API key with ANTHROPIC_API_KEY" }))).toBe("inconclusive"); // bare "API key" is NOT signed-out
    expect(classifyProbe(probe({ code: 1, stderr: "Please run `npm install` first" }))).toBe("inconclusive"); // generic "please run" (no login) is NOT signed-out
  });

  it("does NOT mistake SUCCESS wording for signed-out (authenticated / logged in as …)", () => {
    // The old pattern matched `authenticat` and `logged in`, which appear in SUCCESS output → false signed-out.
    expect(classifyProbe(probe({ code: 0, stdout: "Authenticated. You are logged in as user@example.com" }))).toBe("live");
    expect(classifyProbe(probe({ code: 0, stdout: "Signed in — proceeding" }))).toBe("live");
  });

  it("a TIMEOUT → inconclusive, checked FIRST — a hung call is never read as signed-out (even with partial auth-ish output)", () => {
    expect(classifyProbe(probe({ code: null, timedOut: true }))).toBe("inconclusive");
    // timeout takes precedence over a partial output that would otherwise match — a network hang is not a verdict.
    expect(classifyProbe(probe({ code: null, stdout: "Not logged in", timedOut: true }))).toBe("inconclusive");
  });
});

describe("classifyAuthSignal (pure — no real auth needed)", () => {
  it("live → PASS", () => {
    const o = classifyAuthSignal("claude", "live");
    expect(o.ok).toBe(true);
    expect(o.detail).toMatch(/signed in/i);
    expect(o.fix).toBeUndefined();
  });

  it("signed-out → FAIL with an actionable re-login fix, and names the cred-present-but-revoked subtlety", () => {
    const o = classifyAuthSignal("claude", "signed-out");
    expect(o.ok).toBe(false);
    expect(o.detail).toMatch(/not signed in/i);
    expect(o.detail).toMatch(/present on disk|revoked|expired/i); // the whole point: cred-present is not enough
    expect(o.fix).toMatch(/claude.*\/login/i);
  });

  it("codex signed-out → codex-specific re-login instruction", () => {
    const o = classifyAuthSignal("codex", "signed-out");
    expect(o.ok).toBe(false);
    expect(o.fix).toMatch(/codex login/i);
  });

  it("unavailable → SKIP (ok:null), never a failure", () => {
    const o = classifyAuthSignal("codex", "unavailable");
    expect(o.ok).toBeNull();
    expect(o.detail).toMatch(/not installed|skipped/i);
  });

  it("inconclusive → FAIL (readiness unconfirmed), distinct message from signed-out", () => {
    const o = classifyAuthSignal("claude", "inconclusive");
    expect(o.ok).toBe(false);
    expect(o.detail).toMatch(/could not verify|network|timeout/i);
  });
});

describe("authReadiness (capability-detect + probe, injected)", () => {
  const detectAll: (h: Harness) => Promise<boolean> = async () => true;
  const detectClaudeOnly: (h: Harness) => Promise<boolean> = async (h) => h === "claude";

  it("PASSES when the installed harness probes live", async () => {
    const outcomes = await authReadiness(async () => "live", detectAll);
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((o) => o.ok === true)).toBe(true);
  });

  it("FAILS the signed-out harness while passing the live one (per-harness)", async () => {
    const prober = async (h: Harness): Promise<AuthSignal> => (h === "claude" ? "signed-out" : "live");
    const outcomes = await authReadiness(prober, detectAll);
    const claude = outcomes.find((o) => o.harness === "claude")!;
    const codex = outcomes.find((o) => o.harness === "codex")!;
    expect(claude.ok).toBe(false);
    expect(claude.fix).toMatch(/login/i);
    expect(codex.ok).toBe(true);
  });

  it("SKIPS an uninstalled harness (ok:null) without probing it", async () => {
    let probedCodex = false;
    const prober = async (h: Harness): Promise<AuthSignal> => {
      if (h === "codex") probedCodex = true;
      return "live";
    };
    const outcomes = await authReadiness(prober, detectClaudeOnly);
    expect(outcomes.find((o) => o.harness === "codex")!.ok).toBeNull(); // skipped
    expect(outcomes.find((o) => o.harness === "claude")!.ok).toBe(true);
    expect(probedCodex).toBe(false); // never probed the absent harness
  });

  it("a signed-out harness with a present cred (the incident) FAILS — cred-present is not enough", async () => {
    // The prober models the incident: the local cred exists, but the real call returns not-signed-in.
    const outcomes = await authReadiness(async () => "signed-out", detectClaudeOnly);
    expect(outcomes.find((o) => o.harness === "claude")!.ok).toBe(false);
  });
});

describe("required narrowing — don't red-fail a valid setup (installed-but-unused = WARN)", () => {
  it("classify: an UNUSED harness that's signed-out is a WARN (ok:null), not a hard FAIL", () => {
    expect(classifyAuthSignal("codex", "signed-out", false).ok).toBeNull();
    expect(classifyAuthSignal("codex", "signed-out", false).detail).toMatch(/installed but not signed in|not used/i);
    expect(classifyAuthSignal("codex", "signed-out", false).fix).toBeUndefined(); // a WARN carries no blocking fix
  });
  it("classify: a USED (required) harness that's signed-out still HARD-fails", () => {
    expect(classifyAuthSignal("claude", "signed-out", true).ok).toBe(false);
    expect(classifyAuthSignal("claude", "signed-out").ok).toBe(false); // required defaults to true
  });
  it("classify: an unused harness whose probe is inconclusive is also a WARN, not a fail", () => {
    expect(classifyAuthSignal("codex", "inconclusive", false).ok).toBeNull();
  });
  it("authReadiness: claude-only setup with codex installed-and-signed-out PASSES (codex → WARN)", async () => {
    const detectAll: (h: Harness) => Promise<boolean> = async () => true;
    const outcomes = await authReadiness(async () => "signed-out", detectAll, (h) => h === "claude"); // only claude required
    const claude = outcomes.find((o) => o.harness === "claude")!;
    const codex = outcomes.find((o) => o.harness === "codex")!;
    expect(claude.ok).toBe(false); // claude required + signed-out → hard fail
    expect(codex.ok).toBeNull(); // codex installed-but-unused + signed-out → WARN, not a fail
  });
});
