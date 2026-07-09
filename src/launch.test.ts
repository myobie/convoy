import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootPrompt, claudeCommand, dingCommand, discoverSmalltalkDir, writePtyToml } from "./launch.ts";
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

describe("discoverSmalltalkDir (fresh-install hook discovery, no SMALLTALK_DIR needed)", () => {
  const saved = process.env["SMALLTALK_DIR"];
  afterEach(() => {
    if (saved === undefined) delete process.env["SMALLTALK_DIR"];
    else process.env["SMALLTALK_DIR"] = saved;
  });

  it("honors SMALLTALK_DIR when it holds the hook scripts", () => {
    const dir = mkdtempSync(join(tmpdir(), "convoy-sm-"));
    try {
      mkdirSync(join(dir, "examples", "claude-code", "hooks"), { recursive: true });
      writeFileSync(join(dir, "examples", "claude-code", "hooks", "session-start.sh"), "#!/bin/sh\n");
      process.env["SMALLTALK_DIR"] = dir;
      expect(discoverSmalltalkDir()).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores a SMALLTALK_DIR that lacks the hooks (falls through to st/sibling discovery)", () => {
    const empty = mkdtempSync(join(tmpdir(), "convoy-sm-empty-"));
    try {
      process.env["SMALLTALK_DIR"] = empty;
      const found = discoverSmalltalkDir();
      // On any dev/CI box with `st` on PATH (or the sibling ../smalltalk), discovery still succeeds —
      // and it must NOT be the hook-less env dir.
      expect(found).not.toBe(empty);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
