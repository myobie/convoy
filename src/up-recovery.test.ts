// convoy#82 — recovery from provider death. Deliberately its OWN file rather than an append to
// up.test.ts: several PRs are in flight against that file at once, and a new suite appended to a shared
// tail collides with every other append for purely textual reasons. A separate file keeps this
// independently mergeable in any order.

import { describe, it, expect } from "vitest";
import { planLimbRecovery, replaySucceeded, survivingLimbs } from "./up.ts";
import { classifyFailedAttempt, type StrategyTags } from "./flapping-cap.ts";
import { providerAlive, PtyHost, type ReplayIO, type SupervisedSession } from "./host.ts";

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

  // THE REGRESSION GUARD. Every case above runs in the provider-death direction, where returning the
  // surviving ding is right. Read symmetrically, though, those cases sanction the exact inverse — a dead
  // SIDECAR returning its LIVE PROVIDER as a limb to tear down. That inverse is not a smaller version of
  // the same thing; it is a supervisor destroying the very process it exists to protect, and it violates
  // the ADOPT-ALIVE invariant ("NEVER respawn a live process") that the respawn path holds everywhere
  // else. A sidecar is subordinate to its provider: its death is never evidence about the provider's
  // health, so it can never be grounds for killing it.
  it("REGRESSION: a dead SIDECAR never returns its live PROVIDER — a sidecar death must not tear down the agent", () => {
    const deadDing = limb("p1.ding", "/agents/p1", { status: "exited" as never, pid: null });
    const liveProvider = limb("p1", "/agents/p1"); // running, mid-task
    expect(survivingLimbs(deadDing, [liveProvider, deadDing])).toEqual([]);
  });
});

// The routing discriminator. `up` chooses between a sidecar-scale response (restart the sidecar alone)
// and an agent-scale one (replay the whole manifest, killing survivors) on exactly this question, so the
// three shapes below are the three branches recovery can take.
describe("providerAlive — routing a dead limb to sidecar-restart vs manifest-replay (convoy#82)", () => {
  const limb = (name: string, key: string, over: Partial<SupervisedSession> = {}): SupervisedSession => ({
    name,
    cwd: null,
    command: "",
    args: [],
    status: "running" as never,
    pid: null,
    exitedAt: null,
    exitCode: null,
    tags: { ptyfile: "/agents/p1/.convoy/pty.toml", "ptyfile.session": key },
    ...over,
  });

  it("ACCEPTANCE: sidecar dead, provider RUNNING → provider alive, so the sidecar is restarted alone", () => {
    const provider = limb("p1", "claude");
    const deadDing = limb("p1.ding", "ding", { status: "exited" as never, pid: null });
    expect(providerAlive("/agents/p1", [provider, deadDing])).toBe(true);
    // …and the agent-scale teardown stays empty, so the running provider is never touched.
    expect(survivingLimbs(deadDing, [provider, deadDing])).toEqual([]);
  });

  it("BOTH limbs dead → provider NOT alive, so the dead sidecar falls through to the single manifest replay", () => {
    // The case an unconditional sidecar-restart would break: restarting the ding in place here would
    // collide with the pinned id the replay is about to re-spawn, turning a clean recovery into a park.
    const deadProvider = limb("p1", "claude", { status: "vanished" as never });
    const deadDing = limb("p1.ding", "ding", { status: "exited" as never, pid: null });
    expect(providerAlive("/agents/p1", [deadProvider, deadDing])).toBe(false);
  });

  it("provider dead, sidecar ALIVE → provider not alive, so replay proceeds and tears the sidecar down", () => {
    const deadProvider = limb("p1", "claude", { status: "vanished" as never });
    const liveDing = limb("p1.ding", "ding");
    expect(providerAlive("/agents/p1", [deadProvider, liveDing])).toBe(false);
    expect(survivingLimbs(deadProvider, [deadProvider, liveDing]).map((s) => s.name)).toEqual(["p1.ding"]);
  });

  it("a provider reported gone whose pid is still ALIVE counts as alive — the adopt-alive reading", () => {
    const zombie = limb("p1", "claude", { status: "exited" as never, pid: process.pid });
    expect(providerAlive("/agents/p1", [zombie])).toBe(true);
  });

  it("another agent's live provider never counts — scoped by manifest workspace", () => {
    const other = limb("p2", "claude", { tags: { ptyfile: "/agents/p2/.convoy/pty.toml", "ptyfile.session": "claude" } });
    expect(providerAlive("/agents/p1", [other])).toBe(false);
  });
});

// The routing itself. `providerAlive` above is only the discriminator; this is the decision that consumes
// it, and it is where the regression actually lived — a dead sidecar reaching the replay branch is what
// tore down a live provider. Extracted from the reconcile loop precisely so it can be asserted: without
// the sidecar-only case, the first test here falls through to `replay`.
describe("planLimbRecovery — restart the sidecar alone vs replay the whole agent (convoy#82)", () => {
  const limb = (name: string, key: string, over: Partial<SupervisedSession> = {}): SupervisedSession => ({
    name,
    cwd: null,
    command: "",
    args: [],
    status: "running" as never,
    pid: null,
    exitedAt: null,
    exitCode: null,
    tags: { ptyfile: "/agents/p1/.convoy/pty.toml", "ptyfile.session": key },
    ...over,
  });
  const none = new Set<string>();

  it("ACCEPTANCE: dead sidecar + LIVE provider → restart the sidecar alone, NEVER replay", () => {
    // The regression in one assertion: `replay` here tears down the live provider mid-task.
    const provider = limb("p1", "claude");
    const deadDing = limb("p1.ding", "ding", { status: "exited" as never, pid: null });
    expect(planLimbRecovery(deadDing, [provider, deadDing], none)).toEqual({ kind: "restart", reason: "sidecar-only" });
  });

  it("dead provider + live sidecar → replay, tearing down the surviving sidecar first", () => {
    const deadProvider = limb("p1", "claude", { status: "vanished" as never });
    const liveDing = limb("p1.ding", "ding");
    const plan = planLimbRecovery(deadProvider, [deadProvider, liveDing], none);
    expect(plan.kind).toBe("replay");
    expect(plan.kind === "replay" && plan.workspace).toBe("/agents/p1");
    expect(plan.kind === "replay" && plan.survivors.map((s) => s.name)).toEqual(["p1.ding"]);
  });

  it("BOTH limbs dead → the sidecar REPLAYS rather than restarting in place (no collision with the pinned id)", () => {
    // Conditioning the sidecar branch on provider liveness is what makes this work: an unconditional
    // "restart any dead sidecar" would restart the ding here, then replay would re-spawn its pinned id
    // on top of it — a spurious failure that parks a cleanly recoverable agent.
    const deadProvider = limb("p1", "claude", { status: "vanished" as never });
    const deadDing = limb("p1.ding", "ding", { status: "exited" as never, pid: null });
    expect(planLimbRecovery(deadDing, [deadProvider, deadDing], none).kind).toBe("replay");
  });

  it("BOTH limbs dead, agent ALREADY replayed this tick → covered, so the agent is not double-spawned", () => {
    const deadProvider = limb("p1", "claude", { status: "vanished" as never });
    const deadDing = limb("p1.ding", "ding", { status: "exited" as never, pid: null });
    const replayed = new Set(["/agents/p1"]);
    expect(planLimbRecovery(deadDing, [deadProvider, deadDing], replayed)).toEqual({ kind: "covered", workspace: "/agents/p1" });
  });

  it("a live provider's replay is NOT suppressed by another agent's replay this tick", () => {
    const deadProvider = limb("p1", "claude", { status: "vanished" as never });
    expect(planLimbRecovery(deadProvider, [deadProvider], new Set(["/agents/p2"])).kind).toBe("replay");
  });

  it("no manifest at all → the legacy in-place restart, unchanged", () => {
    const orphan = sess("hand-spawned", { strategy: "permanent" });
    expect(planLimbRecovery(orphan, [orphan], none)).toEqual({ kind: "restart", reason: "no-manifest" });
  });
});

// replayManifest itself — the headline recovery primitive. Its correctness is entirely in how it
// SEQUENCES two effects, so the effects are injected and the sequence is asserted directly. Without this
// suite the method could be replaced by `return { spawned: [], failed: [] }` and the whole suite stayed
// green, which is to say the fix at the centre of convoy#82 shipped with no test at all.
describe("PtyHost.replayManifest — kill survivors, THEN cold-boot the manifest (convoy#82)", () => {
  const limb = (name: string): SupervisedSession => ({
    name,
    cwd: null,
    command: "",
    args: [],
    status: "running" as never,
    pid: null,
    exitedAt: null,
    exitCode: null,
    tags: {},
  });

  // Records every effect in the order it happened — the property under test IS the order.
  const recorder = (
    spawn: (w: string) => Promise<{ spawned: string[]; failed: string[] }>,
  ): { io: ReplayIO; log: string[] } => {
    const log: string[] = [];
    return {
      log,
      io: {
        kill: async (n) => {
          log.push(`kill:${n}`);
          return true;
        },
        spawn: async (w) => {
          log.push(`spawn:${w}`);
          return spawn(w);
        },
      },
    };
  };

  const host = new PtyHost(null);

  it("ACCEPTANCE: every survivor is killed BEFORE the spawn — a live limb must never outlive its own replay", () => {
    // Ordering is the whole point: spawning first would collide with the manifest's pinned session ids,
    // and killing after would take down the limb that was just recreated under that same id.
    const { io, log } = recorder(async () => ({ spawned: ["p1", "p1.ding"], failed: [] }));
    return host.replayManifest("/agents/p1", [limb("p1.ding")], io).then((r) => {
      expect(log).toEqual(["kill:p1.ding", "spawn:/agents/p1"]);
      expect(r).toEqual({ spawned: ["p1", "p1.ding"], failed: [] });
    });
  });

  it("kills EVERY survivor, not just the first, before spawning", async () => {
    const { io, log } = recorder(async () => ({ spawned: ["p1"], failed: [] }));
    await host.replayManifest("/agents/p1", [limb("a"), limb("b"), limb("c")], io);
    expect(log).toEqual(["kill:a", "kill:b", "kill:c", "spawn:/agents/p1"]);
  });

  it("spawns with NO survivors to kill (the hard-death shape: every limb already gone)", async () => {
    const { io, log } = recorder(async () => ({ spawned: ["p1", "p1.ding"], failed: [] }));
    const r = await host.replayManifest("/agents/p1", [], io);
    expect(log).toEqual(["spawn:/agents/p1"]);
    expect(r.spawned).toEqual(["p1", "p1.ding"]);
  });

  it("propagates a PARTIAL result verbatim — the caller's cap decides, replay does not launder it", () => {
    // replayManifest must not "helpfully" round a partial spawn up to success; that call belongs to
    // replaySucceeded, and burying it here is how the churn defect became invisible.
    const { io } = recorder(async () => ({ spawned: ["p1.ding"], failed: ["claude"] }));
    return host.replayManifest("/agents/p1", [], io).then((r) => {
      expect(r).toEqual({ spawned: ["p1.ding"], failed: ["claude"] });
      expect(replaySucceeded(r)).toBe(false);
    });
  });

  it("an unreadable/missing manifest becomes a reported FAILURE, never a thrown exception", async () => {
    // A corrupt pty.toml must not escape into the reconcile loop and kill the supervisor for every OTHER
    // agent it hosts — it is one agent's failed attempt, which the cap then counts.
    const { io, log } = recorder(async () => {
      throw new Error("ENOENT: pty.toml");
    });
    const r = await host.replayManifest("/agents/p1", [limb("p1.ding")], io);
    expect(r).toEqual({ spawned: [], failed: ["<manifest unreadable>"] });
    expect(replaySucceeded(r)).toBe(false);
    expect(log).toEqual(["kill:p1.ding", "spawn:/agents/p1"]); // survivors still torn down first
  });
});

// Whether a replay counts as a recovery. This is the predicate the cap hangs off: call a partial spawn a
// success and the counter never advances, so the agent churns forever instead of parking (convoy#82).
describe("replaySucceeded — partial spawn is FAILURE, not progress (convoy#82)", () => {
  it("ACCEPTANCE: a clean sweep — every declared limb up, nothing failed — is the only success", () => {
    expect(replaySucceeded({ spawned: ["p1", "p1.ding"], failed: [] })).toBe(true);
  });

  it("REGRESSION: the PROVIDER failed while the ding came up — an agent that cannot work is NOT recovered", () => {
    // The reproduced shape: replay kills survivors then re-spawns the manifest's pinned ids with no wait,
    // and the kill/respawn race on a pinned id is exactly what throws. `spawned.length > 0` blessed this.
    expect(replaySucceeded({ spawned: ["p1.ding"], failed: ["claude"] })).toBe(false);
  });

  it("REGRESSION: the DING failed while the provider came up — a provider nobody can poke is NOT recovered", () => {
    expect(replaySucceeded({ spawned: ["p1"], failed: ["ding"] })).toBe(false);
  });

  it("nothing spawned at all is failure (the manifest-unreadable path)", () => {
    expect(replaySucceeded({ spawned: [], failed: ["<manifest unreadable>"] })).toBe(false);
  });

  it("a manifest declaring NO sessions is failure — zero limbs is not a running agent", () => {
    expect(replaySucceeded({ spawned: [], failed: [] })).toBe(false);
  });
});

// The end the predicate exists to serve. `replaySucceeded` and `classifyFailedAttempt` are each unit-tested
// above/in flapping-cap.test.ts, but the DEFECT lived in their composition: the wrong predicate meant
// `classifyFailedAttempt` was never reached, so a correct cap sat behind a call that never happened. This
// drives the two together across ticks — the loop's actual sequence — and asserts the counter climbs and
// the agent parks. Against the old predicate the counter never leaves 0 and no tick ever parks.
describe("a persistently partial replay ADVANCES the cap and PARKS (convoy#82)", () => {
  const tags = (over: Partial<StrategyTags> = {}): StrategyTags => ({
    consecutiveFastFails: 0,
    lastRespawnAt: null,
    commandHash: null,
    status: null,
    fastFailWindowOverride: null,
    fastFailLimitOverride: null,
    ...over,
  });

  it("ACCEPTANCE: six ticks of provider-fails/ding-succeeds — counter 1,2,3 then PARKED, not 0,0,0,0,0,0", () => {
    const limit = 3;
    // Every tick replays and every replay comes back partial — the churn the reproduction observed.
    const replay = { spawned: ["p1.ding"], failed: ["claude"] };
    let current = tags();
    const counters: number[] = [];
    let parkedAtTick: number | null = null;

    for (let tick = 1; tick <= 6; tick++) {
      if (current.status === "flapping") break; // parked: the loop skips it, no further attempts
      expect(replaySucceeded(replay)).toBe(false); // the gate that must open for the cap to see anything
      const d = classifyFailedAttempt({ session: "p1", tags: current, currentHash: "h", window: 60, limit, now: new Date() });
      current = d.tags; // persisted to tags by the caller — survives across --once runs
      counters.push(current.consecutiveFastFails);
      if (d.kind === "flap" && parkedAtTick === null) parkedAtTick = tick;
    }

    expect(counters).toEqual([1, 2, 3]); // advances — the defect pinned this at 0,0,0,0,0,0
    expect(parkedAtTick).toBe(3); // parks at the cap rather than churning through all six ticks
    expect(current.status).toBe("flapping"); // and the park is durable, so it dings and stays put
  });
});
