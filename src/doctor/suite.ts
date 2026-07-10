// `convoy doctor` (full) — the setup-readiness eval suite. Proves the user's machine can do real agent
// work: (1) a throwaway network stands up + spawns + tears down, (2) inbox+ding delivery works end to end,
// (3) a CoS→supervisor→worker tree fixes a real bundled bug and it grades pass. Every check is ISOLATED
// (its own ST_ROOT + PTY_ROOT under a short sandbox), self-cleaning, and never touches the prod network —
// the suite snapshots prod pty sessions before/after and asserts zero delta. Failures are NAMED + actionable.
//
// Isolation + graded-run patterns are cribbed from evals' fixtures (ghost-bug / team-standup), vendored so
// doctor is self-contained on a user machine (no evals-repo dependency at runtime).

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isGone } from "@myobie/pty/client";
import { run } from "../exec.ts";
import { pretrustDir } from "../trust.ts";

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

/** Tear the sandbox down: kill its sessions (convoy down --force), wait for the pty daemon to actually let go,
 *  then remove the dir. Best-effort. The wait matters for self-cleaning: `convoy down` returns before the pty
 *  daemon finishes flushing its registry files, so a bare rmSync races a lagging write that would recreate
 *  `<net>/pty/*.json` right after we deleted the tree — leaving a leftover dir. Polling until no live session
 *  remains lets the daemon settle first. */
export async function teardownSandbox(box: Sandbox): Promise<void> {
  try {
    await runConvoy(box, ["down", box.net, "--force"]);
    await pollUntil(async () => (await ptySessionNames(box.env)).size === 0, 15_000, 1000);
  } catch {
    // best-effort — we still remove the dir
  }
  rmSync(box.sb, { recursive: true, force: true });
  if (existsSync(box.sb)) {
    // A late daemon flush recreated part of the tree between the poll and the remove — sweep once more.
    await new Promise((r) => setTimeout(r, 1500));
    rmSync(box.sb, { recursive: true, force: true });
  }
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
  results.push(await checkDings());
  results.push(await checkStateExternalization());
  results.push(await checkExactlyOnce());
  results.push(await checkDevTask());

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

/** Run an `st` (smalltalk bus) command against the sandbox's ST_ROOT. */
async function runSt(box: Sandbox, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const r = await run("st", args, { env: box.env });
  return { ok: r.ok, stdout: r.stdout, stderr: r.stderr };
}

/** Poll `fn` until it returns true or the timeout elapses. (Normal runtime — Date.now/setTimeout are fine.) */
async function pollUntil(fn: () => Promise<boolean>, timeoutMs: number, intervalMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return fn();
}

/** Parse an `st message ls --count` output to a number (handles "0" and "# 0 messages in inbox"). */
function parseCount(s: string): number {
  const m = s.match(/\d+/);
  return m ? Number.parseInt(m[0], 10) : NaN;
}

/** CHECK 2 — inbox + ding delivery end to end. Spawns an idle recipient, waits until it's booted +
 *  available (it drains its empty inbox on boot), THEN sends it a message: a working `st ding` sidecar must
 *  POKE the idle agent so it drains (archives) the message. If the ding is broken (global pty bin off PATH),
 *  the idle agent is never poked and the inbox stays non-empty — the exact silent ding-outage this catches. */
export async function checkDings(): Promise<CheckResult> {
  const name = "inboxes + dings — end-to-end delivery";
  let box: Sandbox;
  try {
    box = makeSandbox("ding");
  } catch (e) {
    return { name, pass: false, detail: e instanceof Error ? e.message : String(e), fix: "set TMPDIR to a shorter path (pty sockets must fit ~104 bytes)" };
  }
  try {
    const init = await runConvoy(box, ["init", box.net, "--no-channel"]);
    if (!init.ok) return { name, pass: false, detail: `convoy init failed: ${init.stderr.trim() || init.stdout.trim()}`, fix: "run `convoy doctor --quick` — st/pty/bus" };

    const rxDir = join(box.sb, "rx");
    mkdirSync(rxDir, { recursive: true });
    const add = await runConvoy(box, ["add", "worker", "--identity", "doctor-rx", "--network", box.net, "--dir", rxDir, "--persona", fixture("worker-persona.md")]);
    if (!add.ok) return { name, pass: false, detail: `convoy add failed: ${add.stderr.trim() || add.stdout.trim()}`, fix: "spawn failed — `convoy doctor --quick` (Hooks/Personas)" };

    // Wait for the recipient to boot + go available (its SessionStart boot ritual sets status + drains).
    const avail = await pollUntil(async () => (await runSt(box, ["status", "doctor-rx"])).stdout.trim() === "available", 120_000);
    if (!avail) return { name, pass: false, detail: "recipient never became available (didn't boot)", fix: "the agent didn't boot — check claude auth (`/login`) then re-run; or `convoy doctor --quick`" };

    // Send it a message; a working ding must poke the (idle) agent so it drains + archives.
    const send = await runSt(box, ["message", "send", "doctor-rx", "-m", "doctor ding probe — read and archive this, then stand by"]);
    if (!send.ok) return { name, pass: false, detail: `st message send failed: ${send.stderr.trim()}`, fix: "the bus rejected the message — check `st` on PATH" };

    const drained = await pollUntil(async () => {
      const c = await runSt(box, ["message", "ls", "doctor-rx", "--count"]);
      return c.ok && parseCount(c.stdout) === 0;
    }, 120_000);
    if (!drained) {
      return { name, pass: false, detail: "message reached the bus but the available recipient never processed it (inbox stayed non-empty)", fix: "the agent was up + available but its `st ding` sidecar never POKED it — the global pty bin is likely broken or off PATH (this is exactly the silent ding-outage)" };
    }

    return { name, pass: true, detail: "sent a message → ding poked the recipient → it drained its inbox, all isolated" };
  } finally {
    await teardownSandbox(box);
  }
}

/** Name the likely reason state didn't reconstruct — the actionable payoff of check 4. */
function hookBlockerFix(agentDir: string): string {
  const settings = join(agentDir, ".claude", "settings.local.json");
  const hasHook = existsSync(settings) && readFileSync(settings, "utf8").includes("SessionStart");
  if (!hasHook) {
    return "the agent has no SessionStart hook wired (convoy add writes .claude/settings.local.json) — reinstall/upgrade convoy or check SMALLTALK_DIR";
  }
  const globalCfg = join(process.env["HOME"] ?? "", ".claude.json");
  let globalHint = "";
  try {
    const g = JSON.parse(readFileSync(globalCfg, "utf8")) as Record<string, unknown>;
    if (g["disableAllHooks"] === true || g["hooksDisabled"] === true) globalHint = " (~/.claude.json disables hooks globally)";
  } catch {
    // best-effort
  }
  return `the SessionStart hook is wired but did not fire${globalHint} — a global agent-config or policy override is blocking it, so agent state won't externalize and agents won't survive a restart. Re-enable SessionStart hooks (check ~/.claude.json + any managed settings/policy)`;
}

/** CHECK 4 (the restartability thesis) — state externalization. Spawn an agent, externalize durable
 *  work-state (seed context/now.md with a resume task), COLD-restart it (no --resume), and assert it
 *  RECONSTRUCTS that state via the SessionStart hook (which injects now.md) and acts on it. If the hook is
 *  blocked (globally-disabled hooks / a settings-or-policy override), reconstruction silently never happens
 *  and agents won't survive a restart — this NAMES that cause. */
export async function checkStateExternalization(): Promise<CheckResult> {
  const name = "state externalization / restartability";
  let box: Sandbox;
  try {
    box = makeSandbox("sx");
  } catch (e) {
    return { name, pass: false, detail: e instanceof Error ? e.message : String(e), fix: "set TMPDIR to a shorter path (pty sockets must fit ~104 bytes)" };
  }
  try {
    const init = await runConvoy(box, ["init", box.net, "--no-channel"]);
    if (!init.ok) return { name, pass: false, detail: `convoy init failed: ${init.stderr.trim() || init.stdout.trim()}`, fix: "run `convoy doctor --quick`" };

    const sxDir = join(box.sb, "doctor-sx"); // dir basename == identity so `convoy reload` matches it
    mkdirSync(sxDir, { recursive: true });
    const add = await runConvoy(box, ["add", "worker", "--identity", "doctor-sx", "--network", box.net, "--dir", sxDir, "--persona", fixture("worker-persona.md")]);
    if (!add.ok) return { name, pass: false, detail: `convoy add failed: ${add.stderr.trim() || add.stdout.trim()}`, fix: "spawn failed — `convoy doctor --quick`" };

    const avail = await pollUntil(async () => (await runSt(box, ["status", "doctor-sx"])).stdout.trim() === "available", 120_000);
    if (!avail) return { name, pass: false, detail: "agent never became available (didn't boot)", fix: "the agent didn't boot — check claude auth (`/login`)" };

    // Externalize durable work-state: seed now.md with a resume task the reconstructed agent will act on.
    const token = `SX-${process.pid}-${box.sb.slice(-6)}`;
    const logPath = join(sxDir, "RECONSTRUCTED.log");
    const nowMd = join(box.net, "doctor-sx", "context", "now.md");
    mkdirSync(dirname(nowMd), { recursive: true });
    writeFileSync(
      nowMd,
      `# Current task (durable working state)\n\nYou were restarted mid-task. Your ONE resumed task: run this shell command EXACTLY, then stand by:\n\n    echo "${token}" >> "${logPath}"\n\nDo it now if RECONSTRUCTED.log does not already contain that token.\n`,
    );

    // Cold-restart the agent (no --resume) via `convoy reload` — kills + respawns from the pty.toml. Unlike
    // `pty restart -y`, it never tries to ATTACH, so it works even when doctor itself runs INSIDE a pty
    // session (an agent, or a nested shell). The respawn re-fires the SessionStart hook → it injects now.md.
    const restart = await runConvoy(box, ["reload", "doctor-sx", "--network", box.net]);
    if (!restart.ok) return { name, pass: false, detail: `cold-restart (convoy reload) failed: ${restart.stderr.trim() || restart.stdout.trim()}`, fix: "check `convoy reload` / the pty respawn path" };

    // Reconstruction: the cold-booted agent must pick up now.md (via the hook) + do the task.
    const reconstructed = await pollUntil(async () => existsSync(logPath) && readFileSync(logPath, "utf8").includes(token), 180_000);
    if (!reconstructed) {
      return { name, pass: false, detail: "the cold-booted agent did NOT reconstruct its work-state from now.md — the SessionStart hook did not inject it (no --resume was used, so externalization is the only path)", fix: hookBlockerFix(sxDir) };
    }

    return { name, pass: true, detail: "externalized now.md → cold-boot (no --resume) → SessionStart hook reconstructed the task + the agent acted on it, all isolated" };
  } finally {
    await teardownSandbox(box);
  }
}

/** How many lines of `haystack` contain `needle`. */
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split("\n").filter((l) => l.includes(needle)).length;
}

/** The recipient's inbox count on the sandbox bus (NaN on error). */
async function inboxCount(box: Sandbox, id: string): Promise<number> {
  const c = await runSt(box, ["message", "ls", id, "--count"]);
  return c.ok ? parseCount(c.stdout) : Number.NaN;
}

/** CHECK 2b — exactly-once inbox processing across a restart (the double-act guard). Vendored from evals'
 *  inbox-hygiene eval. The agent appends each new message's token to PROCESSED.log EXACTLY once (check-
 *  before-append + archive-on-act). We process a message, then RE-DELIVER the same message un-archived and
 *  COLD-restart: on the boot re-drain the agent must recognize it already acted and NOT re-append — so the
 *  token stays at count 1. count>1 = a re-drain doubles actions (double-send/delegate/merge risk); held-out
 *  (counts a durable side-effect, never a self-report). */
export async function checkExactlyOnce(): Promise<CheckResult> {
  const name = "exactly-once inbox processing (restart double-act guard)";
  let box: Sandbox;
  try {
    box = makeSandbox("xo");
  } catch (e) {
    return { name, pass: false, detail: e instanceof Error ? e.message : String(e), fix: "set TMPDIR to a shorter path (pty sockets must fit ~104 bytes)" };
  }
  try {
    const init = await runConvoy(box, ["init", box.net, "--no-channel"]);
    if (!init.ok) return { name, pass: false, detail: `convoy init failed: ${init.stderr.trim() || init.stdout.trim()}`, fix: "run `convoy doctor --quick`" };

    const xoDir = join(box.sb, "doctor-xo"); // basename == identity so `convoy reload` matches it
    mkdirSync(xoDir, { recursive: true });
    const logPath = join(xoDir, "PROCESSED.log");
    writeFileSync(logPath, ""); // empty ledger — the countable side-effect
    const add = await runConvoy(box, ["add", "worker", "--identity", "doctor-xo", "--network", box.net, "--dir", xoDir, "--persona", fixture("exactly-once-persona.md")]);
    if (!add.ok) return { name, pass: false, detail: `convoy add failed: ${add.stderr.trim() || add.stdout.trim()}`, fix: "spawn failed — `convoy doctor --quick`" };

    const avail = await pollUntil(async () => (await runSt(box, ["status", "doctor-xo"])).stdout.trim() === "available", 120_000);
    if (!avail) return { name, pass: false, detail: "agent never became available (didn't boot)", fix: "the agent didn't boot — check claude auth (`/login`)" };

    const token = `XO-${process.pid}-${box.sb.slice(-6)}`;
    // 1st delivery: the agent should append the token once + archive.
    const send1 = await runSt(box, ["message", "send", "doctor-xo", "-m", token]);
    if (!send1.ok) return { name, pass: false, detail: `st message send failed: ${send1.stderr.trim()}`, fix: "the bus rejected the message — check `st` on PATH" };
    const processed = await pollUntil(async () => existsSync(logPath) && countOccurrences(readFileSync(logPath, "utf8"), token) >= 1 && (await inboxCount(box, "doctor-xo")) === 0, 150_000);
    if (!processed) return { name, pass: false, detail: "agent never processed the first delivery (token not appended or inbox not drained)", fix: "the agent didn't act on its ding — check `convoy doctor` checks 2/4" };

    // Restart leg: re-deliver the SAME message un-archived, cold-restart, and demand it NOT re-act.
    const send2 = await runSt(box, ["message", "send", "doctor-xo", "-m", token]);
    if (!send2.ok) return { name, pass: false, detail: `re-delivery send failed: ${send2.stderr.trim()}`, fix: "check `st` on PATH" };
    const reload = await runConvoy(box, ["reload", "doctor-xo", "--network", box.net]);
    if (!reload.ok) return { name, pass: false, detail: `cold-restart (convoy reload) failed: ${reload.stderr.trim() || reload.stdout.trim()}`, fix: "check `convoy reload`" };
    const reDrained = await pollUntil(async () => (await inboxCount(box, "doctor-xo")) === 0, 180_000);

    const finalCount = countOccurrences(readFileSync(logPath, "utf8"), token);
    if (finalCount > 1) {
      return { name, pass: false, detail: `DOUBLE-ACT: token appears ${finalCount}× in PROCESSED.log (want exactly 1) — the agent re-acted on a re-surfaced message after restart`, fix: "resume-safety is broken — an inbox re-drain doubles actions (double-send / double-delegate / double-merge). The DING-BUS 'archive-on-act + don't re-act on a re-drained item' guard isn't holding" };
    }
    if (finalCount < 1) return { name, pass: false, detail: "token never landed in PROCESSED.log", fix: "the agent didn't act — check checks 2/4" };
    if (!reDrained) return { name, pass: false, detail: "after restart the agent didn't re-drain the re-delivered message (inbox stayed non-empty)", fix: "the cold-booted agent didn't process its inbox — check the SessionStart boot ritual (check 4)" };

    return { name, pass: true, detail: "processed once → re-delivered + cold-restarted → re-drained WITHOUT re-acting (token exactly once), all isolated" };
  } finally {
    await teardownSandbox(box);
  }
}

/** Did `recipient` receive at least one message from `sender` (inbox OR archive) on the sandbox bus? Agents
 *  archive a message once they act on it, so a completed hop lands in the archive — we count both. */
async function receivedFrom(box: Sandbox, recipient: string, sender: string): Promise<boolean> {
  const inbox = parseCount((await runSt(box, ["message", "ls", recipient, "--from", sender, "--count"])).stdout);
  const arch = parseCount((await runSt(box, ["message", "ls", recipient, "--archive", "--from", sender, "--count"])).stdout);
  return (Number.isFinite(inbox) ? inbox : 0) + (Number.isFinite(arch) ? arch : 0) >= 1;
}

/** CHECK 3 (the capstone) — the CoS→supervisor→worker org model produces a REAL graded fix. Spins a 3-tier
 *  tree in an isolated sandbox: a thin doctor-CoS (triage+delegate, no first-run interview) → a thin
 *  doctor-supervisor (relay, no cron/no spawn — the real supervisor persona's watchdog-cron + spawning would
 *  break doctor's self-cleaning) → the user's REAL worker persona on the leaf, which owns a bundled buggy
 *  'labelkit' repo. We seed a kick to the CoS to fix a real deterministic bug (the ghost-bug: a shared-default
 *  mutation), and grade held-out + ground-truth: (a) the worker's repo passes a MUTATION-VALID grader that
 *  lives outside the repo and provably FAILS on the pristine buggy base; (b) a fix commit landed on top of the
 *  base touching src/format.js (only the worker has a git repo → worker-only authorship); (c) the delegation
 *  is visible on the bus at BOTH hops (cos→sup, sup→wk). Fully isolated + torn down; prod untouched.
 *
 *  SCOPE (be honest so a PASS isn't over-read): this proves the 3-tier delegation CHAIN + a real graded worker
 *  fix + the hard gates. It deliberately does NOT exercise the full autonomous orchestration of the user's
 *  real CoS/supervisor personas — those are PERSISTENT-ORCHESTRATOR designs (first-run interview, watchdog
 *  cron, worker-spawning) that cannot run inside a bounded, self-cleaning one-shot; the two upper tiers are
 *  thin deterministic stand-ins on purpose. The real WORKER persona (the tier that does the work) IS loaded. */
export async function checkDevTask(): Promise<CheckResult> {
  const name = "dev task — CoS→supervisor→worker delegation + graded fix";
  let box: Sandbox;
  try {
    box = makeSandbox("dev");
  } catch (e) {
    return { name, pass: false, detail: e instanceof Error ? e.message : String(e), fix: "set TMPDIR to a shorter path (pty sockets must fit ~104 bytes)" };
  }
  try {
    const init = await runConvoy(box, ["init", box.net, "--no-channel"]);
    if (!init.ok) return { name, pass: false, detail: `convoy init failed: ${init.stderr.trim() || init.stdout.trim()}`, fix: "run `convoy doctor --quick`" };

    // Materialize the bundled buggy 'labelkit' repo as the worker's territory (git repo, buggy base committed
    // so the worker commits the fix ON TOP + we have a base to diff). Repo-local git identity so the worker's
    // commit succeeds even on a machine with no global git user configured.
    const repo = join(box.sb, "doctor-wk"); // basename == identity (teardown/reload match on norm(basename))
    mkdirSync(repo, { recursive: true });
    cpSync(fixture("ghost-bug"), repo, { recursive: true });
    const git = async (...a: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> => {
      const r = await run("git", a, { cwd: repo, env: box.env });
      return { ok: r.ok, stdout: r.stdout, stderr: r.stderr };
    };
    for (const a of [["init", "-q"], ["config", "user.name", "doctor-worker"], ["config", "user.email", "worker@doctor.local"], ["add", "-A"], ["commit", "-q", "-m", "labelkit: initial (buggy)"]]) {
      const r = await git(...a);
      if (!r.ok) return { name, pass: false, detail: `git ${a[0]} failed: ${r.stderr.trim()}`, fix: "git is required for the dev-task check — install it and re-run" };
    }
    const baseSha = (await git("rev-parse", "HEAD")).stdout.trim();

    // Spin the tree. Worker = the user's REAL worker persona (no override — the tier that DOES the work). The
    // two upper tiers are spawned as `supervisor` role (worker boot = no interview) with thin doctor personas.
    const spawns: Array<{ role: string; id: string; dir: string; persona: string | null }> = [
      { role: "worker", id: "doctor-wk", dir: repo, persona: null }, // the user's REAL worker.md (no override)
      { role: "supervisor", id: "doctor-sup", dir: join(box.sb, "doctor-sup"), persona: fixture("doctor-supervisor-persona.md") },
      { role: "supervisor", id: "doctor-cos", dir: join(box.sb, "doctor-cos"), persona: fixture("doctor-cos-persona.md") },
    ];
    // Pre-trust ALL agent dirs BEFORE spawning any. convoy's per-agent pre-trust (launch.ts) races under rapid
    // multi-spawn: a sibling's booting claude reads ~/.claude.json before the NEXT sibling's trust entry is
    // written, then flushes its stale copy and clobbers that entry — stalling the sibling on the workspace-trust
    // dialog (its own comment admits the atomic write only "shrink[s] the window"). Writing every entry up front
    // means each claude's first read already has all of them, so no later flush can drop one. (convoy-core wants
    // the same batch-pre-trust for `convoy up` / a cos spawning a team — flagged as a follow-up.)
    for (const s of spawns) {
      if (s.id !== "doctor-wk") mkdirSync(s.dir, { recursive: true });
      pretrustDir(s.dir);
    }
    for (const s of spawns) {
      const args = ["add", s.role, "--identity", s.id, "--network", box.net, "--dir", s.dir, ...(s.persona ? ["--persona", s.persona] : [])];
      const add = await runConvoy(box, args);
      if (!add.ok) return { name, pass: false, detail: `convoy add ${s.id} failed: ${add.stderr.trim() || add.stdout.trim()}`, fix: "a tier failed to spawn — `convoy doctor --quick` (Hooks/Personas)" };
    }

    // Wait for all three tiers to boot + go available.
    const ids = ["doctor-cos", "doctor-sup", "doctor-wk"];
    const allUp = await pollUntil(async () => {
      for (const id of ids) if ((await runSt(box, ["status", id])).stdout.trim() !== "available") return false;
      return true;
    }, 180_000);
    if (!allUp) return { name, pass: false, detail: "not all three tiers booted to available", fix: "a tier didn't boot — check claude auth (`/login`), then re-run; or `convoy doctor --quick`" };

    // Seed the kick into the CoS's inbox — a crisp, unambiguous task (symptom, not the fix).
    const kick = [
      "TASK — fix a real bug, then report done.",
      "The worker doctor-wk owns a small ESM lib 'labelkit' (its working directory).",
      "BUG: calling format(label, {custom options}) permanently CORRUPTS the shared default options, so every",
      "later default-options call is wrong. The root cause is a mutating merge in src/format.js.",
      "FIX: make the merge non-mutating so the shared defaults are never modified; keep the existing test suite green.",
      "Then COMMIT the fix in the repo (git add -A && git commit -m ...) and report 'done' back up the chain.",
    ].join(" ");
    const send = await runSt(box, ["message", "send", "doctor-cos", "-m", kick]);
    if (!send.ok) return { name, pass: false, detail: `seeding the kick failed: ${send.stderr.trim()}`, fix: "the bus rejected the kick — check `st` on PATH" };

    // Poll until the worker has COMMITTED a fix that behaves. Gate on the COMMIT, not the working-tree file:
    // the grader reads src/format.js off disk, which flips green the instant the worker SAVES the edit — racing
    // the edit→commit gap. The commit is the durable, worker-authored artifact we actually grade on. Generous
    // budget — a false FAIL from a too-tight timeout would erode trust in doctor itself.
    const grader = fixture("grader", "ghost-bug-regression.mjs");
    const committedFix = await pollUntil(async () => {
      if ((await git("rev-parse", "HEAD")).stdout.trim() === baseSha) return false; // no commit on top of the base yet
      return (await run("node", [grader, repo])).ok; // …and the committed tree behaves (clean tree == HEAD)
    }, 420_000, 6000);
    if (!committedFix) return { name, pass: false, detail: "the CoS→sup→worker chain did not land a committed, working fix within the budget", fix: "delegation stalled or the worker fixed-but-didn't-commit — confirm the tiers boot + the bus delivers (checks 2/2b) and re-run" };

    // GRADE (held-out, ground-truth). The commit is guaranteed by the poll; validate its nature + the chain.
    const detectsBug = !(await run("node", [grader, fixture("ghost-bug")])).ok; // mutation-valid: same grader FAILS on the buggy base
    const changed = (await git("diff", "--name-only", baseSha, "HEAD")).stdout;
    const touchedSrc = changed.split("\n").some((f) => f.trim().startsWith("src/")); // a real code fix (format.js or config.js), not a docs/empty commit
    const cosToSup = await receivedFrom(box, "doctor-sup", "doctor-cos");
    const supToWk = await receivedFrom(box, "doctor-wk", "doctor-sup");

    const gaps: string[] = [];
    if (!detectsBug) gaps.push("the held-out grader did not fail on the buggy base (mutation-validity broken — file a bug)");
    if (!touchedSrc) gaps.push("the fix commit changed no src/ file (not a real code fix)");
    if (!cosToSup) gaps.push("no delegation from doctor-cos → doctor-sup on the bus");
    if (!supToWk) gaps.push("no delegation from doctor-sup → doctor-wk on the bus");
    if (gaps.length) return { name, pass: false, detail: `a committed fix landed but the org-model grade failed: ${gaps.join("; ")}`, fix: "the fix landed without a clean CoS→sup→worker chain — inspect the bus + git authorship" };

    return { name, pass: true, detail: "CoS→supervisor→worker delegated a real bug; the worker fixed + committed it (mutation-valid held-out grade); both delegation hops visible on the bus; all isolated" };
  } finally {
    await teardownSandbox(box);
  }
}
