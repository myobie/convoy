import { describe, it, expect } from "vitest";
import { authReadiness, classifyAuthSignal, type AuthSignal, type Harness } from "./auth.ts";

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
