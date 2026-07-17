import { afterEach, describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { structureChecks } from "./structure.ts";
import { networkLayout } from "../paths.ts";
import { writeNetworkConfig } from "../network-config.ts";

function findCheck(checks: ReturnType<typeof structureChecks>, name: string) {
  return checks.find((c) => c.name === name);
}

describe("doctor structureChecks", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function net(): string {
    const d = mkdtempSync(join(tmpdir(), "convoy-struct-"));
    dirs.push(d);
    return join(d, "net");
  }
  function scaffold(dir: string): void {
    const l = networkLayout(dir);
    mkdirSync(l.stRoot, { recursive: true });
    mkdirSync(l.ptyRoot, { recursive: true });
    mkdirSync(l.worktrees, { recursive: true });
    writeNetworkConfig(dir, { name: "net" });
  }

  it("a fresh, correctly-structured network passes every check (per-agent checks vacuous)", () => {
    const dir = net();
    scaffold(dir);
    const checks = structureChecks(dir);
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(findCheck(checks, "named network")?.ok).toBe(true);
    expect(findCheck(checks, "host-prefixed bus folders")?.detail).toContain("fresh network");
  });

  it("missing config → named-network check fails with a fix", () => {
    const dir = net();
    const l = networkLayout(dir);
    mkdirSync(l.stRoot, { recursive: true });
    mkdirSync(l.ptyRoot, { recursive: true });
    mkdirSync(l.worktrees, { recursive: true }); // structure but NO convoy.toml
    const named = findCheck(structureChecks(dir), "named network")!;
    expect(named.ok).toBe(false);
    expect(named.fix).toContain("convoy init");
  });

  it("a non-host-prefixed bus folder fails the host-prefix check", () => {
    const dir = net();
    scaffold(dir);
    mkdirSync(join(networkLayout(dir).stRoot, "bareid"), { recursive: true }); // no '.' prefix
    const hp = findCheck(structureChecks(dir), "host-prefixed bus folders")!;
    expect(hp.ok).toBe(false);
    expect(hp.detail).toContain("bareid");
  });

  it("a --resume in a workspace pty.toml fails the cold-boot check", () => {
    const dir = net();
    scaffold(dir);
    const ws = join(networkLayout(dir).worktrees, "wk");
    mkdirSync(join(ws, ".convoy"), { recursive: true });
    writeFileSync(join(ws, ".convoy", "pty.toml"), 'command = "exec claude --resume 2A58"\n');
    const cb = findCheck(structureChecks(dir), "cold-boot (no --resume)")!;
    expect(cb.ok).toBe(false);
  });

  it("a dirty workspace fails the pristine check", () => {
    const dir = net();
    scaffold(dir);
    const ws = join(networkLayout(dir).worktrees, "wk");
    mkdirSync(ws, { recursive: true });
    execFileSync("git", ["init", "-q", ws]);
    writeFileSync(join(ws, "untracked.txt"), "leak\n"); // an untracked file → dirty
    const pristine = findCheck(structureChecks(dir), "pristine workspaces")!;
    expect(pristine.ok).toBe(false);
    expect(pristine.detail).toContain("DIRTY");
  });
});
