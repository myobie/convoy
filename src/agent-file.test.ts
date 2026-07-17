import { describe, it, expect } from "vitest";
import { agentFilePath, agentFileToSpec, agentFileToToml, catalogDir, parseAgentFile, type AgentFile } from "./agent-file.ts";

describe("parseAgentFile — schema + validation", () => {
  it("parses a full agent file", () => {
    const af = parseAgentFile(`
identity  = "convoy-claude"
role      = "worker"
host      = "silber"
workspace = "/repos/convoy"
harness   = "codex"
transport = "mcp"
persona   = "/p/specialist.md"
strategy  = "permanent"
`);
    expect(af).toEqual({
      identity: "convoy-claude",
      role: "worker",
      host: "silber",
      workspace: "/repos/convoy",
      harness: "codex",
      transport: "mcp",
      persona: "/p/specialist.md",
      strategy: "permanent",
    } satisfies AgentFile);
  });

  it("the minimal file is just identity + role (everything else optional)", () => {
    expect(parseAgentFile(`identity = "wk"\nrole = "worker"\n`)).toEqual({ identity: "wk", role: "worker" });
  });

  it("throws on a missing required field", () => {
    expect(() => parseAgentFile(`role = "worker"\n`)).toThrow(/identity/);
    expect(() => parseAgentFile(`identity = "wk"\n`)).toThrow(/role/);
  });

  it("throws on a bad enum (role / harness / transport / strategy)", () => {
    expect(() => parseAgentFile(`identity="w"\nrole="boss"\n`)).toThrow(/role/);
    expect(() => parseAgentFile(`identity="w"\nrole="worker"\nharness="vim"\n`)).toThrow(/harness/);
    expect(() => parseAgentFile(`identity="w"\nrole="worker"\ntransport="carrier-pigeon"\n`)).toThrow(/transport/);
    expect(() => parseAgentFile(`identity="w"\nrole="worker"\nstrategy="ephemeral"\n`)).toThrow(/strategy/);
  });

  it("keeps forward-compat fields (tier, env) without materializing them", () => {
    const af = parseAgentFile(`identity="w"\nrole="chief-of-staff"\ntier="cos"\n[env]\nFOO="bar"\n`);
    expect(af.tier).toBe("cos");
    expect(af.env).toEqual({ FOO: "bar" });
  });
});

describe("agentFileToSpec — compile intent → AgentSpec", () => {
  const base: AgentFile = { identity: "wk", role: "worker" };

  it("applies defaults (harness=claude, transport=ding, prefix=null → this host)", () => {
    const s = agentFileToSpec(base, { networkRoot: "/net" });
    expect(s.harness).toBe("claude");
    expect(s.transport).toBe("ding");
    expect(s.prefix).toBe(null);
    expect(s.personaOverride).toBe(null);
    expect(s.permanentOverride).toBe(null);
    expect(s.networkRoot).toBe("/net");
    expect(s.identity).toBe("wk");
    expect(s.role).toBe("worker");
  });

  it("maps host → prefix, persona → personaOverride, strategy=permanent → permanentOverride", () => {
    const s = agentFileToSpec({ ...base, host: "boxb", persona: "/p.md", strategy: "permanent" }, { networkRoot: "/net" });
    expect(s.prefix).toBe("boxb");
    expect(s.personaOverride).toBe("/p.md");
    expect(s.permanentOverride).toBe(true);
  });

  it("workspace: the --dir override wins over the file's workspace", () => {
    expect(agentFileToSpec({ ...base, workspace: "/from-file" }, { networkRoot: null }).workingDir).toBe("/from-file");
    expect(agentFileToSpec({ ...base, workspace: "/from-file" }, { networkRoot: null, workspace: "/override" }).workingDir).toBe("/override");
    expect(agentFileToSpec(base, { networkRoot: null }).workingDir).toBe(null);
  });
});

describe("agentFileToToml — serialize (what convoy add authors)", () => {
  it("round-trips through parse: write then read yields the same AgentFile", () => {
    const af: AgentFile = { identity: "cos-claude", role: "chief-of-staff", host: "silber", workspace: "/repos/cos", harness: "codex", transport: "mcp", persona: "/p.md", strategy: "permanent" };
    expect(parseAgentFile(agentFileToToml(af))).toEqual(af);
  });

  it("emits only SET fields (minimal file)", () => {
    const toml = agentFileToToml({ identity: "wk", role: "worker" });
    expect(toml).toContain('identity = "wk"');
    expect(toml).toContain('role = "worker"');
    expect(toml).not.toMatch(/host|workspace|harness|transport|persona|strategy/);
  });
});

describe("catalog paths", () => {
  it("catalogDir + agentFilePath", () => {
    expect(catalogDir("/net")).toBe("/net/catalog");
    expect(agentFilePath("/net/catalog", "cos-claude")).toBe("/net/catalog/cos-claude.toml");
  });
});
