// SELF-SEVER GUARD (Nathan mandate, convoy incident 2026-07-22) — `convoy down` typed from INSIDE a
// session it would kill severs the caller mid-command. An agent tearing down the network it lives in is
// the anti-pattern that can turn a restart into a fleet-wide outage. The guard: refuse unless --force when
// the caller's identity (ST_AGENT — convoy bakes it into every session's env) names a to-be-killed session.
//
// Two layers of proof: pure unit tests for the decision (`selfSeverSession`), and a process-level test that
// runs the real `bin/convoy down` from within a member's identity and asserts it refuses + leaves the agent
// alive, that --force overrides, and that a non-member identity is never falsely refused. Scoped to a
// throwaway XDG_STATE_HOME. Lives in the vitest gate (test.yml), not the hermetic nix flake check.

import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { selfSeverSession } from "./up.ts";
import { PtyHost, processAlive, spawnFromPtyFile, type SupervisedSession } from "./host.ts";

// ── pure ────────────────────────────────────────────────────────────────────────────────────────────
const sess = (name: string, tags: Record<string, string>): SupervisedSession => ({ name, cwd: null, command: "", args: [], status: "running" as never, pid: null, exitedAt: null, exitCode: null, tags });
// Test resolver — reads a plain "busId" tag (the real `busIdOf` reads ST_AGENT out of the pty.toml).
const byTag = (s: SupervisedSession): string | null => s.tags["busId"] ?? null;

describe("selfSeverSession — is `convoy down` about to kill the session it is run from?", () => {
  const agents = [sess("s.alpha", { busId: "net.alpha" }), sess("s.beta", { busId: "net.beta" })];

  it("ACCEPTANCE: the caller's ST_AGENT matches a to-be-killed session → returns THAT session", () => {
    expect(selfSeverSession(agents, "net.beta", byTag)?.name).toBe("s.beta");
  });

  it("a null/empty identity (a plain human terminal) is NEVER a self-sever", () => {
    expect(selfSeverSession(agents, null, byTag)).toBeNull();
    expect(selfSeverSession(agents, undefined, byTag)).toBeNull();
    expect(selfSeverSession(agents, "", byTag)).toBeNull();
  });

  it("an identity that matches NO killed session (running elsewhere) is not a self-sever", () => {
    expect(selfSeverSession(agents, "net.gamma", byTag)).toBeNull();
  });

  it("matches on the EXACT bus id, never a prefix/substring", () => {
    expect(selfSeverSession(agents, "net.alph", byTag)).toBeNull();
    expect(selfSeverSession(agents, "net.alpha.ding", byTag)).toBeNull();
  });
});

// ── process-level ─────────────────────────────────────────────────────────────────────────────────────
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(repoRoot, "bin", "convoy");

let home = "";
let net = "";
const savedPtyRoot = process.env["PTY_ROOT"];

function baseEnv(): NodeJS.ProcessEnv {
  return { ...process.env, XDG_STATE_HOME: home, ST_ROOT: "", PTY_ROOT: "" };
}

function freshNet(): void {
  home = mkdtempSync(join(tmpdir(), "cvy-sever-"));
  net = join(home, "convoy", "default");
  mkdirSync(join(net, "catalog"), { recursive: true });
  mkdirSync(join(net, "smalltalk"), { recursive: true });
}

/** Stand up one live agent whose bus id (its manifest ST_AGENT) is `id`, and return its pid. */
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

/** Run the real `convoy down` with ST_AGENT set to `asIdentity`. */
function down(asIdentity: string, ...extra: string[]): { status: number | null; stderr: string } {
  const r = spawnSync(process.execPath, [bin, "down", net, ...extra], { env: { ...baseEnv(), ST_AGENT: asIdentity }, encoding: "utf8" });
  return { status: r.status, stderr: r.stderr };
}

afterEach(() => {
  try {
    spawnSync(process.execPath, [bin, "down", net, "--force"], { env: baseEnv() });
  } catch {
    /* ignore */
  }
  if (home) rmSync(home, { recursive: true, force: true });
  if (savedPtyRoot === undefined) delete process.env["PTY_ROOT"];
  else process.env["PTY_ROOT"] = savedPtyRoot;
});

describe("convoy down — the self-sever guard (real CLI)", () => {
  it("REFUSES when run from INSIDE a session it would kill, and leaves that agent ALIVE", async () => {
    freshNet();
    const pid = await spawnAgent("victim-alpha");
    const r = down("victim-alpha");
    expect(r.status, `should refuse (rc=1)\nstderr:\n${r.stderr}`).toBe(1);
    expect(r.stderr).toMatch(/refusing|INSIDE/);
    expect(processAlive(pid), "the caller's own agent must NOT be killed by a refused down").toBe(true);
  }, 45000);

  it("--force overrides the guard — a deliberate 'take me down too' tears it down", async () => {
    freshNet();
    const pid = await spawnAgent("victim-beta");
    const r = down("victim-beta", "--force");
    expect(r.status, `--force should succeed\nstderr:\n${r.stderr}`).toBe(0);
    await new Promise((res) => setTimeout(res, 400));
    expect(processAlive(pid), "--force must actually tear the agent down").toBe(false);
  }, 45000);

  it("does NOT refuse a caller whose identity is not a member (a plain terminal / another host)", async () => {
    freshNet();
    const pid = await spawnAgent("victim-gamma");
    const r = down("some-outsider-not-in-this-net");
    expect(r.status, `a non-member caller should proceed (rc=0)\nstderr:\n${r.stderr}`).toBe(0);
    await new Promise((res) => setTimeout(res, 400));
    expect(processAlive(pid), "an ordinary down from outside must still tear the agent down").toBe(false);
  }, 45000);
});
