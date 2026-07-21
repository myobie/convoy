import { describe, expect, it } from "vitest";
import { agentFileToSpec, agentFileToToml, isValidBin, parseAgentFile } from "./agent-file.ts";
import { harnessCommand } from "./launch.ts";

const MIN = `identity = "fabric"\nrole = "worker"\nsupervisor = "cos"\n`;

describe("the spec's agent-level fields", () => {
  it("parses supervisor, prefix, bin, and env", () => {
    const af = parseAgentFile(`${MIN}prefix = "silber"\nbin = "/opt/wrap/claude"\n[env]\nCODEX_HOME = "$HOME/.codex-fabric"\n`);
    expect(af.supervisor).toBe("cos");
    expect(af.prefix).toBe("silber");
    expect(af.bin).toBe("/opt/wrap/claude");
    expect(af.env?.["CODEX_HOME"]).toBe("$HOME/.codex-fabric");
  });

  it("carries pty task blocks — the agent is the job, its ptys are the tasks", () => {
    const af = parseAgentFile(`${MIN}[pty.agent]\ncommand = "exec claude"\nkeep = true\n[pty.agent.env]\nST_AGENT = "silber.fabric"\n[pty.ding]\ncommand = "st ding silber.fabric"\n`);
    expect(Object.keys(af.pty ?? {}).sort()).toEqual(["agent", "ding"]);
    expect(af.pty?.["agent"]?.command).toBe("exec claude");
    expect(af.pty?.["agent"]?.keep).toBe(true);
    expect(af.pty?.["agent"]?.env?.["ST_AGENT"]).toBe("silber.fabric");
  });

  it("reads render.file as a list whether written once or many times", () => {
    const one = parseAgentFile(`${MIN}[[render.file]]\ndest = ".claude/skills/t/SKILL.md"\nfrom = "skills/t.md"\nmode = "0644"\n`);
    expect(one.render?.file).toEqual([{ dest: ".claude/skills/t/SKILL.md", from: "skills/t.md", mode: "0644" }]);
    const many = parseAgentFile(`${MIN}[[render.file]]\ndest = "a"\nfrom = "x"\n[[render.file]]\ndest = "b"\nfrom = "y"\n`);
    expect(many.render?.file).toHaveLength(2);
  });

  it("validates the supervisor as an identity — a typo'd one silently orphans the escalation path", () => {
    expect(() => parseAgentFile(`identity = "fabric"\nrole = "worker"\nsupervisor = "co_s"\n`)).toThrow(/invalid `supervisor`/);
  });

  it("rejects an identity the bus would reject, at parse time", () => {
    expect(() => parseAgentFile(`identity = "worker_fodfix"\nrole = "worker"\n`)).toThrow(/worker-fodfix/);
  });

  it("round-trips the new fields through the TOML writer", () => {
    const af = parseAgentFile(`${MIN}bin = "/opt/wrap/claude"\nprefix = "silber"\n[env]\nCLAUDE_CONFIG_DIR = "$HOME/.claude-fabric"\n`);
    const again = parseAgentFile(agentFileToToml(af));
    expect(again).toEqual(af);
  });
});

describe("bin — deployments that wrap their harness are not bypassed", () => {
  it("replaces the binary while keeping every derived flag", () => {
    const withBin = harnessCommand("claude", "bypassPermissions", "boot", null, "/opt/wrap/claude");
    expect(withBin).toBe("exec /opt/wrap/claude --permission-mode bypassPermissions 'boot'");
    // Without it, today's behavior is unchanged.
    expect(harnessCommand("claude", "bypassPermissions", "boot", null, null)).toBe("exec claude --permission-mode bypassPermissions 'boot'");
  });

  it("applies to codex too, keeping the codex flag shape", () => {
    expect(harnessCommand("codex", "x", "boot", null, "/opt/wrap/codex")).toBe("exec /opt/wrap/codex --dangerously-bypass-approvals-and-sandbox 'boot'");
  });

  it("refuses a bin that could break out of the `sh -c` launch string", () => {
    for (const b of ["claude; rm -rf /", "cl aude", "$(evil)", "`evil`", "a'b", 'a"b', "a|b", ""]) {
      expect(isValidBin(b), b).toBe(false);
    }
    for (const b of ["claude", "/opt/wrap/claude", "claude-wrapper.sh", "my_wrap"]) {
      expect(isValidBin(b), b).toBe(true);
    }
  });

  it("flows from the spec through to the launch spec", () => {
    const af = parseAgentFile(`${MIN}bin = "/opt/wrap/claude"\n`);
    expect(agentFileToSpec(af, { networkRoot: null }).bin).toBe("/opt/wrap/claude");
  });
});

describe("credentials ride in env — there is no account field", () => {
  it("derives CLAUDE_CONFIG_DIR from env rather than a second field that could disagree", () => {
    const af = parseAgentFile(`${MIN}[env]\nCLAUDE_CONFIG_DIR = "$HOME/.claude-fabric"\n`);
    const spec = agentFileToSpec(af, { networkRoot: null });
    expect(spec.configDir).toBe("$HOME/.claude-fabric");
    expect(spec.env?.["CLAUDE_CONFIG_DIR"]).toBe("$HOME/.claude-fabric");
  });

  it("keeps credential selection $HOME-relative so a spec stays machine-agnostic", () => {
    const af = parseAgentFile(`${MIN}[env]\nCODEX_HOME = "$HOME/.codex-fabric"\n`);
    expect(af.env?.["CODEX_HOME"]?.startsWith("$HOME/")).toBe(true);
  });
});

describe("render blocks in both published spellings", () => {
  it("reads the KDL form, where dest is a positional argument", () => {
    const af = parseAgentFile(
      `agent "fabric" {\n  role "worker"\n  supervisor "cos"\n  render {\n    file ".claude/skills/triage/SKILL.md" from="skills/triage.md"\n    file ".claude/hooks/pre-tool.sh" from="hooks/pre-tool.sh" mode="0755"\n    dir ".claude/hooks" from="hooks/"\n  }\n}`,
      "kdl",
    );
    expect(af.render?.file).toEqual([
      { dest: ".claude/skills/triage/SKILL.md", from: "skills/triage.md" },
      { dest: ".claude/hooks/pre-tool.sh", from: "hooks/pre-tool.sh", mode: "0755" },
    ]);
    expect(af.render?.dir).toEqual([{ dest: ".claude/hooks", from: "hooks/" }]);
  });
});
