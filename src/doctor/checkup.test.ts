import { describe, it, expect } from "vitest";
import { countIssues, harnessCheckup, hasActionableIssues, parseVersion, versionGte, type Runner } from "./checkup.ts";
import type { ExecResult } from "../exec.ts";

const exec = (over: Partial<ExecResult>): ExecResult => ({ status: 0, stdout: "", stderr: "", get ok() { return this.status === 0; }, ...over });

describe("parseVersion", () => {
  it("parses claude + codex version lines", () => {
    expect(parseVersion("2.1.207 (Claude Code)")).toEqual({ major: 2, minor: 1, patch: 207 });
    expect(parseVersion("codex-cli 0.142.5")).toEqual({ major: 0, minor: 142, patch: 5 });
  });
  it("null when no x.y.z", () => {
    expect(parseVersion("unknown")).toBeNull();
  });
});

describe("versionGte", () => {
  it("compares correctly", () => {
    expect(versionGte({ major: 2, minor: 1, patch: 207 }, { major: 2, minor: 1, patch: 205 })).toBe(true);
    expect(versionGte({ major: 2, minor: 1, patch: 205 }, { major: 2, minor: 1, patch: 205 })).toBe(true);
    expect(versionGte({ major: 2, minor: 1, patch: 204 }, { major: 2, minor: 1, patch: 205 })).toBe(false);
  });
});

describe("hasActionableIssues", () => {
  it("clean 'no issues found' → false", () => {
    expect(hasActionableIssues("Claude Code doctor\n\nNo installation issues found.")).toBe(false);
  });
  it("warning glyphs / failure words → true", () => {
    expect(hasActionableIssues("⚠ mcp  MCP configuration has optional issues")).toBe(true);
    expect(hasActionableIssues("settings.json is invalid")).toBe(true);
  });
});

describe("harnessCheckup (injected runner — advisory, never throws)", () => {
  it("absent harness → 'unavailable', no doctor run", async () => {
    const runner: Runner = async () => exec({ status: 127, stderr: "not found" });
    const r = await harnessCheckup("claude", true, runner);
    expect(r.state).toBe("unavailable");
  });

  it("claude older than 2.1.205 → 'too-old', does NOT run doctor", async () => {
    let ranDoctor = false;
    const runner: Runner = async (_c, args) => {
      if (args[0] === "doctor") ranDoctor = true;
      return exec({ stdout: "2.1.100 (Claude Code)" });
    };
    const r = await harnessCheckup("claude", true, runner);
    expect(r.state).toBe("too-old");
    expect(ranDoctor).toBe(false);
  });

  it("clean doctor output → passes raw through, does NOT call the distill LLM", async () => {
    let calledDistill = false;
    const runner: Runner = async (_c, args) => {
      if (args[0] === "--version") return exec({ stdout: "2.1.207 (Claude Code)" });
      if (args[0] === "doctor") return exec({ stdout: "No installation issues found." });
      calledDistill = true; // -p distill
      return exec({ stdout: "should not be called" });
    };
    const r = await harnessCheckup("claude", true, runner);
    expect(r.state).toBe("ran");
    expect(r.note).toMatch(/no issues found/i); // clean → a concise one-liner, not a raw dump
    expect(r.raw).toBeUndefined();
    expect(r.distilled).toBeUndefined();
    expect(calledDistill).toBe(false); // trivial → no LLM call
  });

  it("issues in doctor output → DISTILLS via the harness's own LLM", async () => {
    const runner: Runner = async (_c, args) => {
      if (args[0] === "--version") return exec({ stdout: "codex-cli 0.142.5" });
      if (args[0] === "doctor") return exec({ stdout: "⚠ mcp  MCP configuration has optional issues\n⚠ threads  rollout scan incomplete" });
      return exec({ stdout: "- MCP: set the missing env vars\n- threads: re-run the rollout scan" }); // exec distill
    };
    const r = await harnessCheckup("codex", true, runner);
    expect(r.state).toBe("ran");
    expect(r.distilled).toMatch(/MCP: set the missing env vars/);
    expect(r.raw).toBeUndefined(); // distilled, not raw
    expect(r.recommend).toBeTruthy();
  });

  it("distill FAILS → falls back to the raw doctor text (never stalls / never empty)", async () => {
    const runner: Runner = async (_c, args) => {
      if (args[0] === "--version") return exec({ stdout: "codex-cli 0.142.5" });
      if (args[0] === "doctor") return exec({ stdout: "⚠ mcp  something is wrong" });
      return exec({ status: 1, stderr: "distill timed out" }); // distill fails
    };
    const r = await harnessCheckup("codex", true, runner);
    expect(r.state).toBe("ran");
    expect(r.distilled).toBeUndefined();
    expect(r.raw).toMatch(/something is wrong/); // fell back to raw
    expect(r.note).toMatch(/raw/i);
  });
});

describe("--quick lean mode (distill=false): raw/LLM-free — count + pointer, no LLM call", () => {
  it("issues + distill=false → reports the issue COUNT + 'run convoy doctor', and does NOT call the LLM", async () => {
    let calledDistill = false;
    const runner: Runner = async (_c, args) => {
      if (args[0] === "--version") return exec({ stdout: "codex-cli 0.142.5" });
      if (args[0] === "doctor") return exec({ stdout: "⚠ mcp  optional issues\n⚠ threads  scan incomplete" });
      calledDistill = true;
      return exec({ stdout: "should not be called on --quick" });
    };
    const r = await harnessCheckup("codex", false, runner);
    expect(r.state).toBe("ran");
    expect(r.note).toMatch(/2 issues/); // the count
    expect(r.note).toMatch(/run `convoy doctor`/i); // the pointer to the full doctor
    expect(r.distilled).toBeUndefined();
    expect(r.raw).toBeUndefined();
    expect(calledDistill).toBe(false); // LLM-FREE on --quick
  });
  it("clean + distill=false → still a one-liner, no LLM", async () => {
    const runner: Runner = async (_c, args) =>
      args[0] === "--version" ? exec({ stdout: "2.1.207 (Claude Code)" }) : exec({ stdout: "No installation issues found." });
    const r = await harnessCheckup("claude", false, runner);
    expect(r.note).toMatch(/no issues found/i);
  });
});

describe("countIssues", () => {
  it("counts warning/error glyphs, at least 1 for a keyword-only match", () => {
    expect(countIssues("⚠ a\n⚠ b\n✗ c")).toBe(3);
    expect(countIssues("settings.json is invalid")).toBe(1); // no glyph but hasActionableIssues → floor 1
  });
});
