// SAFE RESTART (Nathan mandate, convoy incident 2026-07-22) — `convoy restart` exists so nobody reaches
// for `convoy down` + `convoy up` to restart a live network. `down` KILLS every agent (it is the only
// teardown), so restarting that way is the mass-outage footgun. `restart` instead STOPS the host PROCESS
// (SIGTERM — agents keep running, the Nomad decoupling) and becomes a fresh `convoy up` that RE-ADOPTS
// the still-running agents.
//
// This proves it end to end: a real agent daemon is supervised by a real `convoy up` (host A); a real
// `convoy restart` then stops host A and takes over as host B — and the agent must survive at the SAME
// pid throughout, with host B now holding the lock. Process-level, scoped to a throwaway XDG_STATE_HOME.
// Lives in the vitest gate (test.yml), not the hermetic nix flake check.

import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PtyHost, processAlive, spawnFromPtyFile } from "./host.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(repoRoot, "bin", "convoy");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let home = "";
let net = "";
const live: ChildProcess[] = [];
const savedPtyRoot = process.env["PTY_ROOT"];

function childEnv(): NodeJS.ProcessEnv {
  return { ...process.env, XDG_STATE_HOME: home, ST_ROOT: "", PTY_ROOT: "" };
}

function freshNet(): void {
  home = mkdtempSync(join(tmpdir(), "cvy-restart-"));
  net = join(home, "convoy", "default");
  mkdirSync(join(net, "catalog"), { recursive: true });
  mkdirSync(join(net, "smalltalk"), { recursive: true });
}

async function spawnAgent(id: string): Promise<number> {
  const workspace = join(net, "agents", id);
  mkdirSync(join(workspace, ".convoy"), { recursive: true });
  writeFileSync(
    join(workspace, ".convoy", "pty.toml"),
    `prefix = "${id}"\n\n[sessions.claude]\nid = "${id}"\ncommand = "exec sleep 2000000"\n\n[sessions.claude.tags]\nstrategy = "permanent"\nrole = "agent"\n\n[sessions.claude.env]\nST_AGENT = "${id}"\n`,
  );
  const { spawned, failed } = await spawnFromPtyFile(workspace, net);
  if (failed.length > 0 || spawned.length === 0) throw new Error(`spawn ${id} failed: ${JSON.stringify({ spawned, failed })}`);
  const s = (await new PtyHost(net).sessions()).find((x) => x.name === id);
  if (!s?.pid) throw new Error(`no pid for ${id}`);
  return s.pid;
}

function lockedHostPid(): number | null {
  try {
    const pid = Number.parseInt(readFileSync(join(net, "convoy.pid"), "utf8").trim(), 10);
    return Number.isInteger(pid) && processAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

function startHost(cmd: "up" | "restart"): ChildProcess {
  const child = spawn(process.execPath, [bin, cmd, net, "--json"], { env: childEnv(), stdio: ["ignore", "pipe", "pipe"] });
  live.push(child);
  return child;
}

/** Poll until `pred()` holds or we time out. */
async function until(pred: () => boolean, timeoutMs = 20000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(75);
  }
  return false;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  child.kill("SIGKILL");
  await exited;
}

afterEach(async () => {
  for (const c of live) await stop(c).catch(() => {});
  live.length = 0;
  try {
    spawnSync(process.execPath, [bin, "down", net, "--force"], { env: childEnv() });
  } catch {
    /* ignore */
  }
  if (home) rmSync(home, { recursive: true, force: true });
  if (savedPtyRoot === undefined) delete process.env["PTY_ROOT"];
  else process.env["PTY_ROOT"] = savedPtyRoot;
});

describe("convoy restart — the SAFE restart (stop the process, agents survive, new host re-adopts)", () => {
  it("ACCEPTANCE: stops the running host, the agent SURVIVES at the same pid, and restart becomes the new host", async () => {
    freshNet();
    const agentPid = await spawnAgent("rst-alpha");

    // Host A takes over.
    const hostA = startHost("up");
    expect(await until(() => lockedHostPid() === hostA.pid), "host A should acquire the lock").toBe(true);

    // `convoy restart` stops host A and takes over as host B.
    const restart = startHost("restart");
    const flipped = await until(() => hostA.exitCode !== null && lockedHostPid() === restart.pid);
    expect(flipped, "restart must stop host A and become the new lock owner").toBe(true);

    // Host A is gone; the restart process is the host; and — the whole point — the agent never died.
    expect(hostA.exitCode, "the old host process must have exited").not.toBeNull();
    expect(lockedHostPid(), "the restart process now hosts the network").toBe(restart.pid);
    const after = (await new PtyHost(net).sessions()).find((x) => x.name === "rst-alpha");
    expect(after?.pid, "the agent must keep its exact pid across the restart").toBe(agentPid);
    expect(processAlive(agentPid), "the agent must still be ALIVE after the restart").toBe(true);
  }, 60000);

  it("with NO host running, restart simply STARTS one (it does not error)", async () => {
    freshNet();
    await spawnAgent("rst-beta");
    expect(lockedHostPid(), "precondition: nothing is hosting yet").toBeNull();

    const restart = startHost("restart");
    expect(await until(() => lockedHostPid() === restart.pid), "restart with no prior host must just start hosting").toBe(true);
  }, 45000);
});
