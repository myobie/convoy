import { describe, it, expect } from "vitest";
import { crashDingTargets, workerCrashed } from "./up.ts";
import type { SupervisedSession } from "./host.ts";

const sess = (name: string, tags: Record<string, string>): SupervisedSession => ({ name, cwd: null, command: "", args: [], status: "running" as never, exitedAt: null, exitCode: null, tags });
// Test resolver: read the bus id from a plain "busId" tag (the real one reads ST_AGENT out of the pty.toml).
const resolve = (s: SupervisedSession): string | null => s.tags["busId"] ?? null;

describe("crashDingTargets — who gets the crash/flap ding", () => {
  it("dings the permanent convoy agents (cos + supervisors); excludes workers, non-agents, and the crasher", () => {
    const sessions = [
      sess("cos", { "ptyfile.session": "claude", strategy: "permanent", busId: "cos-claude" }),
      sess("sup", { "ptyfile.session": "claude", strategy: "permanent", busId: "sup-claude" }),
      sess("wk", { "ptyfile.session": "claude", busId: "wk-claude" }), // worker: not permanent → not an orchestrator
      sess("bare", { strategy: "permanent", busId: "bare" }), // not a convoy agent (no ptyfile.session)
      sess("crasher", { "ptyfile.session": "claude", strategy: "permanent", busId: "crasher-claude" }),
    ];
    expect(crashDingTargets(sessions, "crasher-claude", [], resolve).sort()).toEqual(["cos-claude", "sup-claude"]);
  });

  it("adds --notify ids, dedups them, and still excludes the crasher", () => {
    const sessions = [sess("cos", { "ptyfile.session": "claude", strategy: "permanent", busId: "cos-claude" })];
    expect(crashDingTargets(sessions, "crasher", ["extra", "cos-claude", "crasher"], resolve).sort()).toEqual(["cos-claude", "extra"]);
  });

  it("dedups a member's two sessions (harness + ding) to one bus id", () => {
    const sessions = [
      sess("cos.claude", { "ptyfile.session": "claude", strategy: "permanent", busId: "cos-claude" }),
      sess("cos.ding", { "ptyfile.session": "ding", strategy: "permanent", busId: "cos-claude" }),
    ];
    expect(crashDingTargets(sessions, null, [], resolve)).toEqual(["cos-claude"]);
  });

  it("a session whose bus id can't be resolved is skipped (never dings a null/empty target)", () => {
    const sessions = [
      sess("cos", { "ptyfile.session": "claude", strategy: "permanent", busId: "cos-claude" }),
      sess("mystery", { "ptyfile.session": "claude", strategy: "permanent" }), // no busId → resolve() null
    ];
    expect(crashDingTargets(sessions, null, [], resolve)).toEqual(["cos-claude"]);
  });
});

describe("workerCrashed — the worker negative-control gate (crash → ding, clean exit → silent)", () => {
  it("a nonzero exit is a crash (dings)", () => {
    expect(workerCrashed("exited", 1)).toBe(true);
    expect(workerCrashed("exited", 137)).toBe(true); // OOM-kill signal
  });
  it("a CLEAN exit (code 0) is NOT a crash (stays silent) — the hard negative control", () => {
    expect(workerCrashed("exited", 0)).toBe(false);
  });
  it("a hard 'vanished' death (no exit record) is a crash", () => {
    expect(workerCrashed("vanished", null)).toBe(true);
  });
  it("a NULL exit (daemon wrote no exit code — a no-record death) is a crash — defense-in-depth", () => {
    // NB: an OOM of the AGENT process itself records 137 via pty ≥ #72 (convoy execs the harness → direct child) and
    // is caught by the nonzero leg above — see the Case A/B note on workerCrashed. This null leg guards a genuine
    // no-record exit; the only uncaught OOM is a reaped-grandchild (Case B), which is an OS-level follow-up.
    expect(workerCrashed("exited", null)).toBe(true);
  });
  it("no exit code + still running is not a crash", () => {
    expect(workerCrashed("running", null)).toBe(false);
  });
});
