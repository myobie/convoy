// `convoy doctor` (full) — the setup-readiness eval suite. Proves the user's machine can do real agent
// work: (1) a throwaway network stands up + spawns + tears down, (2) inbox+ding delivery works end to end,
// (3) a CoS→supervisor→worker tree fixes a real bundled bug and it grades pass. Every check is ISOLATED
// (its own ST_ROOT + PTY_ROOT under a short sandbox), self-cleaning, and never touches the prod network —
// the suite snapshots prod pty sessions before/after and asserts zero delta. Failures are NAMED + actionable.
//
// Isolation + graded-run patterns are cribbed from evals' fixtures (ghost-bug / team-standup), vendored so
// doctor is self-contained on a user machine (no evals-repo dependency at runtime).

import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isGone } from "@myobie/pty/client";
import { childEnv, run } from "../exec.ts";
import { stRootOf } from "../paths.ts";
import { shortHostname } from "../agent-spec.ts";
import { claudeConfigPath, codexConfigPath, pretrustDir, untrustDirs, untrustDirsCodex } from "../trust.ts";

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
  net: string; // the isolated network DIR; ST_ROOT = net/smalltalk, PTY_ROOT = net/pty
  env: NodeJS.ProcessEnv; // ST_ROOT (bus)/PTY_ROOT pinned to the sandbox
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
  _sandboxPaths.add(sb); // for the end-of-suite backstop sweep
  return { sb, net, env: { ...process.env, ST_ROOT: stRootOf(net), PTY_ROOT: join(net, "pty"), CONVOY_NETWORK: net } };
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

/** Every sandbox path makeSandbox has minted this run, for the end-of-suite backstop sweep. */
const _sandboxPaths = new Set<string>();

/** Tear the sandbox down: kill its sessions (convoy down --force), then remove the dir. Best-effort. Removal
 *  needs a retry loop for full self-cleaning: `convoy down` kills the sessions, but the pty-daemon's SIGTERM
 *  handler FLUSHES the exited-session metadata into `<net>/pty/*.json` a few seconds LATER — after a bare
 *  rmSync would have run — recreating the tree. It's a one-time flush (never re-touched afterward), so once we
 *  outlast it a single remove sticks. We retry ~15s (early-exit the moment removal holds). Any straggler is
 *  caught by sweepSandboxes() at end-of-suite. (We deliberately do NOT poll `pty list` to "wait for settle" —
 *  that spawns the very daemon that rewrites the metadata.) */
export async function teardownSandbox(box: Sandbox, trustDirs?: string[]): Promise<void> {
  try {
    await runConvoy(box, ["down", box.net, "--force"]);
  } catch {
    // best-effort — we still remove the dir
  }
  // Config self-cleaning window: AFTER `convoy down` has killed the sandbox agents (so no live Claude re-writes
  // its own ~/.claude.json project entry and clobbers our delete — the run-#3 lost-update finding) but BEFORE the
  // dirs are removed (realpathSync only resolves the /var→/private/var trust key while the dir still exists).
  if (trustDirs && trustDirs.length > 0) {
    untrustDirs(trustDirs);
    untrustDirsCodex(trustDirs);
  }
  for (let i = 0; i < 16; i++) {
    rmSync(box.sb, { recursive: true, force: true });
    if (!existsSync(box.sb)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** Backstop: remove any sandbox dir a per-check teardown couldn't (a pty flush that outlasted its retry loop).
 *  Run once at end-of-suite, when every daemon has long since flushed + exited, so a single remove sticks. */
export async function sweepSandboxes(): Promise<void> {
  for (const p of _sandboxPaths) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
  _sandboxPaths.clear();
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
  await sweepSandboxes(); // backstop: remove any sandbox a delayed pty flush kept a per-check teardown from clearing
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

/** The host-prefixed BUS id of a sandbox agent. The redesign names every bus folder + ST_AGENT
 *  `<host>.<identity>` (so machines sync as a clean union), and each agent sets its status / sends / receives
 *  under that prefixed id. So EVERY `st status`/`st message`/`st context` op the suite runs must target
 *  `<host>.<id>`, NOT the bare logical id — a bare `st status doctor-cos` reads a nonexistent folder ("agent
 *  folder missing for doctor-cos") so the poll never sees `available`, and a message to the bare id never
 *  reaches the prefixed inbox. (This is exactly why doctor --full's G1 "the real CoS never reached available"
 *  regressed on the new layout — the CoS booted fine; the suite polled the wrong id.) NB: `convoy add
 *  --identity <id>` / `convoy reload <id>` / filesystem dir paths stay BARE — convoy host-prefixes internally
 *  and reload matches on the workspace basename. Idempotent: an already-prefixed id passes through. */
function busId(id: string): string {
  return id.includes(".") ? id : `${shortHostname()}.${id}`;
}

/** The on-disk context dir of a sandbox agent — `<net>/smalltalk/<host>.<id>/context` (ST_ROOT is the
 *  smalltalk/ subdir; the folder is host-prefixed). Where an agent's now.md externalized work-state lives. */
function agentContextDir(box: Sandbox, id: string): string {
  return join(stRootOf(box.net), busId(id), "context");
}

/** Send a message FROM the doctor harness (a pseudo-agent, NOT a real member) into a sandbox agent's inbox.
 *  st requires the SENDER to have a known identity + its own bus folder, and `convoy doctor --full` may run
 *  from a plain HUMAN shell with NO ambient `$ST_AGENT` (a newcomer's exact case) — a bare `st message send`
 *  then dies with "st: agent required". So we NEVER rely on the runner's env: create the harness sender's bus
 *  folder + pass `--from` explicitly. Recipient + sender are host-prefixed bus ids. (Latent all along, but the
 *  host-prefix fix unmasks it by letting execution reach the kick — without this, Johannes's --full fails at
 *  the seed step even though the CoS booted.) Returns {ok, stderr} matching the runSt shape callers expect. */
const HARNESS_SENDER = "doctor-harness";
async function sendFromHarness(box: Sandbox, toId: string, body: string): Promise<{ ok: boolean; stderr: string }> {
  const from = busId(HARNESS_SENDER);
  mkdirSync(join(stRootOf(box.net), from, "inbox"), { recursive: true });
  mkdirSync(join(stRootOf(box.net), from, "archive"), { recursive: true });
  const r = await runSt(box, ["message", "send", busId(toId), "--from", from, "-m", body]);
  return { ok: r.ok, stderr: r.stderr };
}

/** A STABLE, greppable one-line gate summary for the --full org proof, emitted to stderr as a `[full-org] GATE …`
 *  note. Lets an eval (or a human) HARD-gate on the DETERMINISTIC org-proof core — g1 (CoS hands-off boot) +
 *  cos_sup + sup_wk + graded_fix — and read the non-deterministic restart-straddle ADVISORY, independent of
 *  prose wording and of the straddle-coupled rc/headline (a straddle flake fails the whole check → rc=1, so
 *  rc/headline can't be a stable gate; this line can). Values are pass|fail; straddle is also `skip` when there
 *  was no committed fix to restart onto. Emitted at the G1 early-return AND once all gates are decided. */
export function fullOrgGateLine(g: { g1: boolean; cosSup: boolean; supWk: boolean; gradedFix: boolean; straddle: boolean | null }): string {
  const v = (b: boolean): string => (b ? "pass" : "fail");
  return `GATE g1=${v(g.g1)} cos_sup=${v(g.cosSup)} sup_wk=${v(g.supWk)} graded_fix=${v(g.gradedFix)} straddle=${g.straddle === null ? "skip" : v(g.straddle)}`;
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
    const avail = await pollUntil(async () => (await runSt(box, ["status", busId("doctor-rx")])).stdout.trim() === "available", 120_000);
    if (!avail) return { name, pass: false, detail: "recipient never became available (didn't boot)", fix: "the agent didn't boot — check claude auth (`/login`) then re-run; or `convoy doctor --quick`" };

    // Send it a message; a working ding must poke the (idle) agent so it drains + archives.
    const send = await sendFromHarness(box, "doctor-rx", "doctor ding probe — read and archive this, then stand by");
    if (!send.ok) return { name, pass: false, detail: `st message send failed: ${send.stderr.trim()}`, fix: "the bus rejected the message — check `st` on PATH" };

    const drained = await pollUntil(async () => {
      const c = await runSt(box, ["message", "ls", busId("doctor-rx"), "--count"]);
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

    const avail = await pollUntil(async () => (await runSt(box, ["status", busId("doctor-sx")])).stdout.trim() === "available", 120_000);
    if (!avail) return { name, pass: false, detail: "agent never became available (didn't boot)", fix: "the agent didn't boot — check claude auth (`/login`)" };

    // Externalize durable work-state: seed now.md with a resume task the reconstructed agent will act on.
    const token = `SX-${process.pid}-${box.sb.slice(-6)}`;
    const logPath = join(sxDir, "RECONSTRUCTED.log");
    const nowMd = join(agentContextDir(box, "doctor-sx"), "now.md");
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
  const c = await runSt(box, ["message", "ls", busId(id), "--count"]);
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

    const avail = await pollUntil(async () => (await runSt(box, ["status", busId("doctor-xo")])).stdout.trim() === "available", 120_000);
    if (!avail) return { name, pass: false, detail: "agent never became available (didn't boot)", fix: "the agent didn't boot — check claude auth (`/login`)" };

    const token = `XO-${process.pid}-${box.sb.slice(-6)}`;
    // 1st delivery: the agent should append the token once + archive.
    const send1 = await sendFromHarness(box, "doctor-xo", token);
    if (!send1.ok) return { name, pass: false, detail: `st message send failed: ${send1.stderr.trim()}`, fix: "the bus rejected the message — check `st` on PATH" };
    const processed = await pollUntil(async () => existsSync(logPath) && countOccurrences(readFileSync(logPath, "utf8"), token) >= 1 && (await inboxCount(box, "doctor-xo")) === 0, 150_000);
    if (!processed) return { name, pass: false, detail: "agent never processed the first delivery (token not appended or inbox not drained)", fix: "the agent didn't act on its ding — check `convoy doctor` checks 2/4" };

    // Restart leg: re-deliver the SAME message un-archived, cold-restart, and demand it NOT re-act.
    const send2 = await sendFromHarness(box, "doctor-xo", token);
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
  const [rx, tx] = [busId(recipient), busId(sender)]; // both sides are host-prefixed bus ids on the new layout
  const inbox = parseCount((await runSt(box, ["message", "ls", rx, "--from", tx, "--count"])).stdout);
  const arch = parseCount((await runSt(box, ["message", "ls", rx, "--archive", "--from", tx, "--count"])).stdout);
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
      for (const id of ids) if ((await runSt(box, ["status", busId(id)])).stdout.trim() !== "available") return false;
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
    const send = await sendFromHarness(box, "doctor-cos", kick);
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

// ============================================================================
// `convoy doctor --full` — the REAL autonomous-org proof (opt-in, slower).
// Where the default suite proves the reliable CORE via thin deterministic stand-ins, --full spins the user's
// REAL chief-of-staff + supervisor + worker personas through the real workflows end-to-end: hands-off
// bring-up under `convoy up`, an autonomous CoS→supervisor→worker delegation chain on the bus, and a real
// graded worker fix. Reliability-by-design: the tooling is deterministic; the ONE non-deterministic thing
// (agent reasoning) is minimized with an UNAMBIGUOUS task (one clear bug, one prescribed delegation path);
// any failure on that clear task is surfaced as a specific finding to root-cause, never tolerated as flake.
// ============================================================================

/** Pre-seed a POPULATED private `cos` repo so the real chief-of-staff persona SKIPS its first-run interview.
 *  first-run-interview.md gates the interview on a precise signal: a populated repo = `identity.md` exists
 *  AND has a non-empty `name:`. We write that (plus minimal trackers marking the network HEADLESS, so the real
 *  CoS persona doesn't stall waiting on a principal for pushes/forms) and commit with a repo-local git identity
 *  (works with no global git user). Returns an error string on failure, else null. */
async function seedCosRepo(dir: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "identity.md"),
    "---\nname: Doctor Principal\ntimezone: UTC\n---\n\nAutonomous readiness-check principal. This network is HEADLESS: no human is at the keyboard, no push/notification transport is wired, and there is no forms UI. Operate fully autonomously and report on the smalltalk bus.\n",
  );
  writeFileSync(join(dir, "priorities.md"), "# Priorities\n\n1. Fix the one bug delegated on the bus, via the CoS→supervisor→worker chain, then report done.\n");
  writeFileSync(join(dir, "team.md"), "# Team\n\nStand up specialists on demand as work arrives on the bus.\n");
  writeFileSync(join(dir, "comms.md"), "# Comms\n\nHEADLESS network — no principal attached. Never push notifications, never present forms, never wait for a human. Every report goes on the smalltalk bus.\n");
  const git = async (...a: string[]): Promise<boolean> => (await run("git", a, { cwd: dir, env })).ok;
  for (const a of [["init", "-q"], ["config", "user.name", "doctor-cos"], ["config", "user.email", "cos@doctor.local"], ["add", "-A"], ["commit", "-q", "-m", "cos: pre-seeded setup (skip first-run interview)"]]) {
    if (!(await git(...a))) return `git ${a[0]} failed while seeding the cos repo`;
  }
  return null;
}

/** Materialize the bundled buggy 'labelkit' repo as a git repo with the buggy base committed (so the worker
 *  commits its fix ON TOP + we have a base to diff/grade against). Repo-local git identity. */
async function materializeGhostBug(repo: string, env: NodeJS.ProcessEnv): Promise<{ baseSha: string } | { error: string }> {
  mkdirSync(repo, { recursive: true });
  cpSync(fixture("ghost-bug"), repo, { recursive: true });
  const git = async (...a: string[]): Promise<ExecLike> => await run("git", a, { cwd: repo, env });
  for (const a of [["init", "-q"], ["config", "user.name", "doctor-worker"], ["config", "user.email", "worker@doctor.local"], ["add", "-A"], ["commit", "-q", "-m", "labelkit: initial (buggy)"]]) {
    if (!(await git(...a)).ok) return { error: `git ${a[0]} failed materializing the buggy worker repo` };
  }
  return { baseSha: (await git("rev-parse", "HEAD")).stdout.trim() };
}

type ExecLike = { ok: boolean; stdout: string; stderr: string };

/** Host the sandbox network with `convoy up` in the BACKGROUND — the adopter's real hosting path (it adopts +
 *  reconciles the members and would respawn a crashed permanent). Returns a `stop()` that SIGTERMs the host and
 *  resolves when it exits (Nomad model: stopping the host DETACHES the agents — they keep running — so a
 *  subsequent `convoy down` is what actually tears them down). `stop()` never hangs teardown (5s cap). */
function backgroundUp(box: Sandbox): { stop: () => Promise<void> } {
  const child = spawn("node", [convoyBin(), "up", box.net], { env: childEnv(box.env), stdio: "ignore" });
  child.on("error", () => {}); // best-effort: a host that fails to spawn must not crash the check
  return {
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        const done = (): void => resolve();
        child.once("exit", done);
        try {
          child.kill("SIGTERM");
        } catch {
          return resolve();
        }
        setTimeout(done, 5000);
      }),
  };
}

/** CHECK (--full) — the REAL autonomous org produces a graded fix. Spins the user's real chief-of-staff (no
 *  persona override), hosts under `convoy up`, and seeds ONE unambiguous kick: the CoS spawns a real supervisor,
 *  which spawns a real worker, which fixes + COMMITS the bundled ghost-bug. Graded held-out + ground-truth:
 *  (G1) the CoS boots hands-off to available (interview pre-seeded away, dirs pre-trusted); (G2) the delegation
 *  chain is visible on the bus at BOTH hops (cos→sup, sup→wk); (G3) the worker's repo passes a MUTATION-VALID
 *  grader that provably FAILS on the pristine buggy base, via a commit touching src/. Fully isolated + torn
 *  down. Unlike the default dev-task check, doctor does NOT pre-spawn the tiers — the CoS and supervisor really
 *  spawn their reports; that autonomous spawning IS the thing being proven. */
export async function checkFullOrg(): Promise<CheckResult> {
  const name = "full autonomous org — real CoS→supervisor→worker (init/up · delegation · graded fix)";
  let box: Sandbox;
  try {
    box = makeSandbox("full");
  } catch (e) {
    return { name, pass: false, detail: e instanceof Error ? e.message : String(e), fix: "set TMPDIR to a shorter path (pty sockets must fit ~104 bytes)" };
  }
  let up: { stop: () => Promise<void> } | null = null;
  // Progress to stderr: a real multi-agent run takes minutes; a silent wait is bad UX (and blind to debug).
  const note = (s: string): void => {
    process.stderr.write(`[full-org] ${s}\n`);
  };
  // Declared out here (basename == identity) so the finally can clean up their trust entries. Pre-seed the
  // populated cos repo (skips the interview), materialize the buggy worker repo, pre-create the supervisor's dir.
  const cosRepo = join(box.sb, "doctor-cos");
  const supDir = join(box.sb, "doctor-sup");
  const workerRepo = join(box.sb, "doctor-wk");
  try {
    const init = await runConvoy(box, ["init", box.net, "--no-channel"]);
    if (!init.ok) return { name, pass: false, detail: `convoy init failed: ${init.stderr.trim() || init.stdout.trim()}`, fix: "run `convoy doctor --quick`" };

    // Pre-trust ALL THREE dirs up front: the CoS/supervisor spawn their reports one at a time (so per-add trust
    // would also cover it), but up-front pre-trust removes a degree of freedom = more reliable.
    const seedErr = await seedCosRepo(cosRepo, box.env);
    if (seedErr) return { name, pass: false, detail: seedErr, fix: "git is required for --full — install it and re-run" };
    const ghost = await materializeGhostBug(workerRepo, box.env);
    if ("error" in ghost) return { name, pass: false, detail: ghost.error, fix: "git is required for --full — install it and re-run" };
    mkdirSync(supDir, { recursive: true });
    for (const d of [cosRepo, supDir, workerRepo]) pretrustDir(d);
    note(`sandbox ${box.sb} — pre-seeded cos repo + buggy worker repo, pre-trusted 3 dirs`);

    // Bring up the REAL chief-of-staff (no persona override — the real persona; permanent by role) pointed at
    // the pre-seeded repo, then HOST with `convoy up` (background; SIGTERM'd at teardown).
    const addCos = await runConvoy(box, ["add", "chief-of-staff", "--identity", "doctor-cos", "--network", box.net, "--dir", cosRepo]);
    if (!addCos.ok) return { name, pass: false, detail: `convoy add chief-of-staff failed: ${addCos.stderr.trim() || addCos.stdout.trim()}`, fix: "the CoS didn't spawn — `convoy doctor --quick` (Hooks/Personas)" };
    up = backgroundUp(box);
    note("real chief-of-staff spawned; convoy up hosting — waiting for hands-off boot (up to 3min)…");

    // G1 — hands-off bring-up: the CoS boots to available with NO trust prompt + NO interview stall.
    const cosUp = await pollUntil(async () => (await runSt(box, ["status", busId("doctor-cos")])).stdout.trim() === "available", 180_000);
    if (!cosUp) {
      note(fullOrgGateLine({ g1: false, cosSup: false, supWk: false, gradedFix: false, straddle: null }));
      return { name, pass: false, detail: "the real CoS never reached available (didn't boot hands-off)", fix: "the CoS stalled on boot — likely the first-run interview didn't skip (check the pre-seeded identity.md `name:`) or a workspace-trust prompt; verify claude auth (`/login`) + `convoy doctor --quick`" };
    }
    note("CoS available (hands-off boot ✓) — seeding the kick");

    // Seed ONE unambiguous kick. Prescriptive on MECHANICS (identities, dirs, exact commands) so the only
    // non-determinism is the org REASONING we're proving (delegate down the chain + fix). Explicitly HEADLESS
    // so the real CoS persona doesn't park waiting on a principal (no pushes / forms / human).
    const kick = [
      "TASK (autonomous, HEADLESS — this arrived on the network bus, NOT from a human principal. There is NO principal attached: do NOT push notifications, do NOT present forms, do NOT wait for any human. Operate fully autonomously; the smalltalk bus is your only channel; report completion there.)",
      "",
      "Stand up the org to fix ONE real bug, delegating down the FULL chain CoS -> supervisor -> worker:",
      `1. You (CoS) spawn a supervisor: convoy add supervisor --identity doctor-sup --network ${box.net} --dir ${supDir} (already trusted). Brief it, and drive it to available. ALWAYS pass --network ${box.net} on every convoy add so the agent + its ding sidecar land on THIS network (a bare add would leak into the global pty root).`,
      `2. Have the supervisor spawn a worker in the buggy repo: convoy add worker --identity doctor-wk --network ${box.net} --dir ${workerRepo} (already trusted). Brief it, and drive it to available. (Same rule: the supervisor MUST pass --network ${box.net}.)`,
      `3. The worker owns the ESM lib 'labelkit' at ${workerRepo}. BUG: calling format(label, {custom options}) permanently CORRUPTS the shared default options (a mutating merge in src/format.js), so every later default-options call is wrong. FIX: make the merge non-mutating so the shared defaults are never modified; keep the existing test suite green. Then COMMIT the fix (git add -A && git commit -m ...).`,
      "4. Report 'done' back up the chain (worker -> supervisor -> CoS) on the bus.",
      "",
      "Do it now, autonomously.",
    ].join("\n");
    const send = await sendFromHarness(box, "doctor-cos", kick);
    if (!send.ok) return { name, pass: false, detail: `seeding the kick failed: ${send.stderr.trim()}`, fix: "the bus rejected the kick — check `st` on PATH" };
    note("kick sent — waiting for the org to delegate + fix (up to ~13min)…");

    // G2 — the delegation chain runs autonomously + shows on the bus at BOTH hops; G3 — the worker committed a
    // fix that BEHAVES. One combined loop (gate G3 on the COMMIT, not the working tree, so we don't race the
    // edit→commit gap), with a heartbeat that logs the org's live state so a long wait isn't blind. Generous
    // budget — a false FAIL from a tight timeout would erode trust in doctor itself.
    const grader = fixture("grader", "ghost-bug-regression.mjs");
    const git = async (...a: string[]): Promise<ExecLike> => await run("git", a, { cwd: workerRepo, env: box.env });
    let cosToSup = false;
    let supToWk = false;
    let committedFix = false;
    const deadline = Date.now() + 780_000; // ~13min
    for (let i = 0; Date.now() < deadline; i++) {
      if (!cosToSup) cosToSup = await receivedFrom(box, "doctor-sup", "doctor-cos");
      if (!supToWk) supToWk = await receivedFrom(box, "doctor-wk", "doctor-sup");
      const committed = (await git("rev-parse", "HEAD")).stdout.trim() !== ghost.baseSha;
      committedFix = committed && (await run("node", [grader, workerRepo])).ok;
      if (cosToSup && supToWk && committedFix) break;
      if (i % 5 === 0) {
        const stat = async (id: string): Promise<string> => (await runSt(box, ["status", busId(id)])).stdout.trim() || "—";
        note(`… cos→sup=${cosToSup} sup→wk=${supToWk} committed=${committed} graded=${committedFix} | status cos=${await stat("doctor-cos")} sup=${await stat("doctor-sup")} wk=${await stat("doctor-wk")}`);
      }
      await new Promise((r) => setTimeout(r, 6000));
    }
    note(`wait done — cos→sup=${cosToSup} sup→wk=${supToWk} graded-fix=${committedFix}`);

    // Grade G2/G3 — real-state / held-out / mutation-valid.
    const detectsBug = !(await run("node", [grader, fixture("ghost-bug")])).ok; // the same grader FAILS on the buggy base
    const changed = committedFix ? (await git("diff", "--name-only", ghost.baseSha, "HEAD")).stdout : "";
    const touchedSrc = changed.split("\n").some((f) => f.trim().startsWith("src/"));

    // G4 — restart-continuity (cold, no --resume). Only meaningful once the worker did real org work (a committed
    // fix = the "before" unit). Externalize a NEW resumed task in the worker's now.md, cold-restart it via
    // `convoy reload` (respawns from the STORED pty.toml command = NO --resume = a fresh transcript; also dodges
    // the "already inside a pty session" failure `pty restart -y` hits from within doctor's own pty), and assert
    // the cold-booted worker reconstructs the task from now.md via the SessionStart hook + acts on it. Ungameable
    // (evals' straddle design): the token is unique + lives ONLY in now.md (injected post-boot) so it cannot
    // pre-exist, and the reconstruction artifact STRADDLES the restart — real work (the fix commit) landed BEFORE
    // the reload epoch, the artifact lands AFTER — proving RESUMED, not front-loaded.
    let restartOk: boolean | null = null; // null = not attempted (no committed fix to restart onto)
    let straddled = false;
    if (committedFix) {
      const rcToken = `RC-${process.pid}-${box.sb.slice(-6)}`;
      const rcLog = join(workerRepo, "RECONSTRUCTED.log");
      const nowMd = join(agentContextDir(box, "doctor-wk"), "now.md");
      mkdirSync(dirname(nowMd), { recursive: true });
      writeFileSync(nowMd, `# Current task (durable working state)\n\nYou were restarted mid-task. Your ONE resumed task: run this shell command EXACTLY, then stand by:\n\n    echo "${rcToken}" >> "${rcLog}"\n\nDo it now if RECONSTRUCTED.log does not already contain that token.\n`);
      const reloadEpoch = Date.now();
      note("G3 ✓ — cold-restarting the worker (convoy reload, no --resume) to prove restart-continuity…");
      const reload = await runConvoy(box, ["reload", "doctor-wk", "--network", box.net]);
      if (!reload.ok) {
        restartOk = false;
        note(`reload failed: ${reload.stderr.trim() || reload.stdout.trim()}`);
      } else {
        restartOk = await pollUntil(async () => existsSync(rcLog) && readFileSync(rcLog, "utf8").includes(rcToken), 300_000, 6000);
        if (restartOk) {
          try {
            straddled = statSync(rcLog).mtimeMs >= reloadEpoch; // the reconstruction artifact appeared AFTER the restart epoch
          } catch {
            straddled = false;
          }
        }
        note(`restart-continuity: reconstructed=${restartOk} straddled=${straddled}`);
      }
    }

    // STABLE gate line — all gates now decided. g1 is pass here (a G1 fail returned early above). graded_fix is
    // the FULL G3 validity (committed + mutation-valid grader + touched src/). straddle: skip if no committed
    // fix to restart onto, else pass only if reconstructed AND straddled the restart epoch.
    note(
      fullOrgGateLine({
        g1: true,
        cosSup: cosToSup,
        supWk: supToWk,
        gradedFix: committedFix && detectsBug && touchedSrc,
        straddle: restartOk === null ? null : restartOk === true && straddled,
      }),
    );

    const gaps: string[] = [];
    if (!cosToSup) gaps.push("G2: no delegation from the CoS to a supervisor on the bus (the CoS didn't stand up + brief a supervisor)");
    if (!supToWk) gaps.push("G2: no delegation from the supervisor to a worker on the bus (the supervisor didn't spawn + brief the worker)");
    if (!committedFix) gaps.push("G3: the worker did not land a committed, behaving fix within the budget");
    if (committedFix && !detectsBug) gaps.push("G3: the held-out grader did not fail on the buggy base (mutation-validity broken — file a bug)");
    if (committedFix && !touchedSrc) gaps.push("G3: the fix commit changed no src/ file (not a real code fix)");
    if (restartOk === false) gaps.push("G4: the cold-restarted worker did NOT reconstruct its now.md task (SessionStart didn't inject it, or the agent didn't act) — agents won't survive a restart on this setup");
    if (restartOk === true && !straddled) gaps.push("G4: the restart-continuity artifact did not land AFTER the restart epoch (front-loaded?) — the straddle check failed");
    if (gaps.length) return { name, pass: false, detail: `the real org did not complete cleanly: ${gaps.join("; ")}`, fix: "a reliability finding, NOT a flake — root-cause the named gate: `convoy doctor --quick` for plumbing, then inspect the bus (`st message ls` per tier) + the CoS/supervisor terminals (`pty peek`) for a persona stall (e.g. the CoS parked waiting on a principal)" };

    return { name, pass: true, detail: "real CoS spawned+briefed a real supervisor, which spawned+briefed a real worker, which fixed + COMMITTED the bug (mutation-valid held-out grade); both delegation hops visible on the bus; the worker survived a cold restart (no --resume) + reconstructed its task from now.md (straddled the restart); hands-off bring-up under `convoy up`; all isolated" };
  } finally {
    if (up) await up.stop(); // stop hosting (agents detach + keep running) before teardown tears them down
    // teardownSandbox kills the agents THEN cleans up the trust entries doctor wrote for these ephemeral sandbox
    // dirs (claude's ~/.claude.json + codex's ~/.codex/config.toml) — after-kill so no live Claude re-adds them,
    // before-rm so the realpath trust key still resolves. Best-effort; the gate also tolerates any /cvd- residue.
    await teardownSandbox(box, [cosRepo, supDir, workerRepo]);
  }
}

/** A snapshot of DURABLE (on-disk, survive-a-session) schedulers — the ONLY place a leaked cron could persist.
 *  Harness crons (CronCreate) are session-only + in-memory (nothing on disk; deleted when the Claude session
 *  exits), so both the CoS shepherd cron and the supervisor watchdog cron die when `convoy down` kills their
 *  sessions. The only way a run could leak a durable cron is an OS-level scheduler, which the real personas do
 *  not create — so an unchanged snapshot across a --full run (which spins a REAL supervisor that arms its
 *  session-only watchdog) EMPIRICALLY confirms nothing leaked to prod. We read the user crontab + convoy/st/pty
 *  launchd job LABELS (labels, not PIDs — PIDs churn). */
async function durableSchedulerSnapshot(): Promise<string> {
  const crontab = await run("crontab", ["-l"]); // "no crontab for user" → non-zero + empty
  const cron = crontab.ok ? crontab.stdout.trim() : "";
  const launch = await run("launchctl", ["list"]);
  const jobs = launch.ok
    ? launch.stdout
        .split("\n")
        .map((l) => l.split("\t").pop() ?? "")
        .filter((label) => /convoy|smalltalk|doctor|\bpty\b/i.test(label))
        .sort()
        .join(",")
    : "";
  return `crontab=[${cron}] launchd=[${jobs}]`;
}

/** A snapshot of the trust CONFIG (project-trust keys in both harness configs) so the gate can assert --full
 *  left prod config untouched — its teardown cleans up the sandbox-dir entries it wrote, so this must match.
 *  Returns the key SETS (not a joined string) so the gate can report only the DELTA on a mismatch — never dump
 *  the user's whole (large) project list. */
function configSnapshot(): { claude: string[]; codex: string[] } {
  let claude: string[] = [];
  try {
    const c: { projects?: Record<string, unknown> } = JSON.parse(readFileSync(claudeConfigPath(), "utf8"));
    claude = Object.keys(c.projects ?? {}).sort();
  } catch {
    // no config → empty
  }
  let codex: string[] = [];
  try {
    codex = readFileSync(codexConfigPath(), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("[projects."))
      .sort();
  } catch {
    // no config → empty
  }
  return { claude, codex };
}

/** Keys present in `after` but not `before` (the leak), and vice-versa. */
function keyDelta(before: string[], after: string[]): { added: string[]; removed: string[] } {
  const b = new Set(before);
  const a = new Set(after);
  return { added: after.filter((k) => !b.has(k)), removed: before.filter((k) => !a.has(k)) };
}

/** Run the FULL autonomous-org suite (`convoy doctor --full`): the real-org check + a prod-untouched gate.
 *  Opt-in + slower than the default readiness suite because it runs real multi-agent workflows end to end. */
export async function runFullOrgSuite(): Promise<number> {
  const out = (s = ""): void => {
    process.stdout.write(`${s}\n`);
  };
  out();
  out("Full autonomous-org proof (--full) — a REAL CoS→supervisor→worker network in an isolated sandbox.");
  out("This spins real agents through the real workflows and takes several minutes. Your prod network is untouched.");
  // Prod-untouched gate — the isolation proof, across THREE dimensions: pty SESSIONS, durable CRONS/schedulers,
  // and trust CONFIG. Snapshot all three before + after; a leak in any one fails the gate + names the dimension.
  const prodBefore = await ptySessionNames(); // default PTY_ROOT = the user's prod root
  const schedBefore = await durableSchedulerSnapshot();
  const configBefore = configSnapshot();

  const results: CheckResult[] = [];
  results.push(await checkFullOrg());

  const prodAfter = await ptySessionNames();
  const schedAfter = await durableSchedulerSnapshot();
  const configAfter = configSnapshot();
  const added = [...prodAfter].filter((s) => !prodBefore.has(s));
  const removed = [...prodBefore].filter((s) => !prodAfter.has(s));
  // Ignore doctor's own ephemeral sandbox-dir entries (`/cvd-…` mkdtemp paths that reference now-deleted temp
  // dirs — harmless dead keys). Teardown cleans them best-effort, but the shared ~/.claude.json is written
  // concurrently by every live Claude instance, so a raced re-add is possible; tolerating them here keeps the
  // gate RELIABLE while still failing on any REAL prod-config change (a prod dir never contains `/cvd-`).
  const notSandbox = (k: string): boolean => !k.includes("/cvd-");
  const claudeDelta = keyDelta(configBefore.claude.filter(notSandbox), configAfter.claude.filter(notSandbox));
  const codexDelta = keyDelta(configBefore.codex.filter(notSandbox), configAfter.codex.filter(notSandbox));
  const sessionsOk = added.length === 0 && removed.length === 0;
  const cronsOk = schedBefore === schedAfter;
  const configOk = claudeDelta.added.length === 0 && claudeDelta.removed.length === 0 && codexDelta.added.length === 0 && codexDelta.removed.length === 0;
  const leaks: string[] = [];
  if (!sessionsOk) leaks.push(`SESSIONS — added [${added.join(", ")}] removed [${removed.join(", ")}]`);
  if (!cronsOk) leaks.push(`CRONS/schedulers — a durable scheduler changed (before=${schedBefore} after=${schedAfter})`);
  if (!configOk) {
    const parts: string[] = [];
    if (claudeDelta.added.length) parts.push(`claude +[${claudeDelta.added.join(", ")}]`);
    if (claudeDelta.removed.length) parts.push(`claude -[${claudeDelta.removed.join(", ")}]`);
    if (codexDelta.added.length) parts.push(`codex +[${codexDelta.added.join(", ")}]`);
    if (codexDelta.removed.length) parts.push(`codex -[${codexDelta.removed.join(", ")}]`);
    leaks.push(`CONFIG — a trust entry survived teardown: ${parts.join("; ")}`);
  }
  results.push({
    name: "prod untouched (sessions + crons + config)",
    pass: leaks.length === 0,
    detail:
      leaks.length === 0
        ? `prod pty sessions unchanged (${prodBefore.size} live); durable schedulers (crontab/launchd) unchanged — the real supervisor's session-only watchdog cron left NO on-disk trace + died with convoy down (verified empirically); prod trust config unchanged (doctor's ephemeral sandbox entries cleaned best-effort + ignored)`
        : `prod delta — ${leaks.join(" | ")}`,
    fix: leaks.length === 0 ? undefined : "a check leaked into prod — isolation breach, file a bug (the named dimension localizes it)",
  });

  out();
  for (const r of results) {
    out(`  ${r.pass ? "✓" : "✗"} ${r.name}`);
    out(`      ${r.detail}`);
    if (!r.pass && r.fix) out(`      → fix: ${r.fix}`);
  }
  await sweepSandboxes();
  const failed = results.filter((r) => !r.pass).length;
  out();
  if (failed === 0) {
    out("✓ the full autonomous org works on this machine — a real CoS→supervisor→worker delegated + shipped a graded fix, hands-off.");
    return 0;
  }
  out(`✗ ${failed} full-org check${failed === 1 ? "" : "s"} failed — see the → fix lines above.`);
  return 1;
}
