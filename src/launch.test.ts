import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootPrompt, dingCommand, discoverSmalltalkDir, harnessCommand, regenerateDingRoot, writeAgentFiles, writeContextFiles, writePtyToml } from "./launch.ts";
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

  it("harnessCommand model: --model '<id>' inserted for claude + codex; omitted → byte-identical to today", () => {
    const prompt = bootPrompt("worker");
    // claude: after --permission-mode, single-quoted (shell-safe), before the boot prompt.
    expect(harnessCommand("claude", "bypassPermissions", prompt, "claude-fable-5")).toBe(
      `exec claude --permission-mode bypassPermissions --model 'claude-fable-5' '${prompt}'`,
    );
    // codex: after the bypass flag.
    expect(harnessCommand("codex", "bypassPermissions", prompt, "gpt-5")).toBe(
      `exec codex --dangerously-bypass-approvals-and-sandbox --model 'gpt-5' '${prompt}'`,
    );
    // BACKWARD-COMPAT: null/undefined model → exactly the no-model command (existing agents unaffected).
    expect(harnessCommand("claude", "bypassPermissions", prompt, null)).toBe(harnessCommand("claude", "bypassPermissions", prompt));
    expect(harnessCommand("codex", "bypassPermissions", prompt, undefined)).toBe(harnessCommand("codex", "bypassPermissions", prompt));
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
    model: null,
    bin: null,
    env: null,
    ...over,
  });

  it("pins ids to <prefix>.<agentShort> (+ .ding), cold-start command, no poker/resume", () => {
    const dir = mkdtempSync(join(tmpdir(), "convoy-ptytoml-"));
    try {
      writePtyToml(dir, spec());
      const toml = readFileSync(join(dir, ".convoy", "pty.toml"), "utf8");
      expect(toml).toContain('id = "silber.convoy"');
      expect(toml).toContain('id = "silber.convoy.ding"');
      expect(toml).toContain('prefix = "silber.convoy"');
      expect(toml).toContain("exec claude --permission-mode bypassPermissions");
      expect(toml).toContain("st ding silber.convoy --identity silber.convoy-claude"); // host-prefixed bus id
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
      const toml = readFileSync(join(dir, ".convoy", "pty.toml"), "utf8");
      // ding command carries --root (the bus root = <net>/smalltalk) so a pty-restart can't drop it
      expect(toml).toContain("st ding silber.convoy --identity silber.convoy-claude --root /net/convoy/smalltalk");
      // --root is a ding-only concern; the harness (claude) command must not get it
      expect(toml).not.toContain("exec claude --permission-mode bypassPermissions --root");
      // env carries ST_ROOT = the bus root (<net>/smalltalk), not the network dir
      expect(toml).toContain('ST_ROOT = "/net/convoy/smalltalk"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--config-dir sets CLAUDE_CONFIG_DIR on the HARNESS session env only, not the ding sidecar", () => {
    const dir = mkdtempSync(join(tmpdir(), "convoy-ptytoml-cfg-"));
    try {
      writePtyToml(dir, spec({ configDir: "/seeded/cfg" }));
      const toml = readFileSync(join(dir, ".convoy", "pty.toml"), "utf8");
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
      expect(readFileSync(join(dir, ".convoy", "pty.toml"), "utf8")).not.toContain("CLAUDE_CONFIG_DIR");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cos spec gets the first-run-interview boot prompt", () => {
    const dir = mkdtempSync(join(tmpdir(), "convoy-ptytoml-cos-"));
    try {
      writePtyToml(dir, spec({ role: "chief-of-staff", identity: "cos-claude" }));
      const toml = readFileSync(join(dir, ".convoy", "pty.toml"), "utf8");
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
      const toml = readFileSync(join(dir, ".convoy", "pty.toml"), "utf8");
      expect(toml).toContain("[sessions.codex]");
      expect(toml).toContain("exec codex --dangerously-bypass-approvals-and-sandbox");
      expect(toml).not.toContain("[sessions.claude]");
      expect(toml).not.toContain("exec claude");
      expect(toml).toContain('id = "silber.vauban"'); // agentShort strips the -codex suffix
      expect(toml).toContain("st ding silber.vauban --identity silber.vauban-codex"); // host-prefixed bus id
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("crash-ding tags: cos gets convoy.tier=cos + spawner gets convoy.spawner, on the HARNESS session only (not the ding)", () => {
    const dir = mkdtempSync(join(tmpdir(), "convoy-ptytoml-tags-"));
    try {
      // a worker spawned by a supervisor: convoy.spawner recorded, no convoy.tier (not cos)
      writePtyToml(dir, spec({ role: "worker", identity: "wk-claude" }), { spawner: "sup-claude" });
      const wkToml = readFileSync(join(dir, ".convoy", "pty.toml"), "utf8");
      expect(wkToml).toContain('"convoy.spawner" = "sup-claude"');
      expect(wkToml).not.toContain("convoy.tier");
      // the spawner tag is on the harness session, NOT the ding (else a crash double-dings the same busId)
      expect(wkToml.match(/convoy\.spawner/g)?.length).toBe(1);

      // the CoS: convoy.tier=cos stamped (the always-ding backstop)
      writePtyToml(dir, spec({ role: "chief-of-staff", identity: "cos-claude" }));
      const cosToml = readFileSync(join(dir, ".convoy", "pty.toml"), "utf8");
      expect(cosToml).toContain('"convoy.tier" = "cos"');
      expect(cosToml).not.toContain("convoy.spawner"); // no spawner passed

      // no spawner passed + not cos → neither tag (a human-spawned worker → cos-only ding downstream)
      writePtyToml(dir, spec({ role: "worker", identity: "wk2-claude" }));
      const plainToml = readFileSync(join(dir, ".convoy", "pty.toml"), "utf8");
      expect(plainToml).not.toContain("convoy.spawner");
      expect(plainToml).not.toContain("convoy.tier");
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

describe("discoverSmalltalkDir via ST_BIN (the off-PATH hooks discovery — Johannes false-negative)", () => {
  const savedSt = process.env["SMALLTALK_DIR"];
  const savedBin = process.env["ST_BIN"];
  afterEach(() => {
    if (savedSt === undefined) delete process.env["SMALLTALK_DIR"]; else process.env["SMALLTALK_DIR"] = savedSt;
    if (savedBin === undefined) delete process.env["ST_BIN"]; else process.env["ST_BIN"] = savedBin;
  });

  it("finds smalltalk from ST_BIN's grandparent even with SMALLTALK_DIR unset (hooks wired via ST_BIN, `st` off PATH)", () => {
    const dir = mkdtempSync(join(tmpdir(), "convoy-stbin-"));
    try {
      // A realistic smalltalk clone: bin/st + the hook scripts. ST_BIN points at the absolute st (as the agent
      // hook commands bake it); discovery must resolve <clone> from it, without SMALLTALK_DIR or `st` on PATH.
      mkdirSync(join(dir, "bin"), { recursive: true });
      writeFileSync(join(dir, "bin", "st"), "#!/bin/sh\n");
      mkdirSync(join(dir, "examples", "claude-code", "hooks"), { recursive: true });
      writeFileSync(join(dir, "examples", "claude-code", "hooks", "session-start.sh"), "#!/bin/sh\n");
      delete process.env["SMALLTALK_DIR"]; // force the ST_BIN path (SMALLTALK_DIR would short-circuit first)
      process.env["ST_BIN"] = join(dir, "bin", "st");
      // discovery canonicalizes via realpathSync (as the `which st` path always has), so compare to the real
      // path — on macOS mkdtemp's /var/... resolves to /private/var/... (the /var → /private/var symlink).
      expect(discoverSmalltalkDir()).toBe(realpathSync(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
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
      mkdirSync(join(dir, ".convoy"), { recursive: true });
      writeFileSync(join(dir, ".convoy", "pty.toml"), preToml);
      const r = regenerateDingRoot(dir);
      expect(r).not.toBeNull();
      expect(r?.before).toBe("st ding silber.evals --identity evals-claude");
      expect(r?.after).toBe("st ding silber.evals --identity evals-claude --root /net/convoy");
      const out = readFileSync(join(dir, ".convoy", "pty.toml"), "utf8");
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
      mkdirSync(join(dir, ".convoy"), { recursive: true });
      writeFileSync(join(dir, ".convoy", "pty.toml"), preToml);
      expect(regenerateDingRoot(dir)).not.toBeNull(); // first heal
      const healed = readFileSync(join(dir, ".convoy", "pty.toml"), "utf8");
      expect(regenerateDingRoot(dir)).toBeNull(); // already has --root
      expect(readFileSync(join(dir, ".convoy", "pty.toml"), "utf8")).toBe(healed); // unchanged
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dryRun computes the before/after WITHOUT writing the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "convoy-regen-dry-"));
    try {
      mkdirSync(join(dir, ".convoy"), { recursive: true });
      writeFileSync(join(dir, ".convoy", "pty.toml"), preToml);
      const r = regenerateDingRoot(dir, { dryRun: true });
      expect(r?.after).toContain("--root /net/convoy");
      expect(readFileSync(join(dir, ".convoy", "pty.toml"), "utf8")).toBe(preToml); // NOT written
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when there is no ding session to heal", () => {
    const dir = mkdtempSync(join(tmpdir(), "convoy-regen-noding-"));
    try {
      mkdirSync(join(dir, ".convoy"), { recursive: true });
      writeFileSync(join(dir, ".convoy", "pty.toml"), '[sessions.claude]\nid = "x"\ncommand = "exec claude"\n');
      expect(regenerateDingRoot(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("writeContextFiles — clean-worktree wiring (convoy must not dirty a repo it composes into)", () => {
  function makeSpec(dir: string, personaPath: string): AgentSpec {
    return {
      harness: "claude",
      role: "worker",
      identity: "wk-1",
      transport: "ding",
      networkRoot: null,
      personaOverride: personaPath,
      workingDir: dir,
      permanentOverride: null,
      prefix: null,
      configDir: null,
      model: null,
      bin: null,
      env: null,
    };
  }

  it("writes the overlay into .convoy/, wires @imports via .claude/rules/convoy.md, leaves the root pristine, and excludes both", () => {
    const dir = mkdtempSync(join(tmpdir(), "convoy-ctx-"));
    try {
      mkdirSync(join(dir, ".git", "info"), { recursive: true }); // pose as a git repo (no git binary needed)
      const personaPath = join(dir, "persona-src.md");
      writeFileSync(personaPath, "# worker persona\n");
      const trackedClaudeMd = "# Project CLAUDE.md\n\nsome existing project rules\n";
      writeFileSync(join(dir, "CLAUDE.md"), trackedClaudeMd);

      writeContextFiles(dir, makeSpec(dir, personaPath));

      // the tracked CLAUDE.md is untouched
      expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe(trackedClaudeMd);
      // the overlay content lives in .convoy/, NOT the repo root
      expect(readFileSync(join(dir, ".convoy", "PERSONA.md"), "utf8")).toBe("# worker persona\n");
      expect(existsSync(join(dir, ".convoy", "DING-BUS.md"))).toBe(true);
      // the root is pristine — no scattered convoy files (loader is a dot-dir file)
      expect(existsSync(join(dir, "PERSONA.md"))).toBe(false);
      expect(existsSync(join(dir, "CLAUDE.local.md"))).toBe(false);
      // the loader (.claude/rules/convoy.md) @imports the .convoy/ content (relative to the rules file)
      const loader = readFileSync(join(dir, ".claude", "rules", "convoy.md"), "utf8");
      expect(loader).toContain("@../../.convoy/PERSONA.md");
      expect(loader).toContain("@../../.convoy/DING-BUS.md");
      // both the .convoy/ overlay and the loader are kept out of git
      const exclude = readFileSync(join(dir, ".git", "info", "exclude"), "utf8");
      expect(exclude).toContain(".convoy/");
      expect(exclude).toContain(".claude/rules/convoy.md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is idempotent — a second run adds no duplicate imports, exclude entries, or marker", () => {
    const dir = mkdtempSync(join(tmpdir(), "convoy-ctx-idem-"));
    try {
      mkdirSync(join(dir, ".git", "info"), { recursive: true });
      const personaPath = join(dir, "persona-src.md");
      writeFileSync(personaPath, "# p\n");
      writeContextFiles(dir, makeSpec(dir, personaPath));
      writeContextFiles(dir, makeSpec(dir, personaPath));
      const loader = readFileSync(join(dir, ".claude", "rules", "convoy.md"), "utf8");
      expect(loader.match(/@\.\.\/\.\.\/\.convoy\/PERSONA\.md/g)?.length).toBe(1);
      expect(loader.match(/@\.\.\/\.\.\/\.convoy\/DING-BUS\.md/g)?.length).toBe(1);
      const exclude = readFileSync(join(dir, ".git", "info", "exclude"), "utf8");
      expect(exclude.match(/^\.convoy\/$/gm)?.length).toBe(1);
      expect(exclude.match(/^\.claude\/rules\/convoy\.md$/gm)?.length).toBe(1);
      expect(exclude.match(/agent context \(local/g)?.length).toBe(1); // single marker
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("append-only: preserves a user's existing .claude/rules/convoy.md content", () => {
    const dir = mkdtempSync(join(tmpdir(), "convoy-ctx-preexisting-"));
    try {
      mkdirSync(join(dir, ".claude", "rules"), { recursive: true });
      writeFileSync(join(dir, ".claude", "rules", "convoy.md"), "# my own note\nkeep me\n");
      const personaPath = join(dir, "persona-src.md");
      writeFileSync(personaPath, "# p\n");
      writeContextFiles(dir, makeSpec(dir, personaPath));
      const loader = readFileSync(join(dir, ".claude", "rules", "convoy.md"), "utf8");
      expect(loader).toContain("keep me"); // user content preserved
      expect(loader).toContain("@../../.convoy/PERSONA.md"); // convoy imports appended
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appends to a pre-existing .git/info/exclude instead of clobbering it", () => {
    const dir = mkdtempSync(join(tmpdir(), "convoy-ctx-preexc-"));
    try {
      mkdirSync(join(dir, ".git", "info"), { recursive: true });
      writeFileSync(join(dir, ".git", "info", "exclude"), "# user excludes\n*.log\n");
      const personaPath = join(dir, "persona-src.md");
      writeFileSync(personaPath, "# p\n");
      writeContextFiles(dir, makeSpec(dir, personaPath));
      const exclude = readFileSync(join(dir, ".git", "info", "exclude"), "utf8");
      expect(exclude).toContain("*.log"); // pre-existing content preserved
      expect(exclude).toContain(".convoy/"); // convoy entry appended
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("non-git dir: writes context files without crashing and never fabricates a .git", () => {
    const dir = mkdtempSync(join(tmpdir(), "convoy-ctx-nogit-"));
    try {
      const personaPath = join(dir, "persona-src.md");
      writeFileSync(personaPath, "# p\n");
      writeContextFiles(dir, makeSpec(dir, personaPath));
      expect(existsSync(join(dir, ".claude", "rules", "convoy.md"))).toBe(true);
      expect(existsSync(join(dir, ".git"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("convoy add clean-worktree — pty.toml + settings + context, EVERY authored file (#51 gap)", () => {
  function spec(dir: string, personaPath: string, networkRoot: string): AgentSpec {
    return {
      harness: "claude",
      role: "worker",
      identity: "wk-1",
      transport: "ding",
      networkRoot,
      personaOverride: personaPath,
      workingDir: dir,
      permanentOverride: null,
      prefix: null,
      configDir: null,
      model: null,
      bin: null,
      env: null,
    };
  }

  it("writePtyToml keeps pty.toml out of git status via .git/info/exclude", () => {
    const dir = mkdtempSync(join(tmpdir(), "convoy-ptyexc-"));
    try {
      mkdirSync(join(dir, ".git", "info"), { recursive: true }); // pose as a git repo (no git binary needed)
      writePtyToml(dir, spec(dir, join(dir, "p.md"), join(dir, ".net")), { spawner: null });
      expect(existsSync(join(dir, ".convoy", "pty.toml"))).toBe(true);
      expect(readFileSync(join(dir, ".git", "info", "exclude"), "utf8")).toContain(".convoy/");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The acceptance cos asked for, updated for the .convoy/ layout: compose an agent into a CLEAN git
  // repo, assert `git status --porcelain` is EMPTY (the whole .convoy/ overlay — PERSONA.md, DING-BUS.md,
  // pty.toml — plus root CLAUDE.local.md + .claude/settings.local.json are excluded, tracked CLAUDE.md
  // untouched, and the product-repo ROOT is pristine — no PERSONA.md/DING-BUS.md/pty.toml at the root).
  it("acceptance: writeAgentFiles leaves a clean repo — git status --porcelain is empty", () => {
    const savedSt = process.env["SMALLTALK_DIR"];
    const repo = mkdtempSync(join(tmpdir(), "convoy-clean-repo-"));
    const stub = mkdtempSync(join(tmpdir(), "convoy-st-stub-"));
    const personaDir = mkdtempSync(join(tmpdir(), "convoy-persona-"));
    const netRoot = mkdtempSync(join(tmpdir(), "convoy-net-"));
    try {
      // stub SMALLTALK_DIR so writeHooks' hookRefs resolves (it gates on this hook script existing)
      mkdirSync(join(stub, "examples", "claude-code", "hooks"), { recursive: true });
      writeFileSync(join(stub, "examples", "claude-code", "hooks", "session-start.sh"), "#!/bin/sh\n");
      process.env["SMALLTALK_DIR"] = stub;
      // persona source lives OUTSIDE the repo (only its copy, PERSONA.md, lands in the repo → excluded)
      const persona = join(personaDir, "worker.md");
      writeFileSync(persona, "# worker persona\n");
      // a real git repo, clean, with a committed CLAUDE.md
      const git = (...a: string[]): void => void execFileSync("git", a, { cwd: repo });
      git("init", "-q");
      git("config", "user.email", "t@t");
      git("config", "user.name", "t");
      writeFileSync(join(repo, "CLAUDE.md"), "# project rules\n");
      git("add", "-A");
      git("commit", "-qm", "init");
      // compose the agent in
      writeAgentFiles(repo, spec(repo, persona, netRoot));
      // convoy really did write its files — into .convoy/ + the .claude/ dot-dir…
      expect(existsSync(join(repo, ".convoy", "pty.toml"))).toBe(true);
      expect(existsSync(join(repo, ".convoy", "PERSONA.md"))).toBe(true);
      expect(existsSync(join(repo, ".convoy", "DING-BUS.md"))).toBe(true);
      expect(existsSync(join(repo, ".claude", "rules", "convoy.md"))).toBe(true);
      expect(existsSync(join(repo, ".claude", "settings.local.json"))).toBe(true);
      // …the product-repo ROOT is pristine — ZERO visible convoy files at the root…
      expect(existsSync(join(repo, "pty.toml"))).toBe(false);
      expect(existsSync(join(repo, "PERSONA.md"))).toBe(false);
      expect(existsSync(join(repo, "DING-BUS.md"))).toBe(false);
      expect(existsSync(join(repo, "CLAUDE.local.md"))).toBe(false);
      // …and the tracked CLAUDE.md is untouched
      expect(readFileSync(join(repo, "CLAUDE.md"), "utf8")).toBe("# project rules\n");
      // THE acceptance: the worktree is clean
      expect(execFileSync("git", ["status", "--porcelain"], { cwd: repo }).toString()).toBe("");
    } finally {
      if (savedSt === undefined) delete process.env["SMALLTALK_DIR"];
      else process.env["SMALLTALK_DIR"] = savedSt;
      for (const d of [repo, stub, personaDir, netRoot]) rmSync(d, { recursive: true, force: true });
    }
  });
});
