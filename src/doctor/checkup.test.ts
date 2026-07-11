import { describe, it, expect } from "vitest";
import { claudeCheckup, parseClaudeVersion, versionGte, type Runner } from "./checkup.ts";
import type { ExecResult } from "../exec.ts";

const exec = (over: Partial<ExecResult>): ExecResult => ({ status: 0, stdout: "", stderr: "", get ok() { return this.status === 0; }, ...over });

describe("parseClaudeVersion", () => {
  it("parses '2.1.207 (Claude Code)'", () => {
    expect(parseClaudeVersion("2.1.207 (Claude Code)")).toEqual({ major: 2, minor: 1, patch: 207 });
  });
  it("returns null when no x.y.z is present", () => {
    expect(parseClaudeVersion("unknown")).toBeNull();
  });
});

describe("versionGte", () => {
  it("compares major.minor.patch correctly", () => {
    expect(versionGte({ major: 2, minor: 1, patch: 207 }, { major: 2, minor: 1, patch: 205 })).toBe(true);
    expect(versionGte({ major: 2, minor: 1, patch: 205 }, { major: 2, minor: 1, patch: 205 })).toBe(true); // equal
    expect(versionGte({ major: 2, minor: 1, patch: 204 }, { major: 2, minor: 1, patch: 205 })).toBe(false);
    expect(versionGte({ major: 2, minor: 0, patch: 999 }, { major: 2, minor: 1, patch: 205 })).toBe(false);
    expect(versionGte({ major: 3, minor: 0, patch: 0 }, { major: 2, minor: 1, patch: 205 })).toBe(true);
  });
});

describe("claudeCheckup (injected runner — advisory, never throws)", () => {
  it("claude absent → state 'unavailable', a note, no text", async () => {
    const runner: Runner = async () => exec({ status: 127, stderr: "not found" });
    const r = await claudeCheckup(runner);
    expect(r.state).toBe("unavailable");
    expect(r.note).toMatch(/not found|install Claude Code/i);
    expect(r.text).toBeUndefined();
  });

  it("claude older than 2.1.205 → state 'too-old' with an upgrade note, does NOT run claude doctor", async () => {
    let ranDoctor = false;
    const runner: Runner = async (_cmd, args) => {
      if (args[0] === "doctor") ranDoctor = true;
      return exec({ stdout: "2.1.100 (Claude Code)" });
    };
    const r = await claudeCheckup(runner);
    expect(r.state).toBe("too-old");
    expect(r.note).toMatch(/2\.1\.205|upgrade/i);
    expect(ranDoctor).toBe(false); // version-gated before running doctor
  });

  it("claude >= 2.1.205 → runs claude doctor, returns its text + the in-session recommendation", async () => {
    const runner: Runner = async (_cmd, args) =>
      args[0] === "--version" ? exec({ stdout: "2.1.207 (Claude Code)" }) : exec({ stdout: "No installation issues found." });
    const r = await claudeCheckup(runner);
    expect(r.state).toBe("ran");
    expect(r.version).toBe("2.1.207"); // clean x.y.z, not the raw "(Claude Code)" suffix
    expect(r.text).toMatch(/No installation issues found/);
    expect(r.recommend).toMatch(/\/doctor|\/checkup/);
  });
});
