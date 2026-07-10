import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentShort, isValidIdentity, preflight, sessionId, shortHostname, specPermanent, specPermissionMode, specPrefix, type AgentSpec } from "./agent-spec.ts";
import type { Role } from "./role.ts";

// Pin an EMPTY personas dir so persona resolution is deterministic (no real worker.md leaking in).
const saved = process.env["CONVOY_PERSONAS_DIR"];
let emptyDir: string;
beforeAll(() => {
  emptyDir = mkdtempSync(join(tmpdir(), "convoy-nospersona-"));
  process.env["CONVOY_PERSONAS_DIR"] = emptyDir;
});
afterAll(() => {
  rmSync(emptyDir, { recursive: true, force: true });
  if (saved === undefined) delete process.env["CONVOY_PERSONAS_DIR"];
  else process.env["CONVOY_PERSONAS_DIR"] = saved;
});

function spec(over: Partial<AgentSpec> = {}): AgentSpec {
  return {
    harness: "claude",
    role: "worker",
    identity: "wk1",
    transport: "ding",
    networkRoot: null,
    personaOverride: null,
    workingDir: null,
    permanentOverride: null,
    prefix: null,
    configDir: null,
    ...over,
  };
}
const derivedMap = (s: AgentSpec) => Object.fromEntries(preflight(s, []).derived);

describe("AgentSpec (ported from AgentSpecTests.swift)", () => {
  it("isValidIdentity: lowercase alnum + . _ -, starts alphanumeric", () => {
    for (const ok of ["convoy-claude", "app-web-claude", "build-wk.2", "a", "x_y.z-1"]) expect(isValidIdentity(ok)).toBe(true);
    for (const bad of ["-x", "Cap", "has space", "", ".dot", "a/b"]) expect(isValidIdentity(bad)).toBe(false);
  });

  it("permission-mode is bypassPermissions for EVERY role (interim posture); permanent derives from role", () => {
    for (const r of ["worker", "chief-of-staff", "supervisor", "technical-manager"] as Role[]) {
      expect(specPermissionMode(spec({ role: r }))).toBe("bypassPermissions");
    }
    expect(specPermanent(spec({ role: "worker" }))).toBe(false);
    expect(specPermanent(spec({ role: "chief-of-staff" }))).toBe(true);
  });

  it("session-id: <prefix>.<agentShort>; agentShort strips the harness suffix; prefix defaults to hostname", () => {
    expect(sessionId(spec({ identity: "convoy-claude", prefix: "silber" }))).toBe("silber.convoy");
    expect(sessionId(spec({ identity: "app-web-claude", prefix: "silber" }))).toBe("silber.app-web");
    expect(sessionId(spec({ identity: "bare", prefix: "h" }))).toBe("h.bare");
    expect(agentShort("cos-codex")).toBe("cos");
    expect(specPrefix(spec({ prefix: "custom" }))).toBe("custom");
    expect(specPrefix(spec({ prefix: null }))).toBe(shortHostname());
    expect(shortHostname()).toBe(shortHostname().toLowerCase()); // lowercased to match pty's id charset
  });

  it("--permanent override forces permanent (never forces role default OFF)", () => {
    expect(derivedMap(spec({ role: "worker", permanentOverride: true }))["permanent"]).toBe("yes");
    expect(derivedMap(spec({ role: "worker", permanentOverride: null }))["permanent"]).toBe("no");
    expect(derivedMap(spec({ role: "chief-of-staff", permanentOverride: null }))["permanent"]).toBe("yes");
  });

  it("derived wiring surfaces the correct-by-construction table", () => {
    const d = derivedMap(spec({ role: "worker", identity: "demo-wk", prefix: "host" }));
    expect(d["permission-mode"]).toBe("bypassPermissions");
    expect(d["session-id"]).toBe("host.demo-wk");
    expect(d["role"]).toBe("worker");
    expect(d["transport"]).toBe("ding");
    expect(d["identity"]).toBe("demo-wk");
  });

  it("codex is always ding-mode (mcp is ignored with a warning)", () => {
    const pf = preflight(spec({ harness: "codex", transport: "mcp" }), []);
    expect(Object.fromEntries(pf.derived)["transport"]).toBe("ding");
    expect(pf.warnings.join(" ")).toContain("codex");
  });

  it("preflight fails loud on invalid identity + duplicate", () => {
    expect(preflight(spec({ identity: "Bad Name" }), []).ok).toBe(false);
    expect(preflight(spec({ identity: "wk1" }), ["wk1"]).errors.join(" ")).toContain("already exists");
    expect(preflight(spec({ identity: "wk1" }), []).ok).toBe(true);
  });
});
