import { describe, it, expect } from "vitest";
import { agentBusId, dingHealthPlan, reconcilePlan, type CatalogEntry } from "./reconcile.ts";
import type { SupervisedSession } from "./host.ts";
import type { AgentFile } from "./agent-file.ts";
import type { PtySessionDef } from "@compoundingtech/pty/client";

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

describe("dingHealthPlan — agent-centric ding recovery (reconcile-recreates-missing/unhealthy-ding, #82)", () => {
  const PF = "/w/.convoy/pty.toml";
  const dingDef: PtySessionDef = { shortName: "ding", id: "silber.wk.ding", displayName: "wk-ding", command: "st ding silber.wk --identity silber.wk-claude --root /net" };
  const declaresDing = (): PtySessionDef | null => dingDef;
  const declaresNoDing = (): PtySessionDef | null => null;
  const alive = (...pids: number[]) => (pid: number | null): boolean => pid !== null && pids.includes(pid);

  // A harness or ding session keyed by its role + ptyfile tags. pid + status drive liveness.
  function ss(role: string, o: { name?: string; ptyfile?: string; session?: string; pid?: number | null; status?: string } = {}): SupervisedSession {
    const tags: Record<string, string> = { role };
    if (o.ptyfile) tags["ptyfile"] = o.ptyfile;
    if (o.session) tags["ptyfile.session"] = o.session;
    return { name: o.name ?? role, cwd: null, command: "", args: [], status: (o.status ?? "running") as never, exitedAt: null, exitCode: null, pid: o.pid ?? 100, tags };
  }
  const harness = (o: Partial<Parameters<typeof ss>[1]> = {}): SupervisedSession => ss("agent", { name: "silber.wk", ptyfile: PF, session: "claude", pid: 100, ...o });
  const ding = (o: Partial<Parameters<typeof ss>[1]> = {}): SupervisedSession => ss("ding", { name: "silber.wk.ding", ptyfile: PF, session: "ding", pid: 200, ...o });

  it("HEALTHY: harness alive + ding session alive → no action", () => {
    const plan = dingHealthPlan([harness(), ding()], declaresDing, alive(100, 200));
    expect(plan).toEqual([]);
  });

  it("MISSING: harness alive, NO ding session at all (killed + GC'd) → heal, staleDing=null", () => {
    const plan = dingHealthPlan([harness()], declaresDing, alive(100));
    expect(plan).toHaveLength(1);
    expect(plan[0]!.harness.name).toBe("silber.wk");
    expect(plan[0]!.staleDing).toBeNull();
    expect(plan[0]!.dingDef).toBe(dingDef);
  });

  it("DEAD: harness alive, ding session present but process dead → heal, staleDing=the dead ding", () => {
    const dead = ding({ pid: 999 });
    const plan = dingHealthPlan([harness(), dead], declaresDing, alive(100)); // 999 not alive
    expect(plan).toHaveLength(1);
    expect(plan[0]!.staleDing).toBe(dead);
  });

  it("gone-but-pid-ALIVE ding (transient CPU-spike report) → NOT healed (never double-spawn a live process)", () => {
    const transient = ding({ pid: 200, status: "vanished" });
    const plan = dingHealthPlan([harness(), transient], declaresDing, alive(100, 200));
    expect(plan).toEqual([]);
  });

  it("NO DING DECLARED: agent's manifest has no ding (e.g. claude on MCP transport) → skip", () => {
    const plan = dingHealthPlan([harness()], declaresNoDing, alive(100));
    expect(plan).toEqual([]);
  });

  it("DEAD HARNESS: harness gone + pid dead → skipped (the respawn/launch paths own it, not this pass)", () => {
    const plan = dingHealthPlan([harness({ status: "exited", pid: 999 })], declaresDing, alive()); // nothing alive
    expect(plan).toEqual([]);
  });

  it("gone-but-ALIVE harness (adopt-alive) with a missing ding → still healed", () => {
    const plan = dingHealthPlan([harness({ status: "vanished", pid: 100 })], declaresDing, alive(100));
    expect(plan).toHaveLength(1);
  });

  it("non-agent session (role != agent) is ignored even if it looks ding-less", () => {
    const web = ss("web", { name: "svc", ptyfile: PF, session: "svc", pid: 100 });
    const plan = dingHealthPlan([web], declaresDing, alive(100));
    expect(plan).toEqual([]);
  });

  it("harness without a ptyfile tag → skipped (nothing to replay from)", () => {
    const noPf = ss("agent", { name: "silber.wk", session: "claude", pid: 100 }); // no ptyfile
    const plan = dingHealthPlan([noPf], declaresDing, alive(100));
    expect(plan).toEqual([]);
  });

  it("MULTI: agent A healthy, agent B missing its ding → only B is healed (per-agent, by ptyfile)", () => {
    const aH = ss("agent", { name: "a", ptyfile: "/a/.convoy/pty.toml", session: "claude", pid: 1 });
    const aD = ss("ding", { name: "a.ding", ptyfile: "/a/.convoy/pty.toml", session: "ding", pid: 2 });
    const bH = ss("agent", { name: "b", ptyfile: "/b/.convoy/pty.toml", session: "claude", pid: 3 }); // ding missing
    const plan = dingHealthPlan([aH, aD, bH], declaresDing, alive(1, 2, 3));
    expect(plan.map((x) => x.harness.name)).toEqual(["b"]);
  });
});
