// convoy#82 — recovery from provider death. Deliberately its OWN file rather than an append to
// up.test.ts: several PRs are in flight against that file at once, and a new suite appended to a shared
// tail collides with every other append for purely textual reasons. A separate file keeps this
// independently mergeable in any order.

import { describe, it, expect } from "vitest";
import { survivingLimbs } from "./up.ts";
import type { SupervisedSession } from "./host.ts";

const sess = (name: string, tags: Record<string, string>): SupervisedSession => ({
  name,
  cwd: null,
  command: "",
  args: [],
  status: "running" as never,
  pid: null,
  exitedAt: null,
  exitCode: null,
  tags,
});

// Which limbs manifest replay tears down before relaunching. The reproduction's exact shape: the
// provider's daemon was SIGKILLed (vanished, no exit record) while its ding sidecar kept running.
describe("survivingLimbs — the limbs replay must tear down first (convoy#82)", () => {
  const limb = (name: string, workspace: string, over: Partial<SupervisedSession> = {}): SupervisedSession => ({
    ...sess(name, { ptyfile: `${workspace}/.convoy/pty.toml`, "ptyfile.session": name.includes("ding") ? "ding" : "claude" }),
    ...over,
  });

  it("ACCEPTANCE: a vanished provider's SURVIVING ding sidecar is returned (the reproduced shape)", () => {
    const provider = limb("p1", "/agents/p1", { status: "vanished" as never });
    const ding = limb("p1.ding", "/agents/p1");
    expect(survivingLimbs(provider, [provider, ding]).map((s) => s.name)).toEqual(["p1.ding"]);
  });

  it("NEVER returns another agent's sessions — scoped by manifest, not by name pattern", () => {
    // p1 / p10 share a name PREFIX. A pattern-matched teardown would take p10 down with p1.
    const provider = limb("p1", "/agents/p1", { status: "vanished" as never });
    const other = limb("p10.ding", "/agents/p10");
    expect(survivingLimbs(provider, [provider, other])).toEqual([]);
  });

  it("excludes the dead session itself (it is the one being replayed, not a survivor)", () => {
    const provider = limb("p1", "/agents/p1", { status: "vanished" as never });
    expect(survivingLimbs(provider, [provider])).toEqual([]);
  });

  it("excludes a limb that is gone AND whose process is dead — nothing left to tear down", () => {
    const provider = limb("p1", "/agents/p1", { status: "vanished" as never });
    const deadDing = limb("p1.ding", "/agents/p1", { status: "exited" as never, pid: null });
    expect(survivingLimbs(provider, [provider, deadDing])).toEqual([]);
  });

  it("INCLUDES a limb reported gone whose pid is still ALIVE — it must be stopped before its id is reused", () => {
    const provider = limb("p1", "/agents/p1", { status: "vanished" as never });
    const zombie = limb("p1.ding", "/agents/p1", { status: "exited" as never, pid: process.pid }); // this test process = alive
    expect(survivingLimbs(provider, [provider, zombie]).map((s) => s.name)).toEqual(["p1.ding"]);
  });

  it("returns nothing when the dead session has NO manifest — there is no launch spec to replay", () => {
    const orphan = sess("hand-spawned", { strategy: "permanent" });
    const ding = limb("p1.ding", "/agents/p1");
    expect(survivingLimbs(orphan, [orphan, ding])).toEqual([]);
  });
});
