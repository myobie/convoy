import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootPrompt, dingCommand, discoverSmalltalkDir, harnessCommand, regenerateDingRoot, writePtyToml } from "./launch.ts";
import type { AgentSpec } from "./agent-spec.ts";

describe("native launch command builders (cold-start boot-prompt)", () => {
  it("harnessCommand claude: exec claude with the mode + boot prompt, NO poker, NO --resume", () => {
    const prompt = bootPrompt("worker");
    const c = harnessCommand("claude", "bypassPermissions", prompt);
    expect(c).toBe(`exec claude --permission-mode bypassPermissions '${prompt}'`);
    expect(c).not.toContain("--resume");
    expect(c).not.toContain("pty send"); // no auto-poker
    expect(c.startsWith("exec claude")).toBe(true);
  });

  it("harnessCommand codex: exec codex (bypass approvals+sandbox) with the boot prompt — NOT claude", () => {
    const prompt = bootPrompt("worker");
    const c = harnessCommand("codex", "bypassPermissions", prompt);
    expect(c).toBe(`exec codex --dangerously-bypass-approvals-and-sandbox '${prompt}'`);
    expect(c).not.toContain("claude");
    expect(c.startsWith("exec codex")).toBe(true);
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

  it("dingCommand: bakes --root <net> into the command line when a network root is given (restart-proof)", () => {
    expect(dingCommand("convoy-claude", "silber.convoy", "/Users/x/.local/state/convoy")).toBe(
      "st ding silber.convoy --identity convoy-claude --root /Users/x/.local/state/convoy",
    );
    // no root → no flag (unchanged behavior; falls back to ST_ROOT env / install default)
    expect(dingCommand("convoy-claude", "silber.convoy", null)).toBe("st ding silber.convoy --identity convoy-claude");
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
    configDir: null,
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

  it("networkRoot bakes --root <net> into the ding command line only (not the harness session)", () => {
    const dir = mkdtempSync(join(tmpdir(), "convoy-ptytoml-root-"));
    try {
      writePtyToml(dir, spec({ networkRoot: "/net/convoy" }));
      const toml = readFileSync(join(dir, "pty.toml"), "utf8");
      // ding command carries --root so a pty-restart can't drop the root
      expect(toml).toContain("st ding silber.convoy --identity convoy-claude --root /net/convoy");
      // --root is a ding-only concern; the harness (claude) command must not get it
      expect(toml).not.toContain("exec claude --permission-mode bypassPermissions --root");
      // env still carries ST_ROOT too (belt-and-suspenders)
      expect(toml).toContain('ST_ROOT = "/net/convoy"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--config-dir sets CLAUDE_CONFIG_DIR on the HARNESS session env only, not the ding sidecar", () => {
    const dir = mkdtempSync(join(tmpdir(), "convoy-ptytoml-cfg-"));
    try {
      writePtyToml(dir, spec({ configDir: "/seeded/cfg" }));
      const toml = readFileSync(join(dir, "pty.toml"), "utf8");
      expect(toml).toContain('CLAUDE_CONFIG_DIR = "/seeded/cfg"');
      // exactly once — on the claude session, never duplicated onto the ding session.
      expect(toml.match(/CLAUDE_CONFIG_DIR/g)?.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("no --config-dir → no CLAUDE_CONFIG_DIR in the toml (inherits ambient config)", () => {
    const dir = mkdtempSync(join(tmpdir(), "convoy-ptytoml-nocfg-"));
    try {
      writePtyToml(dir, spec());
      expect(readFileSync(join(dir, "pty.toml"), "utf8")).not.toContain("CLAUDE_CONFIG_DIR");
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

  it("harness codex writes a [sessions.codex] running exec codex — NOT a claude session (bug #: false-harness)", () => {
    const dir = mkdtempSync(join(tmpdir(), "convoy-ptytoml-codex-"));
    try {
      writePtyToml(dir, spec({ harness: "codex", identity: "vauban-codex", transport: "ding" }));
      const toml = readFileSync(join(dir, "pty.toml"), "utf8");
      expect(toml).toContain("[sessions.codex]");
      expect(toml).toContain("exec codex --dangerously-bypass-approvals-and-sandbox");
      expect(toml).not.toContain("[sessions.claude]");
      expect(toml).not.toContain("exec claude");
      expect(toml).toContain('id = "silber.vauban"'); // agentShort strips the -codex suffix
      expect(toml).toContain("st ding silber.vauban --identity vauban-codex"); // ding sidecar present
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

describe("regenerateDingRoot (heal pre-#43 pty.tomls for cold-start durability)", () => {
  // A PRE-#43 pty.toml: ding command has NO --root, root lives only in [sessions.ding.env].
  const preToml = `prefix = "silber.evals"

[sessions.claude]
id = "silber.evals"
command = "exec claude --permission-mode bypassPermissions --resume ABC-123-RESUME"

[sessions.claude.tags]
role = "agent"
strategy = "permanent"
"st.network" = "/net/convoy"

[sessions.claude.env]
ST_AGENT = "evals-claude"
ST_ROOT = "/net/convoy"
PTY_ROOT = "/net/convoy/pty"

[sessions.ding]
id = "silber.evals.ding"
command = "st ding silber.evals --identity evals-claude"

[sessions.ding.tags]
role = "ding"
strategy = "permanent"
"st.network" = "/net/convoy"

[sessions.ding.env]
ST_AGENT = "evals-claude"
ST_ROOT = "/net/convoy"
PTY_ROOT = "/net/convoy/pty"
`;

  it("bakes --root into the ding command and leaves the harness (role prompt + --resume) VERBATIM", () => {
    const dir = mkdtempSync(join(tmpdir(), "convoy-regen-"));
    try {
      writeFileSync(join(dir, "pty.toml"), preToml);
      const r = regenerateDingRoot(dir);
      expect(r).not.toBeNull();
      expect(r?.before).toBe("st ding silber.evals --identity evals-claude");
      expect(r?.after).toBe("st ding silber.evals --identity evals-claude --root /net/convoy");
      const out = readFileSync(join(dir, "pty.toml"), "utf8");
      expect(out).toContain('command = "st ding silber.evals --identity evals-claude --root /net/convoy"');
      // harness block untouched — --resume + boot prompt survive byte-for-byte
      expect(out).toContain('command = "exec claude --permission-mode bypassPermissions --resume ABC-123-RESUME"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is idempotent — a second run on the healed file is a no-op (returns null)", () => {
    const dir = mkdtempSync(join(tmpdir(), "convoy-regen-idem-"));
    try {
      writeFileSync(join(dir, "pty.toml"), preToml);
      expect(regenerateDingRoot(dir)).not.toBeNull(); // first heal
      const healed = readFileSync(join(dir, "pty.toml"), "utf8");
      expect(regenerateDingRoot(dir)).toBeNull(); // already has --root
      expect(readFileSync(join(dir, "pty.toml"), "utf8")).toBe(healed); // unchanged
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dryRun computes the before/after WITHOUT writing the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "convoy-regen-dry-"));
    try {
      writeFileSync(join(dir, "pty.toml"), preToml);
      const r = regenerateDingRoot(dir, { dryRun: true });
      expect(r?.after).toContain("--root /net/convoy");
      expect(readFileSync(join(dir, "pty.toml"), "utf8")).toBe(preToml); // NOT written
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when there is no ding session to heal", () => {
    const dir = mkdtempSync(join(tmpdir(), "convoy-regen-noding-"));
    try {
      writeFileSync(join(dir, "pty.toml"), '[sessions.claude]\nid = "x"\ncommand = "exec claude"\n');
      expect(regenerateDingRoot(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
