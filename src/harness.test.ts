// The harness table + what widening it actually buys. Two groups here, and they are NOT the same kind of
// test:
//
//   - Tests marked LOCK pass on main already. They pin behavior that was reported missing but turned out
//     to be present, so the next refactor cannot quietly remove it. They are not evidence of a fix.
//   - Every other test FAILS on main. Each one is a defect this change closes.

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentFileToSpec, parseAgentFile } from "./agent-file.ts";
import { harnessCommand, writePtyToml } from "./launch.ts";
import { HARNESSES, HARNESS_SESSION_KEYS, HARNESS_SUFFIX_RE, harnessDescriptor, harnessesInPtyToml, harnessLimitations, isHarness } from "./harness.ts";
import { agentShort } from "./agent-spec.ts";
import { codexConfigPath, pretrustDirsCodex } from "./trust.ts";
import type { AgentSpec } from "./agent-spec.ts";

const MIN = `identity = "a"\nrole = "worker"\nsupervisor = "root"\n`;
const tmp = () => mkdtempSync(join(tmpdir(), "cv-h-"));

function spec(over: Partial<AgentSpec> = {}): AgentSpec {
  return {
    harness: "claude",
    role: "worker",
    identity: "a",
    supervisor: null,
    transport: "ding",
    networkRoot: null,
    personaOverride: null,
    workingDir: null,
    permanentOverride: null,
    prefix: "p",
    configDir: null,
    model: null,
    bin: null,
    env: null,
    ...over,
  };
}

/** The harness session's env block out of a rendered pty.toml. */
function harnessEnv(s: AgentSpec): Record<string, string> {
  const dir = tmp();
  writePtyToml(dir, s);
  const toml = readFileSync(join(dir, ".convoy", "pty.toml"), "utf8");
  const key = harnessDescriptor(s.harness).sessionKey;
  const block = toml.split(`[sessions.${key}.env]`)[1]?.split("\n[")[0] ?? "";
  return Object.fromEntries(
    block
      .split("\n")
      .map((l) => l.match(/^(\w+) = "(.*)"$/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => [m[1]!, m[2]!]),
  );
}

// ---------------------------------------------------------------------------
// Gap 1 — credential selection for a harness that is not claude
// ---------------------------------------------------------------------------

describe("credential selection is per-harness, not claude-shaped", () => {
  // LOCK — passes on main. The reported gap ("a codex agent has no way to select an account") was already
  // closed for the DECLARATIVE path by the verbatim `env` spread. Pinned so it stays closed.
  it("LOCK: a codex agent file's CODEX_HOME reaches the launched session, and not the ding sidecar", () => {
    const af = parseAgentFile(`${MIN}harness = "codex"\n[env]\nCODEX_HOME = "/home/u/.codex-alt"\n`);
    const dir = tmp();
    writePtyToml(dir, agentFileToSpec(af, { networkRoot: null }));
    const toml = readFileSync(join(dir, ".convoy", "pty.toml"), "utf8");

    expect(toml).toContain('CODEX_HOME = "/home/u/.codex-alt"');
    // Exactly once: the harness session. The ding sidecar is `st ding` and must not carry credentials.
    expect(toml.match(/CODEX_HOME/g)?.length).toBe(1);
    expect(toml.split("[sessions.ding.env]")[1] ?? "").not.toContain("CODEX_HOME");
  });

  // FAILS ON MAIN: `configDir` was injected as the literal `CLAUDE_CONFIG_DIR` regardless of harness, so
  // `--config-dir` on a codex session set a variable codex does not read. The flag reported success and
  // selected nothing — the failure mode is a session silently running as the WRONG ACCOUNT.
  it("--config-dir on a codex session sets CODEX_HOME, never CLAUDE_CONFIG_DIR", () => {
    const env = harnessEnv(spec({ harness: "codex", configDir: "/home/u/.codex-alt" }));
    expect(env["CODEX_HOME"]).toBe("/home/u/.codex-alt");
    expect(env["CLAUDE_CONFIG_DIR"]).toBeUndefined();
  });

  it("--config-dir on a claude session still sets CLAUDE_CONFIG_DIR (unchanged)", () => {
    const env = harnessEnv(spec({ harness: "claude", configDir: "/home/u/.claude-alt" }));
    expect(env["CLAUDE_CONFIG_DIR"]).toBe("/home/u/.claude-alt");
    expect(env["CODEX_HOME"]).toBeUndefined();
  });

  // FAILS ON MAIN: agentFileToSpec read `env["CLAUDE_CONFIG_DIR"]` unconditionally, so a codex spec's
  // CODEX_HOME never became `configDir` — which is what pre-trust keys on. The env var reached the
  // process (see the LOCK test) but convoy did not KNOW the config was relocated.
  it("a codex spec's CODEX_HOME is lifted to configDir, so convoy knows the config moved", () => {
    const af = parseAgentFile(`${MIN}harness = "codex"\n[env]\nCODEX_HOME = "/home/u/.codex-alt"\n`);
    expect(agentFileToSpec(af, { networkRoot: null }).configDir).toBe("/home/u/.codex-alt");
  });

  it("a claude spec still lifts CLAUDE_CONFIG_DIR, and does not read the other harness's var", () => {
    const af = parseAgentFile(`${MIN}[env]\nCLAUDE_CONFIG_DIR = "/home/u/.claude-alt"\nCODEX_HOME = "/nope"\n`);
    expect(agentFileToSpec(af, { networkRoot: null }).configDir).toBe("/home/u/.claude-alt");
  });

  // FAILS ON MAIN: codexConfigPath() took no argument and always returned ~/.codex/config.toml, so a codex
  // agent under a relocated CODEX_HOME had its workspace trusted in a file it never opens. codex's
  // --dangerously-bypass flag does NOT skip the directory-trust prompt, so the symptom is not an error —
  // it is an unattended agent parked on a dialog nobody is watching.
  it("codex trust is seeded in the RELOCATED config, not the ambient one", () => {
    const home = tmp();
    const ws = tmp();
    pretrustDirsCodex([ws], home);

    expect(codexConfigPath(home)).toBe(join(home, "config.toml"));
    expect(readFileSync(join(home, "config.toml"), "utf8")).toContain(`trust_level = "trusted"`);
  });

  it("codexConfigPath with no relocation is unchanged (ambient ~/.codex)", () => {
    expect(codexConfigPath()).toMatch(/\.codex\/config\.toml$/);
  });

  // Spec `env` must stay UNDER derived wiring — a declared key cannot repoint an agent at another bus.
  it("LOCK: derived bus wiring still outranks a declared env key", () => {
    const env = harnessEnv(spec({ harness: "codex", env: { ST_AGENT: "someone.else", CODEX_HOME: "/h" } }));
    expect(env["ST_AGENT"]).toBe("p.a");
    expect(env["CODEX_HOME"]).toBe("/h");
  });
});

// ---------------------------------------------------------------------------
// Gap 2 — the harness union
// ---------------------------------------------------------------------------

describe("the harness union admits the harnesses the fleet actually runs", () => {
  // FAILS ON MAIN: the union was claude|codex, so these could not be declared at all.
  it("opencode and pi are declarable in an agent file", () => {
    for (const h of ["opencode", "pi"] as const) {
      expect(agentFileToSpec(parseAgentFile(`${MIN}harness = "${h}"\n`), { networkRoot: null }).harness).toBe(h);
    }
  });

  it("an unknown harness is still refused, and the message lists the real set", () => {
    expect(() => parseAgentFile(`${MIN}harness = "gemini"\n`)).toThrow(/claude \| codex \| opencode \| pi/);
    expect(isHarness("gemini")).toBe(false);
  });

  // FAILS ON MAIN. This is the test that decides gap 2, and the reason `bin` alone could not close it.
  //
  // opencode's POSITIONAL argument is a project path, not a prompt. Under the old "point `bin` at it and
  // keep the nearest flavor" advice, a boot prompt would have been handed to opencode as a DIRECTORY to
  // start in — and `--permission-mode` / `--dangerously-bypass-approvals-and-sandbox`, which opencode
  // does not accept, would have been passed too. That is not a degraded session; it is a nonsense one.
  it("opencode gets its prompt via --prompt, never as the positional project path", () => {
    const c = harnessCommand("opencode", "bypassPermissions", "BOOT");
    expect(c).toBe("exec opencode --auto --prompt 'BOOT'");
    expect(c).not.toContain("--permission-mode");
    expect(c).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("pi takes its prompt positionally and uses its own trust flag", () => {
    const c = harnessCommand("pi", "bypassPermissions", "BOOT");
    expect(c).toBe("exec pi --approve 'BOOT'");
    expect(c).not.toContain("--permission-mode");
  });

  it("claude and codex command derivation is byte-identical to before", () => {
    expect(harnessCommand("claude", "bypassPermissions", "BOOT")).toBe("exec claude --permission-mode bypassPermissions 'BOOT'");
    expect(harnessCommand("codex", "bypassPermissions", "BOOT")).toBe("exec codex --dangerously-bypass-approvals-and-sandbox 'BOOT'");
    expect(harnessCommand("claude", "bypassPermissions", "BOOT", "m-1")).toBe("exec claude --permission-mode bypassPermissions --model 'm-1' 'BOOT'");
    expect(harnessCommand("codex", "bypassPermissions", "BOOT", "m-1")).toBe("exec codex --dangerously-bypass-approvals-and-sandbox --model 'm-1' 'BOOT'");
  });

  it("bin still replaces only the binary, for every harness", () => {
    expect(harnessCommand("opencode", "bypassPermissions", "BOOT", null, "/opt/oc")).toBe("exec /opt/oc --auto --prompt 'BOOT'");
    expect(harnessCommand("pi", "bypassPermissions", "BOOT", null, "/opt/pi")).toBe("exec /opt/pi --approve 'BOOT'");
  });

  // FAILS ON MAIN: HARNESS_SESSION_KEY was a two-member record, so there was no session key for these.
  it("each harness renders its own pty.toml session section", () => {
    for (const h of HARNESSES) {
      const dir = tmp();
      writePtyToml(dir, spec({ harness: h }));
      expect(readFileSync(join(dir, ".convoy", "pty.toml"), "utf8")).toContain(`[sessions.${h}]`);
    }
  });
});

// ---------------------------------------------------------------------------
// Partial citizenship — a limitation must be declared, not discovered
// ---------------------------------------------------------------------------

describe("a harness declares what it does NOT support", () => {
  // The honest core of this change: opencode and pi launch, but convoy cannot select an account for them
  // (neither has a config-relocation variable), cannot check them, and cannot probe their auth.
  it("opencode and pi have no account selection, no doctor, and no auth probe", () => {
    for (const h of ["opencode", "pi"] as const) {
      const d = harnessDescriptor(h);
      expect(d.configEnv).toBeNull();
      expect(d.supportsDoctor).toBe(false);
      expect(d.supportsAuth).toBe(false);
      expect(harnessLimitations(h)).toContain("no account selection (the harness has no config-relocation env var)");
    }
  });

  it("claude and codex remain full citizens", () => {
    expect(harnessDescriptor("claude").configEnv).toBe("CLAUDE_CONFIG_DIR");
    expect(harnessDescriptor("codex").configEnv).toBe("CODEX_HOME");
    for (const h of ["claude", "codex"] as const) {
      expect(harnessDescriptor(h).supportsDoctor).toBe(true);
      expect(harnessDescriptor(h).supportsAuth).toBe(true);
    }
  });

  // A configDir on a harness with no config var must be DROPPED, not injected under some guessed name.
  // (The CLI refuses it outright; this pins the launch layer so the two cannot disagree.)
  it("a configDir on opencode/pi injects nothing rather than guessing a variable", () => {
    for (const h of ["opencode", "pi"] as const) {
      const env = harnessEnv(spec({ harness: h, configDir: "/home/u/whatever" }));
      expect(env["CLAUDE_CONFIG_DIR"]).toBeUndefined();
      expect(env["CODEX_HOME"]).toBeUndefined();
      expect(Object.keys(env)).toEqual(["ST_AGENT"]);
    }
  });

  it("a harness without MCP is coerced to the ding sidecar", () => {
    for (const h of HARNESSES) {
      const dir = tmp();
      writePtyToml(dir, spec({ harness: h, transport: "mcp" }));
      const toml = readFileSync(join(dir, ".convoy", "pty.toml"), "utf8");
      expect(toml.includes("[sessions.ding]")).toBe(!harnessDescriptor(h).supportsMcp);
    }
  });
});

// ---------------------------------------------------------------------------
// Operability — a declared agent must also be RECOGNISABLE to the other verbs
// ---------------------------------------------------------------------------

// These sites are plain string literals with no type coupling, so neither tsc nor the launch tests catch
// them. They are what decides whether a new harness is genuinely operable or merely launchable: they back
// `convoy ls` (what harnesses does this network run?), `convoy remove`, and `convoy down` (which sessions
// belong to this agent?). All FAIL ON MAIN for opencode/pi — main hardcodes /claude|codex/ at each one,
// so an opencode agent would be reported as claude and missed by identity matching at teardown.
describe("a declared agent is recognisable to the verbs that manage it", () => {
  it("a rendered manifest is recognised as its OWN harness, not defaulted to claude", () => {
    for (const h of HARNESSES) {
      const dir = tmp();
      writePtyToml(dir, spec({ harness: h }));
      const toml = readFileSync(join(dir, ".convoy", "pty.toml"), "utf8");
      expect(harnessesInPtyToml(toml)).toEqual([h]);
    }
  });

  it("the session-key list covers every harness, so identity matching cannot miss one", () => {
    expect([...HARNESS_SESSION_KEYS].sort()).toEqual([...HARNESSES].sort());
    // The shape `convoy remove` / `convoy down` match on: `<identity>-<sessionKey>`.
    for (const h of HARNESSES) {
      expect([...HARNESS_SESSION_KEYS, "ding"].some((suf) => `alpha-${suf}` === `alpha-${h}`)).toBe(true);
    }
  });

  it("the harness suffix is stripped for every harness, not just claude/codex", () => {
    for (const h of HARNESSES) {
      expect(agentShort(`alpha-${h}`)).toBe("alpha");
      expect(HARNESS_SUFFIX_RE.test(`alpha-${h}`)).toBe(true);
    }
    expect(agentShort("alpha-gemini")).toBe("alpha-gemini");
  });
});
