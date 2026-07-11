import { describe, it, expect } from "vitest";
import { gitUsableCheck, nodeVersionCheck, osCheck, tmpdirSocketCheck } from "./env.ts";
import type { ExecResult } from "../exec.ts";

const exec = (over: Partial<ExecResult>): ExecResult => ({ status: 0, stdout: "", stderr: "", get ok() { return this.status === 0; }, ...over });

describe("nodeVersionCheck", () => {
  it("passes ≥ 23.6", () => {
    expect(nodeVersionCheck("v23.6.0").ok).toBe(true);
    expect(nodeVersionCheck("v24.1.0").ok).toBe(true);
    expect(nodeVersionCheck("v23.10.0").ok).toBe(true); // minor 10 > 6
  });
  it("fails < 23.6 with an upgrade fix", () => {
    const o = nodeVersionCheck("v23.5.0");
    expect(o.ok).toBe(false);
    expect(o.fix).toMatch(/upgrade Node/i);
    expect(nodeVersionCheck("v22.14.0").ok).toBe(false);
  });
  it("unrecognized version → informational, not a crash", () => {
    expect(nodeVersionCheck("weird").ok).toBeNull();
  });
});

describe("gitUsableCheck (injected runner)", () => {
  it("passes when git --version works", async () => {
    const o = await gitUsableCheck(async () => exec({ stdout: "git version 2.44.0" }));
    expect(o.ok).toBe(true);
  });
  it("fails when git is absent/unusable, with an install fix", async () => {
    const o = await gitUsableCheck(async () => exec({ status: 127, stderr: "command not found" }));
    expect(o.ok).toBe(false);
    expect(o.fix).toMatch(/install git/i);
  });
});

describe("tmpdirSocketCheck", () => {
  it("passes for a short temp dir", () => {
    expect(tmpdirSocketCheck("/tmp").ok).toBe(true);
  });
  it("fails for a temp dir long enough to blow the socket budget", () => {
    const o = tmpdirSocketCheck("/var/folders/aa/bbbbbbbbbbbbbbbbbbbbbbbb/T/some/extra/deep/nesting/here");
    expect(o.ok).toBe(false);
    expect(o.fix).toMatch(/TMPDIR/);
  });
});

describe("osCheck", () => {
  it("macOS + Linux are informational (ok:null), never fail the gate", () => {
    expect(osCheck("darwin").ok).toBeNull();
    expect(osCheck("linux").ok).toBeNull();
  });
  it("an unsupported platform fails", () => {
    expect(osCheck("win32").ok).toBe(false);
  });
});
