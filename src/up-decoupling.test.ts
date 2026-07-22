// THE DECISIVE TEST (Nathan mandate, convoy incident 2026-07-22) — the permanent regression guard for
// the Nomad decoupling invariant: STOPPING OR CRASHING `convoy up` MUST NOT KILL ITS AGENTS.
//
// The incident: a `convoy up` restart mid-cutover self-severed and took the whole hetz fleet down (exit
// 143 across 11). The forensic question was a-vs-b: (a) a teardown MISUSE (someone ran `convoy down` /
// a session kill), or (b) a real bug where the decoupling does not hold in practice. This test settles
// it AND locks the answer in: it stands up real, detached agent daemons (via convoy's OWN production
// spawn primitive, `spawnFromPtyFile` → `spawnDaemon`), supervises them with a real `convoy up`
// subprocess, then KILLS that subprocess both ways (SIGTERM and SIGKILL) and asserts every agent is
// still alive at the SAME pid. Then a fresh `convoy up` must ADOPT the survivors (not cold-boot), and
// the inverse — `convoy down` — must actually tear them down.
//
// If the survive-asserts pass, the decoupling is real in practice (=> the incident was misuse (a)). If
// they ever fail, THIS is the reproduction of bug (b). Either way the invariant is now guarded.
//
// PROCESS-LEVEL, by necessity: it spawns real daemons + a real `convoy up` and sends real signals. It
// lives in the vitest gate (test.yml, a normal runner) — the lane that already shells out to real
// `bin/convoy` — NOT the hermetic nix flake check (which only runs the curated completions/typecheck
// subset). Everything is scoped to a throwaway XDG_STATE_HOME so it can never touch a live network.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PtyHost, processAlive, spawnFromPtyFile } from "./host.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(repoRoot, "bin", "convoy");

// The two dummy agents. Each is a single PERMANENT session running a long-lived `sleep` — a stand-in for
// a real harness that is a real detached pty daemon without dragging claude/st onto the box. `strategy =
// "permanent"` is what makes `convoy up` supervise (and a fresh up ADOPT) them.
const AGENTS = [
  { key: "claude", id: "dtest-alpha" },
  { key: "claude", id: "dtest-beta" },
] as const;

let home = "";
let net = "";
const savedPtyRoot = process.env["PTY_ROOT"];

/** The isolated-network env every child `convoy` inherits: a throwaway XDG_STATE_HOME, ambient
 *  ST_ROOT/PTY_ROOT scrubbed so nothing leaks in from the real box (same guard run.test.ts uses). */
function childEnv(): NodeJS.ProcessEnv {
  return { ...process.env, XDG_STATE_HOME: home, ST_ROOT: "", PTY_ROOT: "" };
}

/** Write one dummy agent's `.convoy/pty.toml` (the launch manifest convoy replays) into its workspace. */
function writeDummyManifest(workspace: string, id: string): void {
  mkdirSync(join(workspace, ".convoy"), { recursive: true });
  const toml =
    `prefix = "${id}"\n\n` +
    `[sessions.claude]\n` +
    `id = "${id}"\n` +
    `command = "exec sleep 2000000"\n\n` +
    `[sessions.claude.tags]\n` +
    `strategy = "permanent"\n` +
    `role = "agent"\n\n` +
    `[sessions.claude.env]\n` +
    `ST_AGENT = "${id}"\n`;
  writeFileSync(join(workspace, ".convoy", "pty.toml"), toml);
}

/** name → pid for our dummy sessions as pty currently reports them. */
async function agentPids(): Promise<Map<string, number | null>> {
  const ids = new Set<string>(AGENTS.map((a) => a.id));
  const out = new Map<string, number | null>();
  for (const s of await new PtyHost(net).sessions()) if (ids.has(s.name)) out.set(s.name, s.pid);
  return out;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The live pid recorded in the host lock (`<net>/convoy.pid`), or null if absent/stale/dead. */
function lockedHostPid(): number | null {
  try {
    const pid = Number.parseInt(readFileSync(join(net, "convoy.pid"), "utf8").trim(), 10);
    return Number.isInteger(pid) && processAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** Start a foreground `convoy up <net>` subprocess and wait until it is provably HOSTING (it has written
 *  its live pid into the host lock — done at startup, before the first reconcile) plus a short grace so
 *  its immediate first tick adopts the running agents. Returns the child. */
async function startHostAndWait(): Promise<ChildProcess> {
  const child = spawn(process.execPath, [bin, "up", net, "--json"], { env: childEnv(), stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`convoy up exited early (code ${child.exitCode}) before hosting:\n${stderr}`);
    if (lockedHostPid() === child.pid) {
      await sleep(700); // let the immediate first tick run so it is genuinely supervising
      return child;
    }
    await sleep(50);
  }
  throw new Error(`convoy up never acquired the host lock within 15s:\n${stderr}`);
}

/** Signal the host and await its exit. */
async function killHost(child: ChildProcess, signal: NodeJS.Signals): Promise<void> {
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  child.kill(signal);
  await exited;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "cvy-dec-"));
  net = join(home, "convoy", "default");
  mkdirSync(join(net, "catalog"), { recursive: true }); // empty catalog: up supervises, launches nothing new
  mkdirSync(join(net, "smalltalk"), { recursive: true });
  // Stand up the dummy agents as REAL detached daemons, via convoy's own production spawn path.
  for (const a of AGENTS) {
    const workspace = join(net, "agents", a.id);
    writeDummyManifest(workspace, a.id);
    const { spawned, failed } = await spawnFromPtyFile(workspace, net);
    if (failed.length > 0 || spawned.length === 0) throw new Error(`failed to spawn dummy agent ${a.id}: ${JSON.stringify({ spawned, failed })}`);
  }
  // Sanity: both agents are alive before any convoy up touches them.
  const pids = await agentPids();
  expect(pids.size, "both dummy agents should be running before the test").toBe(AGENTS.length);
  for (const [name, pid] of pids) expect(processAlive(pid), `${name} should be alive at setup`).toBe(true);
}, 60000);

afterAll(() => {
  // Best-effort teardown: tear the network down, hard-kill any stragglers, restore env, drop the tmp dir.
  try {
    spawnSync(process.execPath, [bin, "down", net, "--force"], { env: childEnv() });
  } catch {
    /* ignore — the tmp-dir removal below is the backstop */
  }
  if (savedPtyRoot === undefined) delete process.env["PTY_ROOT"];
  else process.env["PTY_ROOT"] = savedPtyRoot;
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("convoy up ↔ agent DECOUPLING — killing the supervisor must not kill its agents (the incident)", () => {
  let baseline: Map<string, number | null>;

  it("SIGTERM to `convoy up` leaves EVERY agent alive at the SAME pid (a clean stop detaches)", async () => {
    baseline = await agentPids();
    const host = await startHostAndWait();
    await killHost(host, "SIGTERM");

    const after = await agentPids();
    expect(after.size, "no agent record should have vanished").toBe(baseline.size);
    for (const [name, pid] of baseline) {
      expect(after.get(name), `${name} must keep its exact pid across a SIGTERM stop`).toBe(pid);
      expect(processAlive(pid), `${name} (pid ${pid}) must still be ALIVE after SIGTERM to convoy up`).toBe(true);
    }
  }, 45000);

  it("SIGKILL to `convoy up` leaves EVERY agent alive at the SAME pid (even a hard crash detaches)", async () => {
    const host = await startHostAndWait();
    await killHost(host, "SIGKILL"); // hardest case: no graceful teardown runs at all

    const after = await agentPids();
    expect(after.size).toBe(baseline.size);
    for (const [name, pid] of baseline) {
      expect(after.get(name), `${name} must keep its exact pid across a SIGKILL crash`).toBe(pid);
      expect(processAlive(pid), `${name} (pid ${pid}) must still be ALIVE after SIGKILL of convoy up`).toBe(true);
    }
  }, 45000);

  it("a FRESH `convoy up` ADOPTS the survivors — same pids, and no launch/respawn/replay of them", async () => {
    // A restart after the (SIGKILL'd) prior host: it must re-attach to the running agents, not cold-boot
    // duplicates. `--once` runs a single reconcile and exits. Adoption ground-truth = the pids are
    // UNCHANGED; the JSON stream must carry no launch/respawn/replay for our sessions.
    const r = spawnSync(process.execPath, [bin, "up", net, "--once", "--json"], { env: childEnv(), encoding: "utf8" });
    expect(r.status, `convoy up --once should exit 0\nstderr:\n${r.stderr}`).toBe(0);

    const after = await agentPids();
    for (const [name, pid] of baseline) {
      expect(after.get(name), `${name} must keep its exact pid — a fresh up ADOPTED it, did not cold-boot it`).toBe(pid);
      expect(processAlive(pid), `${name} must still be alive after the adopting reconcile`).toBe(true);
    }
    const ids = new Set<string>(AGENTS.map((a) => a.id));
    for (const line of r.stdout.split("\n")) {
      if (!line.trim()) continue;
      let rec: { type?: string; session?: string; identity?: string };
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (rec.type === "launch" || rec.type === "respawn" || rec.type === "replay") {
        expect(ids.has(rec.session ?? ""), `a fresh up must not ${rec.type} an adopted survivor (${rec.session})`).toBe(false);
      }
    }
  }, 45000);

  it("the INVERSE — `convoy down` DOES tear the agents down (the one true kill path)", async () => {
    const r = spawnSync(process.execPath, [bin, "down", net], { env: childEnv(), encoding: "utf8" });
    expect(r.status, `convoy down should succeed\nstderr:\n${r.stderr}`).toBe(0);

    // Give the kills a moment to land, then assert every agent is actually gone.
    await sleep(500);
    for (const [name, pid] of baseline) {
      expect(processAlive(pid), `${name} (pid ${pid}) must be DEAD after convoy down — down is the only teardown`).toBe(false);
    }
  }, 45000);
});
