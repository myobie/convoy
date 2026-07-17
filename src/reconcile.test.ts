import { describe, it, expect } from "vitest";
import { agentBusId, reconcilePlan, type CatalogEntry } from "./reconcile.ts";
import type { SupervisedSession } from "./host.ts";
import type { AgentFile } from "./agent-file.ts";

// A session carrying its bus id in a plain "busId" tag; the injected resolver reads it (the real one reads
// ST_AGENT out of the pty.toml). pid/status drive the gone / adopt-alive logic.
function sess(busId: string, over: Partial<SupervisedSession> = {}): SupervisedSession {
  return { name: busId, cwd: null, command: "", args: [], status: "running" as never, exitedAt: null, exitCode: null, pid: 999999, tags: { busId }, ...over };
}
const resolve = (s: SupervisedSession): string | null => s.tags["busId"] ?? null;
const entry = (af: AgentFile): CatalogEntry => ({ af, path: `/cat/${af.identity}.toml` });

describe("agentBusId", () => {
  it("compiles <host>.<identity>; host defaults to thisHost", () => {
    expect(agentBusId({ identity: "wk", role: "worker", host: "boxb" }, "silber")).toBe("boxb.wk");
    expect(agentBusId({ identity: "wk", role: "worker" }, "silber")).toBe("silber.wk");
  });
});

describe("reconcilePlan — desired (catalog) vs actual (sessions), host-filtered", () => {
  const thisHost = "silber";

  it("HOST-FILTER: an agent whose host != this machine is skipped (another host's up launches it)", () => {
    const other = entry({ identity: "remote", role: "worker", host: "hetzner" });
    const plan = reconcilePlan([other], [], thisHost, resolve);
    expect(plan.otherHost).toEqual([other]);
    expect(plan.launch).toEqual([]);
  });

  it("LAUNCH: active, this host, no live session → launch", () => {
    const a = entry({ identity: "wk", role: "worker", host: "silber" });
    const plan = reconcilePlan([a], [], thisHost, resolve);
    expect(plan.launch).toEqual([a]);
    expect(plan.adopt).toEqual([]);
  });

  it("ADOPT: active, this host, a live session exists → adopt (leave it, don't re-launch)", () => {
    const a = entry({ identity: "wk", role: "worker" }); // host omitted → this host
    const plan = reconcilePlan([a], [sess("silber.wk")], thisHost, resolve);
    expect(plan.adopt.map((x) => x.entry)).toEqual([a]);
    expect(plan.launch).toEqual([]);
  });

  it("RE-LAUNCH: a gone session with a DEAD pid → launch (permanent re-launch from the catalog)", () => {
    const a = entry({ identity: "wk", role: "worker", strategy: "permanent" });
    const dead = sess("silber.wk", { status: "exited" as never, pid: null });
    const plan = reconcilePlan([a], [dead], thisHost, resolve);
    expect(plan.launch).toEqual([a]);
    expect(plan.adopt).toEqual([]);
  });

  it("ADOPT-ALIVE: a session reported 'gone' but whose pid is ALIVE → adopt, never re-launch (the CPU-spike guard)", () => {
    const a = entry({ identity: "wk", role: "worker" });
    const goneButAlive = sess("silber.wk", { status: "vanished" as never, pid: 4321 }); // pid alive (process.kill(4321,0) — EPERM/OK)
    const plan = reconcilePlan([a], [goneButAlive], thisHost, resolve);
    // pid 4321 likely not ours → processAlive returns true on EPERM, false on ESRCH. Use the current process pid to be deterministic:
    const self = sess("silber.wk", { status: "vanished" as never, pid: process.pid });
    const plan2 = reconcilePlan([a], [self], thisHost, resolve);
    expect(plan2.adopt.map((x) => x.entry)).toEqual([a]);
    expect(plan2.launch).toEqual([]);
    void plan;
  });

  it("TEARDOWN: retired, this host, WITH a live session → tear down (decommission)", () => {
    const a = entry({ identity: "wk", role: "worker", retired: true });
    const plan = reconcilePlan([a], [sess("silber.wk")], thisHost, resolve);
    expect(plan.teardown.map((x) => x.entry)).toEqual([a]);
    expect(plan.launch).toEqual([]);
    expect(plan.adopt).toEqual([]);
  });

  it("retired + NOT running → no-op (not in any action list)", () => {
    const a = entry({ identity: "wk", role: "worker", retired: true });
    const plan = reconcilePlan([a], [], thisHost, resolve);
    expect(plan).toEqual({ launch: [], teardown: [], adopt: [], otherHost: [] });
  });

  it("ACCEPTANCE (cos's E2E shape): 2 this-host agents + 1 other-host → launch both mine, skip the other", () => {
    const mine1 = entry({ identity: "a1", role: "worker", host: "silber" });
    const mine2 = entry({ identity: "a2", role: "supervisor", host: "silber" });
    const theirs = entry({ identity: "b1", role: "worker", host: "hetzner" });
    const plan = reconcilePlan([mine1, mine2, theirs], [], thisHost, resolve);
    expect(plan.launch).toEqual([mine1, mine2]);
    expect(plan.otherHost).toEqual([theirs]);
  });
});
