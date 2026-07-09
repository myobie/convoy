import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootPrompt, claudeCommand, dingCommand, writePtyToml } from "./launch.ts";
import type { AgentSpec } from "./agent-spec.ts";

describe("native launch command builders (cold-start boot-prompt)", () => {
  it("claudeCommand: cold start — exec claude with the mode + boot prompt, NO poker, NO --resume", () => {
    const prompt = bootPrompt("worker");
    const c = claudeCommand("bypassPermissions", prompt);
    expect(c).toBe(`exec claude --permission-mode bypassPermissions '${prompt}'`);
    expect(c).not.toContain("--resume");
    expect(c).not.toContain("pty send"); // no auto-poker
    expect(c.startsWith("exec claude")).toBe(true);
  });

  it("bootPrompt: cos gets the first-run-interview variant; others get the worker boot", () => {
    expect(bootPrompt("chief-of-staff")).toContain("first-run interview");
    expect(bootPrompt("worker")).toContain("stand by for work");
    expect(bootPrompt("worker")).not.toContain("first-run");
    // must stay single-quote-safe (wrapped in '...' for sh -c)
    expect(bootPrompt("chief-of-staff")).not.toContain("'");
    expect(bootPrompt("worker")).not.toContain("'");
  });

  it("dingCommand: st ding <claude-session-id> --identity <bus-id>", () => {
    expect(dingCommand("convoy-claude", "silber.convoy")).toBe("st ding silber.convoy --identity convoy-claude");
  });
});

describe("writePtyToml (pinned hostname-prefixed ids, cold start)", () => {
  const spec = (over: Partial<AgentSpec> = {}): AgentSpec => ({
    harness: "claude",
    role: "worker",
    identity: "convoy-claude",
    transport: "ding",
    networkRoot: null,
    personaOverride: null,
    workingDir: null,
    permanentOverride: null,
    prefix: "silber",
    ...over,
  });

  it("pins ids to <prefix>.<agentShort> (+ .ding), cold-start command, no poker/resume", () => {
    const dir = mkdtempSync(join(tmpdir(), "convoy-ptytoml-"));
    try {
      writePtyToml(dir, spec());
      const toml = readFileSync(join(dir, "pty.toml"), "utf8");
      expect(toml).toContain('id = "silber.convoy"');
      expect(toml).toContain('id = "silber.convoy.ding"');
      expect(toml).toContain('prefix = "silber.convoy"');
      expect(toml).toContain("exec claude --permission-mode bypassPermissions");
      expect(toml).toContain("st ding silber.convoy --identity convoy-claude");
      expect(toml).not.toContain("pty send"); // poker gone
      expect(toml).not.toContain("--resume"); // cold start
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cos spec gets the first-run-interview boot prompt", () => {
    const dir = mkdtempSync(join(tmpdir(), "convoy-ptytoml-cos-"));
    try {
      writePtyToml(dir, spec({ role: "chief-of-staff", identity: "cos-claude" }));
      const toml = readFileSync(join(dir, "pty.toml"), "utf8");
      expect(toml).toContain('id = "silber.cos"');
      expect(toml).toContain("first-run interview");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
