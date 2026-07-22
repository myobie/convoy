// PARKING-RECOVERY (Nathan mandate, convoy incident 2026-07-22) — a supervisor bring-up after a mass
// outage MUST restore the FULL fleet. The bug: `strategy.status=flapping` + the fast-fail counter persist
// to a session's tags, so an outage that drives the cap to its limit PARKS the agents, and then a fresh
// `convoy up`, reading those stale tags, `skip`s them forever (classify: `isFlapping → skip`). The
// reconstructed incident: a bring-up brought back only part of the fleet; the rest stayed parked from a
// prior supervisor's give-up and had to be hand-launched.
//
// The fix (see up.ts FRESH-SUPERVISOR UN-PARK + flapping-cap.ts clearParkForFreshSupervisor): a foreground
// `convoy up` is a DELIBERATE bring-up, so at startup it clears the park + zeroes the counter for permanent
// members (regardless of prior fail count); the cap re-accrues tick-to-tick within THIS supervisor's watch.
// The `--once` shepherd cron does NOT un-park (it runs every few minutes — un-parking there would relaunch
// a genuinely broken agent every tick), so parking stays durable for it.
//
// This proves it end to end: it stands up a PARKED, gone-but-recorded agent (via convoy's own spawn path
// plus the same `strategy.*` tags a prior supervisor would have written), then asserts a fresh FOREGROUND
// up UN-PARKS and RELAUNCHES it, while a fresh `--once` up leaves it parked. Process-level (real daemons +
// a real `convoy up`), scoped to a throwaway XDG_STATE_HOME. Lives in the vitest gate (test.yml), not the
// hermetic nix flake check.

import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { updateTags } from "@compoundingtech/pty/client";
import { gone, PtyHost, processAlive, spawnFromPtyFile } from "./host.ts";
import { FLAPPING_STATUS, TAG } from "./flapping-cap.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(repoRoot, "bin", "convoy");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let home = "";
let net = "";
let host: ChildProcess | null = null;
const savedPtyRoot = process.env["PTY_ROOT"];

function childEnv(): NodeJS.ProcessEnv {
  return { ...process.env, XDG_STATE_HOME: home, ST_ROOT: "", PTY_ROOT: "" };
}

function freshNet(): void {
  home = mkdtempSync(join(tmpdir(), "cvy-park-"));
  net = join(home, "convoy", "default");
  mkdirSync(join(net, "catalog"), { recursive: true });
  mkdirSync(join(net, "smalltalk"), { recursive: true });
}

/** Stand up one permanent agent whose harness EXITS quickly (`sleep 1`), so it lands in the gone-but-
 *  recorded state a real crashed agent occupies — the shape the park tags attach to and a replay relaunches. */
async function spawnAgent(id: string): Promise<void> {
  const workspace = join(net, "agents", id);
  mkdirSync(join(workspace, ".convoy"), { recursive: true });
  writeFileSync(
    join(workspace, ".convoy", "pty.toml"),
    `prefix = "${id}"\n\n[sessions.claude]\nid = "${id}"\ncommand = "sleep 1"\n\n[sessions.claude.tags]\nstrategy = "permanent"\nrole = "agent"\n\n[sessions.claude.env]\nST_AGENT = "${id}"\n`,
  );
  const { spawned, failed } = await spawnFromPtyFile(workspace, net);
  if (failed.length > 0 || spawned.length === 0) throw new Error(`spawn ${id} failed: ${JSON.stringify({ spawned, failed })}`);
}

/** Poll until the agent is in the real CRASHED shape: gone-but-recorded with a DEAD pid. The harness
 *  exits, and ~0.5s later the pty daemon writes its exit record and shuts down (pid clears) — only then is
 *  the pid dead, so `convoy up` treats it as a genuine death to RESPAWN rather than a transient-gone to
 *  ADOPT (the adopt-alive guard: reported-gone but pid-alive → adopt, never respawn). */
async function waitCrashed(id: string, timeoutMs = 12000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = (await new PtyHost(net).sessions()).find((x) => x.name === id);
    if (s && gone(s) && !processAlive(s.pid)) return;
    await sleep(150);
  }
  throw new Error(`${id} never reached the crashed (gone + dead-pid) state`);
}

/** Write the park a prior supervisor would have left: status=flapping at the cap. */
function park(id: string): void {
  updateTags(id, { [TAG.status]: FLAPPING_STATUS, [TAG.consecutive]: "3" });
}

/** The persisted strategy.status tag for an agent (undefined once cleared). */
async function statusTag(id: string): Promise<string | undefined> {
  const s = (await new PtyHost(net).sessions()).find((x) => x.name === id);
  return s?.tags[TAG.status];
}

function lockedHostPid(): number | null {
  try {
    const pid = Number.parseInt(readFileSync(join(net, "convoy.pid"), "utf8").trim(), 10);
    return Number.isInteger(pid) && processAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** Start a foreground `convoy up --json`, wait until it is hosting, run for `runMs` (long enough for the
 *  startup un-park + the immediate first reconcile), then kill it. Returns the captured JSONL stdout. */
async function runForegroundUp(runMs: number): Promise<string> {
  const child = spawn(process.execPath, [bin, "up", net, "--json"], { env: childEnv(), stdio: ["ignore", "pipe", "pipe"] });
  host = child;
  let stdout = "";
  child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && lockedHostPid() !== child.pid) {
    if (child.exitCode !== null) throw new Error(`convoy up exited early (code ${child.exitCode})`);
    await sleep(50);
  }
  await sleep(runMs);
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  child.kill("SIGTERM");
  await exited;
  host = null;
  return stdout;
}

/** Parse a JSONL stream into records. */
function records(stream: string): Array<{ type?: string; session?: string; spawned?: string[] }> {
  const out: Array<{ type?: string; session?: string; spawned?: string[] }> = [];
  for (const line of stream.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* human line leaked to stdout? ignore */
    }
  }
  return out;
}

afterEach(() => {
  if (host) {
    try {
      host.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    host = null;
  }
  try {
    spawnSync(process.execPath, [bin, "down", net, "--force"], { env: childEnv() });
  } catch {
    /* ignore */
  }
  if (home) rmSync(home, { recursive: true, force: true });
  if (savedPtyRoot === undefined) delete process.env["PTY_ROOT"];
  else process.env["PTY_ROOT"] = savedPtyRoot;
});

describe("parking recovery — a fresh foreground `convoy up` restores a PARKED agent (Nathan mandate)", () => {
  it("ACCEPTANCE: a fresh FOREGROUND up UN-PARKS and RELAUNCHES a parked gone agent (regardless of fail count)", async () => {
    freshNet();
    const id = "prk-alpha";
    await spawnAgent(id);
    await waitCrashed(id);
    park(id);
    expect(await statusTag(id), "the agent must be parked before the bring-up").toBe(FLAPPING_STATUS);

    const out = records(await runForegroundUp(2500));

    // It was UN-PARKED (the startup pass cleared the persisted park)...
    expect(out.some((r) => r.type === "unpark" && r.session === id), "a fresh foreground up must emit an unpark for the parked agent").toBe(true);
    // ...and then RELAUNCHED (the reconcile respawned it once un-parking made it eligible — a still-parked
    // agent would have been skipped and never respawned/replayed).
    const relaunched = out.some((r) => (r.type === "respawn" && r.session === id) || (r.type === "replay" && (r.spawned ?? []).includes(id)));
    expect(relaunched, "a fresh foreground up must relaunch the un-parked agent").toBe(true);
    // The persisted park is gone from disk.
    expect(await statusTag(id), "the flapping status tag must be cleared on disk after the bring-up").not.toBe(FLAPPING_STATUS);
  }, 45000);

  it("CONTROL: a `--once` bring-up does NOT un-park — parking stays durable for the shepherd cron", async () => {
    freshNet();
    const id = "prk-beta";
    await spawnAgent(id);
    await waitCrashed(id);
    park(id);

    const r = spawnSync(process.execPath, [bin, "up", net, "--once", "--json"], { env: childEnv(), encoding: "utf8" });
    expect(r.status, `--once should exit 0\nstderr:\n${r.stderr}`).toBe(0);

    // No un-park was emitted, and the park is still on disk — `--once` must respect it (else it would
    // relaunch a genuinely broken agent every few minutes).
    expect(records(r.stdout).some((rec) => rec.type === "unpark"), "--once must NOT un-park anything").toBe(false);
    expect(await statusTag(id), "--once must leave the park intact").toBe(FLAPPING_STATUS);
  }, 45000);
});
