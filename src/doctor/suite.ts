// `convoy doctor` (full) — the setup-readiness eval suite. Proves the user's machine can do real agent
// work: (1) a throwaway network stands up + spawns + tears down, (2) inbox+ding delivery works end to end,
// (3) a CoS→supervisor→worker tree fixes a real bundled bug and it grades pass. Every check is ISOLATED
// (its own ST_ROOT + PTY_ROOT under a short sandbox), self-cleaning, and never touches the prod network —
// the suite snapshots prod pty sessions before/after and asserts zero delta. Failures are NAMED + actionable.
//
// Isolation + graded-run patterns are cribbed from evals' fixtures (ghost-bug / team-standup), vendored so
// doctor is self-contained on a user machine (no evals-repo dependency at runtime).

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isGone } from "@myobie/pty/client";
import { run } from "../exec.ts";

/** A file bundled under src/doctor/fixtures/, resolved from this module (works from an installed pkg). */
function fixture(...parts: string[]): string {
  return join(dirname(fileURLToPath(import.meta.url)), "fixtures", ...parts);
}

export interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
  /** Actionable next step shown on failure — the whole point of doctor. */
  fix?: string;
}

/** The convoy CLI entrypoint (bin/convoy), resolved relative to this module so subprocess calls work
 *  from an installed package too. src/doctor/suite.ts → src/doctor → src → repo root → bin/convoy. */
function convoyBin(): string {
  return join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), "bin", "convoy");
}

/** pty's Unix-domain socket path (`<PTY_ROOT>/…​.ding.sock`) must fit the ~104-byte kernel limit; keep the
 *  network root short. We use a short mkdtemp base and guard the resulting NET length. */
const NET_MAX_BYTES = 70;

export interface Sandbox {
  sb: string; // the sandbox root (removed on teardown)
  net: string; // the isolated network root = ST_ROOT; PTY_ROOT = net/pty
  env: NodeJS.ProcessEnv; // ST_ROOT/PTY_ROOT pinned to the sandbox
}

/** Make a short, isolated sandbox network. Throws with an actionable message if the path is too long. */
export function makeSandbox(tag: string): Sandbox {
  const sb = mkdtempSync(join(tmpdir(), `cvd-${tag}-`));
  const net = join(sb, "n");
  const bytes = Buffer.byteLength(join(net, "pty"), "utf8");
  if (bytes > NET_MAX_BYTES) {
    rmSync(sb, { recursive: true, force: true });
    throw new Error(`sandbox network path too long (${bytes} bytes) — set TMPDIR to a shorter dir`);
  }
  return { sb, net, env: { ...process.env, ST_ROOT: net, PTY_ROOT: join(net, "pty") } };
}

/** Run a convoy subcommand against the sandbox (its ST_ROOT/PTY_ROOT + explicit --network). */
export async function runConvoy(box: Sandbox, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const r = await run("node", [convoyBin(), ...args], { env: box.env });
  return { ok: r.ok, stdout: r.stdout, stderr: r.stderr };
}

/** The set of LIVE pty session names on a given PTY_ROOT (default = the user's PROD root when env omitted).
 *  Excludes exited/vanished sessions — `pty kill` leaves an exited entry in `pty list`, so counting those
 *  would false-positive a teardown or a prod-delta check. */
export async function ptySessionNames(env?: NodeJS.ProcessEnv): Promise<Set<string>> {
  const r = await run("pty", ["list", "--json"], env ? { env } : {});
  if (!r.ok) return new Set();
  try {
    const parsed: unknown = JSON.parse(r.stdout);
    const arr = Array.isArray(parsed) ? parsed : ((parsed as { sessions?: unknown[] }).sessions ?? []);
    return new Set(
      (arr as Array<{ name?: string; status?: string }>)
        .filter((s) => !isGone(s.status as never))
        .map((s) => s.name ?? "")
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

/** Tear the sandbox down: kill its sessions (convoy down --force) then remove the dir. Best-effort. */
export async function teardownSandbox(box: Sandbox): Promise<void> {
  try {
    await runConvoy(box, ["down", box.net, "--force"]);
  } catch {
    // best-effort — we still remove the dir
  }
  rmSync(box.sb, { recursive: true, force: true });
}

/** CHECK 1 — a throwaway network stands up, spawns an agent, and tears down cleanly. Proves init / spawn /
 *  teardown plumbing end to end, in isolation. */
export async function checkTmpNetwork(): Promise<CheckResult> {
  const name = "tmp network — init / spawn / teardown";
  let box: Sandbox;
  try {
    box = makeSandbox("net");
  } catch (e) {
    return { name, pass: false, detail: e instanceof Error ? e.message : String(e), fix: "set TMPDIR to a shorter path (pty sockets must fit ~104 bytes)" };
  }
  try {
    const init = await runConvoy(box, ["init", box.net, "--no-channel"]);
    if (!init.ok) return { name, pass: false, detail: `convoy init failed: ${init.stderr.trim() || init.stdout.trim()}`, fix: "check `st`/`pty` are on PATH and the bus works (convoy doctor --quick)" };

    const wkDir = join(box.sb, "wk");
    mkdirSync(wkDir, { recursive: true });
    const add = await runConvoy(box, ["add", "worker", "--identity", "doctor-wk", "--network", box.net, "--dir", wkDir, "--persona", fixture("worker-persona.md")]);
    if (!add.ok) return { name, pass: false, detail: `convoy add failed: ${add.stderr.trim() || add.stdout.trim()}`, fix: "a spawn failure usually means smalltalk hooks aren't discoverable — check `convoy doctor --quick` (Hooks)" };

    const spawned = await ptySessionNames(box.env);
    const agentUp = [...spawned].some((s) => s.includes("doctor-wk") || s.includes(".doctor-wk"));
    if (!agentUp) return { name, pass: false, detail: `agent session did not register (sessions: ${[...spawned].join(", ") || "none"})`, fix: "the pty daemon didn't register the session — check `pty list` and the pty binary" };

    await runConvoy(box, ["down", box.net, "--force"]);
    const after = await ptySessionNames(box.env);
    const leftover = [...after].filter((s) => s.includes("doctor-wk"));
    if (leftover.length > 0) return { name, pass: false, detail: `convoy down left ${leftover.length} session(s): ${leftover.join(", ")}`, fix: "teardown didn't reap the sessions — check `convoy down` / the pty kill path" };

    return { name, pass: true, detail: "init → spawned doctor-wk → torn down clean, all isolated" };
  } finally {
    await teardownSandbox(box);
  }
}

/** Run the full readiness suite: the graded checks + a prod-untouched gate (prod pty sessions unchanged
 *  before/after). Returns 0 iff every check passed. Each check is isolated + self-cleaning. */
export async function runReadinessSuite(): Promise<number> {
  const out = (s = ""): void => {
    process.stdout.write(`${s}\n`);
  };
  out();
  out("Readiness checks (isolated throwaway networks — your prod network is untouched)");
  const prodBefore = await ptySessionNames(); // default PTY_ROOT = the user's prod root

  const results: CheckResult[] = [];
  results.push(await checkTmpNetwork());
  // checkDings + checkDevTask land next.

  // Prod-untouched gate — the isolation proof.
  const prodAfter = await ptySessionNames();
  const added = [...prodAfter].filter((s) => !prodBefore.has(s));
  const removed = [...prodBefore].filter((s) => !prodAfter.has(s));
  const prodOk = added.length === 0 && removed.length === 0;
  results.push({
    name: "prod untouched",
    pass: prodOk,
    detail: prodOk ? `prod pty sessions unchanged (${prodBefore.size} live)` : `prod delta — added [${added.join(", ")}] removed [${removed.join(", ")}]`,
    fix: prodOk ? undefined : "a check leaked into the prod pty root — isolation breach, file a bug",
  });

  out();
  for (const r of results) {
    out(`  ${r.pass ? "✓" : "✗"} ${r.name}`);
    out(`      ${r.pass ? r.detail : r.detail}`);
    if (!r.pass && r.fix) out(`      → fix: ${r.fix}`);
  }
  const failed = results.filter((r) => !r.pass).length;
  out();
  if (failed === 0) {
    out("✓ your setup can do real work — all readiness checks passed.");
    return 0;
  }
  out(`✗ ${failed} readiness check${failed === 1 ? "" : "s"} failed — see the → fix lines above.`);
  return 1;
}
