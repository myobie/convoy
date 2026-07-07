import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isValidIdentity, preflight, specPermanent, specPermissionMode, stLaunchArgs, type AgentSpec } from "./agent-spec.ts";
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
    ...over,
  };
}
const derivedMap = (s: AgentSpec) => Object.fromEntries(preflight(s, []).derived);

describe("AgentSpec (ported from AgentSpecTests.swift)", () => {
  it("isValidIdentity: lowercase alnum + . _ -, starts alphanumeric", () => {
    for (const ok of ["convoy-claude", "app-web-claude", "build-wk.2", "a", "x_y.z-1"]) expect(isValidIdentity(ok)).toBe(true);
    for (const bad of ["-x", "Cap", "has space", "", ".dot", "a/b"]) expect(isValidIdentity(bad)).toBe(false);
  });

  it("derives permission-mode + permanent from role", () => {
    expect(specPermissionMode(spec({ role: "worker" }))).toBe("auto");
    expect(specPermanent(spec({ role: "worker" }))).toBe(false);
    for (const r of ["chief-of-staff", "supervisor", "technical-manager"] as Role[]) {
      expect(specPermissionMode(spec({ role: r }))).toBe("bypassPermissions");
    }
    expect(specPermanent(spec({ role: "chief-of-staff" }))).toBe(true);
  });

  it("--permanent override forces permanent (never forces role default OFF)", () => {
    expect(derivedMap(spec({ role: "worker", permanentOverride: true }))["permanent"]).toBe("yes");
    expect(derivedMap(spec({ role: "worker", permanentOverride: null }))["permanent"]).toBe("no");
    expect(derivedMap(spec({ role: "chief-of-staff", permanentOverride: null }))["permanent"]).toBe("yes");
  });

  it("derived wiring surfaces the correct-by-construction table", () => {
    const d = derivedMap(spec({ role: "worker", identity: "demo-wk" }));
    expect(d["permission-mode"]).toBe("auto");
    expect(d["role"]).toBe("worker");
    expect(d["transport"]).toBe("ding");
    expect(d["identity"]).toBe("demo-wk");
  });

  it("codex is always ding-mode (mcp is ignored with a warning)", () => {
    const pf = preflight(spec({ harness: "codex", transport: "mcp" }), []);
    expect(Object.fromEntries(pf.derived)["transport"]).toBe("ding");
    expect(pf.warnings.join(" ")).toContain("codex");
  });

  it("stLaunchArgs derives the exact st launch argv", () => {
    expect(stLaunchArgs(spec({ role: "worker", identity: "wk1", transport: "ding" }), false)).toEqual([
      "launch", "claude", "--identity", "wk1", "--permission-mode", "auto", "--ding",
    ]);
    const cos = stLaunchArgs(spec({ role: "chief-of-staff", identity: "cos", transport: "ding" }), true);
    expect(cos).toContain("--permanent");
    expect(cos).toContain("bypassPermissions");
    expect(cos.at(-1)).toBe("--dry-run");
    expect(stLaunchArgs(spec({ personaOverride: "/tmp/p.md" }), false)).toContain("/tmp/p.md");
  });

  it("preflight fails loud on invalid identity + duplicate", () => {
    expect(preflight(spec({ identity: "Bad Name" }), []).ok).toBe(false);
    expect(preflight(spec({ identity: "wk1" }), ["wk1"]).errors.join(" ")).toContain("already exists");
    expect(preflight(spec({ identity: "wk1" }), []).ok).toBe(true);
  });
});
