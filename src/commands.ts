// convoy CLI command handlers, ported from Sources/convoy/Commands/*.swift + Runner.swift. Each
// returns an exit code. Small arg helpers keep the hand-rolled parsing consistent (like pty's cli.ts).

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./exec.ts";
import { CONVOY_DIR, defaultConvoyNetwork, isNetworkName, networkDirForName, networkLayout, stRootOf } from "./paths.ts";
import { defaultBinDir, installClis } from "./install-cli.ts";
import { Bus, isLive, type Agent } from "./bus.ts";
import { PtyHost, spawnFromPtyFile, workspaceOfPtyfile, type SupervisedSession } from "./host.ts";
import { busIdOf } from "./up.ts";
import { discoverSmalltalkDir, nativeLaunch, regenerateDingRoot } from "./launch.ts";
import { authReadiness } from "./doctor/auth.ts";
import { harnessCheckups } from "./doctor/checkup.ts";
import { gitUsableCheck, nodeVersionCheck, osCheck, tmpdirSocketCheck } from "./doctor/env.ts";
import { compactHookHealth } from "./doctor/hooks.ts";
import { runFullOrgSuite, runReadinessSuite } from "./doctor/suite.ts";
import { baseFile, ensureInstalled, personasDir, personasInstalled } from "./personas.ts";
import { ROLES, parseRole } from "./role.ts";
import { preflight, type AgentSpec, type Harness, type Transport } from "./agent-spec.ts";
import { claudeConfigPath, codexConfigPath, pretrustDirs, pretrustDirsCodex } from "./trust.ts";

// ---- arg helpers ----
export function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      if (a.includes("=") || BOOL_FLAGS.has(a)) continue; // `--flag=value` (inline) or a bool: consumes no next token
      i++; // value-option: skip its value
    } else if (!a.startsWith("-")) {
      out.push(a);
    }
  }
  return out;
}
const BOOL_FLAGS = new Set(["--dry-run", "--yes", "-y", "--mcp", "--permanent", "--purge", "--json", "--live-only", "--no-channel", "--force"]);
/** Value of `--name` — supports both `--name value` and `--name=value` (the `=` form previously fell
 *  through and silently defaulted, e.g. `--harness=codex` → claude). */
export function optValue(args: string[], name: string): string | null {
  const eq = `${name}=`;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === name) return i + 1 < args.length ? args[i + 1]! : null;
    if (a.startsWith(eq)) return a.slice(eq.length);
  }
  return null;
}
export function hasFlag(args: string[], ...names: string[]): boolean {
  return names.some((n) => args.includes(n));
}

/** The first `-…` token in `args` that isn't a recognized flag (else null) — so a command can REJECT a
 *  mistyped/unsupported flag instead of silently ignoring it (the silent-false-flag footgun: e.g.
 *  `--no-hooks` returned rc=0 but was ignored). `bool` flags stand alone; `value` flags take the next
 *  token or an inline `--flag=value`. */
export function unknownFlag(args: string[], bool: string[], value: string[]): string | null {
  const boolSet = new Set(bool);
  const valueSet = new Set(value);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("-")) continue; // positional
    const name = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
    if (boolSet.has(name)) continue;
    if (valueSet.has(name)) {
      if (!a.includes("=")) i++; // space-separated value — skip its token
      continue;
    }
    return a; // unrecognized
  }
  return null;
}

/** The effective network DIR, in priority order: an explicit network arg/`--network` (a bare NAME like
 *  `default` resolves to `<home>/<name>`; a path is used as-is), else ambient `ST_ROOT`, else convoy's
 *  OWN default network (`<home>/default`). Falling back to the convoy default (last resort) means a bare
 *  `convoy <cmd>` targets convoy's network instead of st/pty's global `~/.local/state/smalltalk` root (the
 *  ST_ROOT-unset footgun behind the 15-dings-on-the-wrong-root incident). Explicit arg / ST_ROOT always
 *  win — the default is only the fallback. Never null. */
export function resolveNetworkRoot(cliNetwork: string | null): string {
  if (cliNetwork) return isNetworkName(cliNetwork) ? networkDirForName(cliNetwork) : cliNetwork;
  return process.env["ST_ROOT"] ?? defaultConvoyNetwork();
}

function out(s = ""): void {
  process.stdout.write(`${s}\n`);
}
function err(s: string): void {
  process.stderr.write(`convoy: ${s}\n`);
}
function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function expandTilde(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}
async function whichCmd(cmd: string): Promise<string | null> {
  const r = await run("/usr/bin/env", ["sh", "-c", `command -v ${cmd}`]);
  return r.ok ? r.stdout.trim() : null;
}
/** Does `cmd` resolve on the process's RAW `$PATH` — i.e. what the USER's shell actually sees? (whichCmd above
 *  uses convoy's enrichedPath, a superset incl ~/.local/bin + the login shell, so it can find tools the user's
 *  shell can't — e.g. right after `install-cli` when the bin dir isn't on PATH yet. This catches that gap.) */
function onRawPath(cmd: string): boolean {
  for (const dir of (process.env["PATH"] ?? "").split(delimiter).filter(Boolean)) {
    if (existsSync(join(dir, cmd))) return true;
  }
  return false;
}

// pty caps PTY_ROOT at 90 bytes — the Unix-domain socket path (PTY_ROOT + sock name) must fit the
// 104-byte kernel limit. A too-long network path fails cryptically at spawn ("session failed to
// spawn"); doctor + init check it upfront so it fails EARLY with a clear message.
export const PTY_ROOT_MAX_BYTES = 90;
/** Resolve the absolute PTY_ROOT a network will use (`<network>/pty`) and check pty's 90-byte cap. */
export function checkPtyRoot(networkRoot: string | null): { ptyRoot: string; bytes: number; ok: boolean } {
  const ptyRoot = networkRoot
    ? join(resolve(expandTilde(networkRoot)), "pty")
    : process.env["PTY_ROOT"] ?? join(process.env["ST_ROOT"] ?? join(homedir(), ".local", "state", "smalltalk"), "pty");
  const bytes = Buffer.byteLength(ptyRoot, "utf8");
  return { ptyRoot, bytes, ok: bytes <= PTY_ROOT_MAX_BYTES };
}
export function pathTooLongMessage(bytes: number): string {
  return `PTY_ROOT path is ${bytes} bytes, must be ${PTY_ROOT_MAX_BYTES} or fewer — pick a shorter network location.`;
}

/** POSIX-safe single-quote of an arbitrary string for `eval` (wraps in '…', escaping any embedded '). */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** The eval-safe shell exports that target a network's env, DERIVED from the network dir: ST_ROOT (the
 *  bus, `<dir>/smalltalk`), PTY_ROOT (`<dir>/pty`), CONVOY_NETWORK (the network dir itself), and ST_AGENT
 *  — SET to `identity` if acting-as an agent, else explicitly UNSET (a human shell is not an agent). Pure. */
export function networkEnvExports(networkDir: string, identity: string | null): string[] {
  const l = networkLayout(networkDir);
  return [
    `export ST_ROOT=${shellQuote(l.stRoot)}`,
    `export PTY_ROOT=${shellQuote(l.ptyRoot)}`,
    `export CONVOY_NETWORK=${shellQuote(networkDir)}`,
    identity ? `export ST_AGENT=${shellQuote(identity)}` : "unset ST_AGENT",
  ];
}

/** Resolve the `[network]` positional (or `--network`, else ambient ST_ROOT) to an absolute
 *  `{ root, ptyRoot }` derived from the real network layout (never hardcoded) — or an `{ error }`.
 *  Shared by `convoy env` (print exports) and `convoy shell` (spawn a subshell with them). */
export function resolveNetworkEnv(args: string[]): { networkDir: string; stRoot: string; ptyRoot: string } | { error: string } {
  const net = resolveNetworkRoot(positionals(args)[0] ?? optValue(args, "--network")); // never null (falls back to the convoy default)
  const networkDir = resolve(expandTilde(net));
  if (!isDir(networkDir)) return { error: `network dir not found: ${networkDir} — run \`convoy init\` to create it, or pass an existing network.` };
  const l = networkLayout(networkDir);
  return { networkDir, stRoot: l.stRoot, ptyRoot: l.ptyRoot };
}

/** `convoy env [network] [--identity <id>]` — print eval-safe exports for a network's env, so
 *  `eval "$(convoy env <net>)"` targets that network's ST_ROOT + PTY_ROOT with zero manual exports
 *  (the footgun: forgetting them → pty/st hit the global root, not the network). Env is DERIVED from
 *  the network layout, never hardcoded. Default network = ambient ST_ROOT (the existing convention). */
export function cmdEnv(args: string[]): number {
  const bad = unknownFlag(args, [], ["--identity", "--network"]);
  if (bad) {
    err(`unknown flag ${bad}. Usage: convoy env [network] [--identity <id>]`);
    return 2;
  }
  const r = resolveNetworkEnv(args);
  if ("error" in r) {
    err(r.error);
    return 1;
  }
  for (const line of networkEnvExports(r.networkDir, optValue(args, "--identity"))) out(line);
  return 0;
}

/** `convoy shell [network] [--identity <id>]` — drop into an interactive subshell ($SHELL) with the
 *  network's env exported, so `pty ls` / `st` just work inside it. Exiting returns to the original shell
 *  unchanged. Env DERIVED from the network layout. A human shell is not an agent → ST_AGENT unset unless
 *  --identity is given. Sets CONVOY_NETWORK as a marker (users can surface it in their prompt). */
export async function cmdShell(args: string[]): Promise<number> {
  const bad = unknownFlag(args, [], ["--identity", "--network"]);
  if (bad) {
    err(`unknown flag ${bad}. Usage: convoy shell [network] [--identity <id>]`);
    return 2;
  }
  const r = resolveNetworkEnv(args);
  if ("error" in r) {
    err(r.error);
    return 1;
  }
  const identity = optValue(args, "--identity");
  const shell = process.env["SHELL"] || "/bin/sh";
  const env: NodeJS.ProcessEnv = { ...process.env, ST_ROOT: r.stRoot, PTY_ROOT: r.ptyRoot, CONVOY_NETWORK: r.networkDir };
  if (identity) env["ST_AGENT"] = identity;
  else delete env["ST_AGENT"];
  process.stderr.write(`convoy shell → network ${r.networkDir} (ST_ROOT=${r.stRoot} + PTY_ROOT set${identity ? `, ST_AGENT=${identity}` : ", ST_AGENT unset"}). Type 'exit' to leave.\n`);
  return await new Promise<number>((done) => {
    const child = spawn(shell, [], { stdio: "inherit", env });
    child.on("exit", (code) => done(code ?? 0));
    child.on("error", (e) => {
      err(`failed to spawn shell ${shell}: ${e.message}`);
      done(1);
    });
  });
}

// ---- the shared launch flow (Runner.launch) ----
function printDerived(pf: ReturnType<typeof preflight>): void {
  out("derived wiring (correct-by-construction):");
  for (const [k, v] of pf.derived) out(`  ${k.padEnd(16)} ${v}`);
  for (const w of pf.warnings) out(`  ! ${w}`);
}

/** The bus identity (ST_AGENT) declared in `<dir>/pty.toml`, or null if there's no readable pty.toml with
 *  one. Lets `convoy add` refuse to SILENTLY clobber a pty.toml that belongs to a DIFFERENT agent. */
export function existingPtyTomlIdentity(dir: string): string | null {
  try {
    const m = readFileSync(join(dir, CONVOY_DIR, "pty.toml"), "utf8").match(/ST_AGENT\s*=\s*"([^"]+)"/);
    return m ? m[1] ?? null : null;
  } catch {
    return null; // no pty.toml / unreadable → nothing to clobber
  }
}

async function launchSpec(spec: AgentSpec, o: { dryRun: boolean; force?: boolean }): Promise<number> {
  // Footgun-proof: clone role personas if missing (real runs only, no override).
  if (!o.dryRun && spec.personaOverride === null) {
    try {
      const r = await ensureInstalled((s) => out(`  ${s}`));
      if (r.kind === "cloned") out(`  installed personas at ${r.path}`);
    } catch (e) {
      err(`personas: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const existing = (await new Bus(spec.networkRoot ? stRootOf(spec.networkRoot) : null).agents()).map((a) => a.identity);
  const pf = preflight(spec, existing);
  printDerived(pf);
  if (!pf.ok) {
    out();
    for (const e of pf.errors) err(e);
    return 1;
  }

  // Footgun-proof: `convoy add` writes pty.toml INTO the target dir (spec.workingDir ?? cwd). Refuse to
  // SILENTLY clobber a pty.toml that already belongs to a DIFFERENT agent — running convoy add from a
  // populated repo would overwrite that repo's agent manifest (invisible: the live session keeps running,
  // but a reload / cold up then re-materializes the WRONG config). --dir places it elsewhere; --force overrides.
  const targetDir = spec.workingDir ?? process.cwd();
  const owner = existingPtyTomlIdentity(targetDir);
  const foreign = owner !== null && owner !== spec.identity;
  if (foreign && !o.force) {
    const msg = `${join(targetDir, CONVOY_DIR, "pty.toml")} already belongs to a DIFFERENT agent "${owner}" — adding ${spec.identity} here would overwrite it (silent data loss). Use \`--dir <new-dir>\` to place ${spec.identity} elsewhere, or \`--force\` to overwrite here.`;
    if (o.dryRun) err(`(dry run) WOULD REFUSE: ${msg}`);
    else {
      err(msg);
      return 1;
    }
  } else if (foreign && o.force) {
    out(`  ! --force: overwriting ${owner}'s pty.toml at ${join(targetDir, CONVOY_DIR, "pty.toml")}`);
  }

  if (o.dryRun) {
    out();
    out(`✓ Dry run only. Re-run without --dry-run to launch ${spec.identity}.`);
    return 0;
  }

  out(`Launching ${spec.identity}…`);
  // Native launch — convoy writes ALL the wiring + spawns the sessions itself (no st launch shell).
  const { spawned, failed } = await nativeLaunch(spec);
  for (const f of failed) err(`session ${f} failed to spawn`);
  if (spawned.length === 0) {
    err(`no session spawned for ${spec.identity}`);
    return 1;
  }
  out(`✓ ${spec.identity} is under way (${spawned.join(", ")}). \`convoy ls\` to see it.`);
  return 0;
}

function resolveTransport(args: string[]): Transport | null {
  const raw = hasFlag(args, "--mcp") ? "mcp" : optValue(args, "--transport") ?? "ding";
  return raw === "mcp" || raw === "ding" ? raw : null;
}

/** Which harness(es) this setup actually USES — so the auth check hard-fails only those and treats an
 *  installed-but-unused harness's signout as a WARN (don't red-fail a valid setup). Reads the network's member
 *  pty.toml files (via the `ptyfile` tag) for their harness session key; a fresh/empty network defaults to the
 *  default harness (claude). Best-effort — any error falls back to the default. */
async function usedHarnesses(network: string | null): Promise<Set<Harness>> {
  const used = new Set<Harness>();
  try {
    for (const s of await new PtyHost(network).sessions()) {
      const pf = s.tags["ptyfile"];
      if (!pf || !existsSync(pf)) continue;
      const toml = readFileSync(pf, "utf8");
      if (toml.includes("[sessions.codex]")) used.add("codex");
      if (toml.includes("[sessions.claude]")) used.add("claude");
    }
  } catch {
    // best-effort — fall through to the default
  }
  if (used.size === 0) used.add("claude"); // fresh / no network → the default harness
  return used;
}

// ---- commands ----
export async function cmdDoctor(args: string[]): Promise<number> {
  const badFlag = unknownFlag(args, ["--quick", "--full"], ["--network"]);
  if (badFlag) {
    err(`unrecognized flag "${badFlag}" for \`convoy doctor\`. See \`convoy doctor --help\`.`);
    return 2;
  }
  const network = resolveNetworkRoot(optValue(args, "--network"));
  const quick = hasFlag(args, "--quick");
  const full = hasFlag(args, "--full");
  let failures = 0;
  const bullet = (ok: boolean | null, s: string): void => out(`  ${ok === null ? "•" : ok ? "✓" : "✗"} ${s}`);
  const envBullet = (c: { ok: boolean | null; detail: string; fix?: string }): void => {
    bullet(c.ok, c.ok === false && c.fix ? `${c.detail} — ${c.fix}` : c.detail);
    if (c.ok === false) failures++;
  };

  // Kick off the two LLM-heavy legs — the auth probe + the harness checkups (each with a `claude`/`codex` call,
  // the checkup also an LLM distill) — UP FRONT, so they run CONCURRENTLY with each other AND overlap the fast
  // checks below. Awaited at their print points; otherwise --quick would pay ~8-12s of LLM latency in series.
  const authP = usedHarnesses(network).then((used) => authReadiness(undefined, undefined, (h) => used.has(h)));
  const checkupsP = harnessCheckups(!quick); // distill the harness-doctor issues on the FULL doctor only; --quick stays LLM-free

  // Environment — the machine baseline every later step assumes (Node, OS, temp-path length, git). Checked FIRST
  // + actionable, so a different OS/setup passes or gets a precise fix rather than a cryptic later failure.
  out("Environment");
  envBullet(nodeVersionCheck());
  envBullet(osCheck());
  envBullet(tmpdirSocketCheck());
  envBullet(await gitUsableCheck(run));

  out("Tooling");
  const st = await whichCmd("st");
  const pty = await whichCmd("pty");
  bullet(st !== null, st ? `st on PATH (${st})` : "st NOT on PATH — run `convoy install-cli` (or install smalltalk)");
  if (!st) failures++;
  bullet(pty !== null, pty ? `pty on PATH (${pty})` : "pty NOT on PATH — run `convoy install-cli`; sessions can't be managed without it");
  if (!pty) failures++;
  // Raw-PATH: what the USER's shell actually resolves. The checks above use convoy's enriched superset (incl
  // ~/.local/bin + the login shell), so they can find tools the user's shell can't — the classic fresh-box gap
  // where `install-cli` linked the tools but the bin dir isn't on PATH yet. Flag it so --quick doesn't green-
  // light a setup where a plain `convoy`/`st` in the user's shell would fail. WARN (convoy still resolves them).
  const rawMissing = ["convoy", "st", "pty"].filter((t) => !onRawPath(t));
  if (rawMissing.length > 0) {
    bullet(null, `${rawMissing.join(", ")} linked but NOT on your shell's PATH yet — a plain \`${rawMissing[0]}\` won't run in your shell. Run \`convoy install-cli\` and add its bin dir to PATH (it prints the exact line for your shell), then restart your shell.`);
  } else {
    bullet(true, "convoy, st, pty all resolve on your shell's own PATH");
  }

  out("Bus");
  const bus = new Bus(stRootOf(network));
  if (await bus.roundTrips()) {
    const agents = await bus.agents(true);
    const live = agents.filter((a) => isLive(a.status)).length;
    bullet(true, `bus round-trips (${agents.length} members, ${live} live)`);
  } else {
    bullet(false, `bus does NOT round-trip — \`st agents --json\` failed on ${network ?? "default network"}`);
    failures++;
  }

  out("Paths");
  const pr = checkPtyRoot(network);
  bullet(pr.ok, pr.ok ? `PTY_ROOT fits (${pr.bytes}/${PTY_ROOT_MAX_BYTES} bytes: ${pr.ptyRoot})` : pathTooLongMessage(pr.bytes));
  if (!pr.ok) failures++;

  out("Hooks");
  const smalltalk = discoverSmalltalkDir();
  bullet(
    smalltalk !== null,
    smalltalk !== null
      ? `smalltalk hooks found (${smalltalk})`
      : "smalltalk hooks NOT found — set SMALLTALK_DIR or put `st` on PATH; without them `convoy add`/`cos` can't spawn agents",
  );
  if (smalltalk === null) failures++;
  else {
    // Compact-readiness: the PreCompact hook must be parse-safe under macOS /bin/bash 3.2 + fail-open, or
    // /compact wedges the whole session (and, since the hook is shared, the whole network). Non-spawning.
    const compact = await compactHookHealth(smalltalk);
    bullet(compact.ok, compact.ok ? compact.detail : `${compact.detail}${compact.fix ? ` — ${compact.fix}` : ""}`);
    if (!compact.ok) failures++;
  }

  out("Personas");
  bullet(personasInstalled() ? true : null, personasInstalled() ? `base personas installed (${personasDir()})` : "base personas not installed — `convoy personas install` (auto-installed by add/cos)");

  // Auth — a REAL signed-in probe per installed harness (a cred on disk is not enough: it can be present but
  // revoked, which only surfaces when a spawn later fails). Capability-detected + probed in parallel; a few
  // seconds of latency buys catching the machine-wide-signout failure mode up front. HARD-fails only the
  // harness(es) this setup USES (from the network, or claude when fresh) — an installed-but-unused harness that's
  // signed out is a WARN, so a claude-only setup with codex merely installed still passes green.
  out("Auth");
  const authOutcomes = await authP; // kicked off up front; overlaps the fast checks above
  for (const o of authOutcomes) {
    bullet(o.ok, o.ok === false && o.fix ? `${o.detail} — ${o.fix}` : o.detail);
    if (o.ok === false) failures++;
  }
  if (authOutcomes.every((o) => o.ok === null)) {
    bullet(false, "no supported harness (claude/codex) installed — install one so agents can run");
    failures++;
  }

  // Harness checkups — ADVISORY, complementary to the network-side checks above. Each installed harness's own
  // doctor (`claude doctor` / `codex doctor`) covers the HARNESS side (install health, invalid settings, unused
  // extensions, duplicate subagents, auth/runtime); its issues are LLM-distilled by that harness's own CLI. NOT
  // gated on convoy's pass/fail (these doctors emit text with no structured output/exit code). Version/capability
  // -gated; an absent/old harness → a clean note, never a failure. Both run in parallel.
  out("Harness checkups (advisory — not gated)");
  for (const c of await checkupsP) {
    bullet(null, c.note);
    const body = c.distilled ?? c.raw ?? "";
    for (const line of body.split("\n").filter(Boolean)) out(`      ${line}`);
    if (c.recommend) bullet(null, c.recommend);
  }

  out();
  if (failures > 0) {
    out(`✗ ${failures} blocking issue${failures === 1 ? "" : "s"} — resolve the ✗ lines above before the readiness checks.`);
    return 1; // preflight is the gate: don't spawn agents on a broken setup
  }
  out("✓ convoy is ready here (preflight).");
  if (quick) return 0; // --quick = preflight only

  // --full = the REAL autonomous-org proof (opt-in, slower): the user's real CoS→supervisor→worker run through
  // the real workflows end to end. The default (no flag) runs the fast thin-stand-in readiness suite. Both
  // spawn only isolated throwaway agents; the prod network stays untouched.
  if (full) return runFullOrgSuite();
  return runReadinessSuite();
}

/** `convoy install-cli [--bin <dir>]` — symlink convoy + st + pty into a writable PATH dir (default
 *  ~/.local/bin), reliably + idempotently, WITHOUT the global `npm link` footgun. Run it the first time via
 *  `node <convoy-clone>/bin/convoy install-cli` (convoy runs through node before it's on PATH). Verifies the
 *  links + whether the dir is on PATH, printing the shell-specific line to add it if not. Portable (macOS/Linux). */
export async function cmdInstallCli(args: string[]): Promise<number> {
  const bad = unknownFlag(args, [], ["--bin"]);
  if (bad) {
    err(`unrecognized flag "${bad}" for \`convoy install-cli\`. Usage: convoy install-cli [--bin <dir>].`);
    return 2;
  }
  const convoyRoot = dirname(dirname(fileURLToPath(import.meta.url))); // src/commands.ts → src → repo root
  const binArg = optValue(args, "--bin");
  const binDir = binArg ? resolve(expandTilde(binArg)) : defaultBinDir();
  out(`convoy install-cli — linking convoy, st, pty into ${binDir}`);

  const r = installClis(convoyRoot, binDir);
  for (const t of r.linked) out(`  ✓ ${t} → ${join(binDir, t)}`);
  for (const m of r.missingSources) {
    const repo = m.tool === "st" ? "smalltalk" : m.tool; // st lives in the smalltalk repo
    out(`  ✗ ${m.tool}: source not found at ${m.source} — clone \`${repo}\` as a sibling of the convoy repo, then re-run`);
  }
  for (const c of r.conflicts) out(`  ✗ ${c.tool}: ${c.target} already exists and is NOT a convoy-managed symlink — remove it, then re-run (refusing to clobber it)`);

  if (!r.ok) {
    err("install-cli incomplete — resolve the ✗ lines above.");
    return 1;
  }
  if (r.onPath) {
    out(`\n✓ convoy, st, pty linked and ${binDir} is on your PATH — run \`convoy doctor --quick\` to confirm the rest.`);
    return 0;
  }
  out(`\n• Linked — but ${binDir} is NOT on your PATH yet. Add it:\n    ${r.pathHint}\n  Then run \`convoy doctor --quick\`.`);
  return 0;
}

export async function cmdInit(args: string[]): Promise<number> {
  const badFlag = unknownFlag(args, ["--no-channel"], []);
  if (badFlag) {
    err(`unrecognized flag "${badFlag}" for \`convoy init\`. See \`convoy init --help\`.`);
    return 2;
  }
  // No dir + no ST_ROOT → convoy's OWN default network (get-started-with-zero-config); an explicit dir or
  // ambient ST_ROOT still wins. Idempotent: the default usually already exists (it's where the live network
  // sits), so mkdir is a no-op and st init re-inits in place without clobbering.
  const explicit = positionals(args)[0];
  const dir = resolveNetworkRoot(explicit ?? null);
  const layout = networkLayout(dir);
  // Fail EARLY on a too-long network path — before creating anything — not cryptically at spawn.
  const pr = checkPtyRoot(dir);
  if (!pr.ok) {
    err(pathTooLongMessage(pr.bytes));
    err(`resolved PTY_ROOT would be ${pr.ptyRoot}`);
    return 1;
  }
  // Create the network STRUCTURE: smalltalk/ (the bus, ST_ROOT, synced across machines) + pty/ (runtime,
  // machine-local) + worktrees/ (workspaces). Idempotent (mkdir -p). `st init` targets the smalltalk root.
  const fresh = !existsSync(dir);
  mkdirSync(layout.stRoot, { recursive: true });
  mkdirSync(layout.ptyRoot, { recursive: true });
  mkdirSync(layout.worktrees, { recursive: true });
  if (fresh) out(`created network ${dir} (smalltalk/ + pty/ + worktrees/)`);
  const stArgs = ["init", layout.stRoot];
  if (hasFlag(args, "--no-channel")) stArgs.push("--no-channel");
  const r = await run("st", stArgs);
  if (r.stdout) process.stdout.write(r.stdout);
  if (!r.ok) {
    err(`st init failed: ${r.stderr.trim()}`);
    return 1;
  }
  try {
    const res = await ensureInstalled((s) => out(s));
    if (res.kind === "cloned") out(`installed personas at ${res.path}`);
  } catch (e) {
    err(`personas: ${e instanceof Error ? e.message : String(e)} (add/cos will retry)`);
  }
  out(`✓ network ready at ${dir}. Add agents with \`convoy add <role> --identity <id>${explicit ? ` --network ${dir}` : ""}\`.`);
  return 0;
}

export async function cmdPersonas(args: string[]): Promise<number> {
  const sub = args[0] ?? "status";
  if (sub === "status") {
    const dir = personasDir();
    if (personasInstalled()) {
      out(`  ✓ personas installed at ${dir}`);
      for (const role of ROLES) out(`  ${baseFile(role) ? "✓" : "✗"} ${role}.md`);
    } else {
      out(`  ✗ personas not installed (expected at ${dir})`);
      out("  install with `convoy personas install` (or set CONVOY_PERSONAS_DIR).");
    }
    return 0;
  }
  if (sub === "install") {
    const r = await ensureInstalled((s) => out(s));
    out(r.kind === "cloned" ? `✓ installed personas at ${r.path}` : `✓ personas already installed at ${personasDir()}`);
    return 0;
  }
  err(`unknown personas subcommand "${sub}" (status|install)`);
  return 2;
}

export async function cmdAdd(args: string[]): Promise<number> {
  const bad = unknownFlag(args, ["--mcp", "--permanent", "--dry-run", "--force"], ["--identity", "--harness", "--transport", "--network", "--persona", "--dir", "--prefix", "--config-dir"]);
  if (bad) {
    err(`unrecognized flag "${bad}" for \`convoy add\` — refusing rather than silently ignoring it. See \`convoy add --help\`.`);
    return 2;
  }
  const roleRaw = positionals(args)[0];
  if (!roleRaw) {
    err("missing role. Usage: convoy add <role> --identity <id>");
    return 2;
  }
  const role = parseRole(roleRaw);
  if (!role) {
    err(`unknown role "${roleRaw}". Valid: ${ROLES.join(", ")}`);
    return 2;
  }
  const identity = optValue(args, "--identity");
  if (!identity) {
    err("--identity is required");
    return 2;
  }
  const harnessRaw = (optValue(args, "--harness") ?? "claude").toLowerCase();
  if (harnessRaw !== "claude" && harnessRaw !== "codex") {
    err(`unknown harness "${harnessRaw}". Valid: claude, codex`);
    return 2;
  }
  const transport = resolveTransport(args);
  if (!transport) {
    err(`unknown transport. Valid: ding, mcp`);
    return 2;
  }
  const spec: AgentSpec = {
    harness: harnessRaw as Harness,
    role,
    identity,
    transport,
    networkRoot: resolveNetworkRoot(optValue(args, "--network")),
    personaOverride: optValue(args, "--persona"),
    workingDir: optValue(args, "--dir"),
    permanentOverride: hasFlag(args, "--permanent") ? true : null,
    prefix: optValue(args, "--prefix"),
    configDir: optValue(args, "--config-dir"),
  };
  out(`convoy add — ${identity}`);
  return launchSpec(spec, { dryRun: hasFlag(args, "--dry-run"), force: hasFlag(args, "--force") });
}

async function ensureRepo(path: string, identity: string): Promise<void> {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
    out(`  created ${path}`);
  }
  const isGit = (await run("git", ["rev-parse", "--is-inside-work-tree"], { cwd: path })).ok;
  if (!isGit) {
    await run("git", ["init", "--quiet"], { cwd: path });
    out("  git-init'd the repo");
  }
  const readme = join(path, "README.md");
  if (!existsSync(readme)) writeFileSync(readme, `# ${identity}\n\nPrivate Chief-of-Staff repo. Durable state lives here (notes, plans, decisions).\n`);
}

export async function cmdCos(args: string[]): Promise<number> {
  const bad = unknownFlag(args, ["--mcp", "--permanent", "--dry-run", "--force"], ["--repo", "--identity", "--transport", "--network", "--persona", "--prefix", "--config-dir"]);
  if (bad) {
    err(`unrecognized flag "${bad}" for \`convoy cos\` — refusing rather than silently ignoring it. See \`convoy cos --help\`.`);
    return 2;
  }
  const repoArg = optValue(args, "--repo");
  if (!repoArg) {
    err("--repo is required");
    return 2;
  }
  const identity = optValue(args, "--identity") ?? "cos";
  const transport = resolveTransport(args);
  if (!transport) {
    err(`unknown transport. Valid: ding, mcp`);
    return 2;
  }
  const absRepo = resolve(expandTilde(repoArg));
  const dryRun = hasFlag(args, "--dry-run");

  out(`convoy cos — ${identity}`);
  out(`private repo: ${absRepo}`);
  if (dryRun) {
    out(existsSync(absRepo) ? "  repo exists — dry-running the launch against it" : "  would create + git-init the repo here (skipped in --dry-run)");
  } else {
    await ensureRepo(absRepo, identity);
  }

  const spec: AgentSpec = {
    harness: "claude",
    role: "chief-of-staff",
    identity,
    transport,
    networkRoot: resolveNetworkRoot(optValue(args, "--network")),
    personaOverride: optValue(args, "--persona"),
    workingDir: absRepo,
    permanentOverride: null,
    prefix: optValue(args, "--prefix"),
    configDir: optValue(args, "--config-dir"),
  };
  const rc = await launchSpec(spec, { dryRun, force: hasFlag(args, "--force") });
  if (rc === 0 && !dryRun) out("The CoS will run its first-run interview on boot.");
  return rc;
}

// ---- `convoy ls --tree`: spawn-parentage tree (cos → supervisor → worker) + a remote section ----

/** Per-local-agent info read off its LOCAL pty session (keyed by bus id): its spawner (parent) and tier
 *  (cos), from the `convoy.spawner` / `convoy.tier` tags convoy stamps at add-time (see up.ts crashDingTargets). */
export interface LocalInfo {
  spawner: string | undefined;
  tier: string | undefined;
}

export interface AgentTreeNode {
  agent: Agent;
  children: AgentTreeNode[];
}

/** Build the spawn-parentage FOREST over the agents that have a LOCAL pty session (`local`: bus id →
 *  {spawner, tier}), plus the REMOTE agents (bus members with no local session — they run on another host).
 *  Roots = local agents whose spawner isn't another local agent (the cos tier sorts first). Pure — no I/O,
 *  no clock. Phase 1 caveat: parentage is only as complete as the local `convoy.spawner` tags (post-#48
 *  agents on THIS host); remote agents are listed flat (their metadata doesn't cross machines yet). */
export function agentForest(agents: readonly Agent[], local: ReadonlyMap<string, LocalInfo>): { roots: AgentTreeNode[]; remote: Agent[] } {
  const node = new Map<string, AgentTreeNode>();
  const remote: Agent[] = [];
  for (const a of agents) {
    if (local.has(a.identity)) node.set(a.identity, { agent: a, children: [] });
    else remote.push(a);
  }
  const roots: AgentTreeNode[] = [];
  for (const [id, n] of node) {
    const spawner = local.get(id)?.spawner;
    const parent = spawner && spawner !== id ? node.get(spawner) : undefined;
    if (parent) parent.children.push(n);
    else roots.push(n); // no spawner, or spawner not a local agent → a root
  }
  const byId = (x: AgentTreeNode, y: AgentTreeNode): number => x.agent.identity.localeCompare(y.agent.identity);
  const sortRec = (ns: AgentTreeNode[]): void => {
    ns.sort(byId);
    for (const n of ns) sortRec(n.children);
  };
  sortRec(roots);
  const cosFirst = (id: string): number => (local.get(id)?.tier === "cos" ? 0 : 1);
  roots.sort((x, y) => cosFirst(x.agent.identity) - cosFirst(y.agent.identity) || byId(x, y));
  remote.sort((x, y) => x.identity.localeCompare(y.identity));
  return { roots, remote };
}

/** Human age of a `lastActivity`, for the REMOTE liveness heuristic: "just now" / "3m ago" / "2h ago" / "5d ago". */
export function formatActivityAge(ageMs: number): string {
  const m = Math.floor(Math.max(0, ageMs) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Box-drawing lines for the forest: each node "identity  status", children under ├─ / └─ / │. Pure. */
export function renderForest(roots: readonly AgentTreeNode[], label: (a: Agent) => string = (a) => a.status): string[] {
  const lines: string[] = [];
  const walk = (n: AgentTreeNode, prefix: string, isRoot: boolean, isLast: boolean): void => {
    const branch = isRoot ? "" : isLast ? "└─ " : "├─ ";
    lines.push(`${prefix}${branch}${n.agent.identity}  ${label(n.agent)}`);
    const childPrefix = isRoot ? "" : prefix + (isLast ? "   " : "│  ");
    n.children.forEach((c, i) => walk(c, childPrefix, false, i === n.children.length - 1));
  };
  for (const r of roots) walk(r, "", true, true);
  return lines;
}

/** The cross-machine liveness inputs for an agent, read DIRECTLY from the (synced) bus files — item-2 seam
 *  (JOINT SEAM 2026-07-16): the status file's MTIME (the heartbeat the ding sidecar refreshes; it FREEZES
 *  when the agent's harness dies → stale = dead) + the host file (which machine wrote it). Both null if
 *  absent (pre-rollout of smalltalk's ding change, or no session). A present host file is convoy's signal
 *  that the NEW ding (30s heartbeat + host write) is running, so mtime-liveness is reliable — see the
 *  --tree gate. mtime is meaningful cross-machine only because the sync is mtime-preserving. */
export function readAgentPresence(root: string | null, identity: string): { statusMtime: number | null; host: string | null } {
  if (!root) return { statusMtime: null, host: null };
  let statusMtime: number | null = null;
  try {
    statusMtime = statSync(join(root, identity, "status")).mtimeMs;
  } catch {
    // no status file → mtime null (falls back to the activity heuristic)
  }
  // Host is the FOLDER-NAME prefix of the host-scoped bus id (`<host>.<identity>`), NOT a separate host
  // file — the redesign encodes host in the folder name (cos's call). Absent prefix → host unknown.
  const dot = identity.indexOf(".");
  const host = dot > 0 ? identity.slice(0, dot) : null;
  return { statusMtime, host };
}

/** Short hostname (first dot-label, lowercased) — for display + same-host comparison. */
export function shortHost(h: string): string {
  return (h.trim().split(".")[0] ?? h).toLowerCase();
}

/** Map each LOCAL agent's bus id → its {spawner, tier} from its pty-session tags (best-effort). */
async function localAgentMap(network: string | null): Promise<Map<string, LocalInfo>> {
  const m = new Map<string, LocalInfo>();
  try {
    for (const s of await new PtyHost(network).sessions()) {
      if (s.tags["role"] !== "agent") continue; // agent sessions only (not ding/daemon)
      const bid = busIdOf(s);
      if (bid) m.set(bid, { spawner: s.tags["convoy.spawner"], tier: s.tags["convoy.tier"] });
    }
  } catch {
    // best-effort: no local pty host → everything shows as remote
  }
  return m;
}

export async function cmdLs(args: string[]): Promise<number> {
  const bad = unknownFlag(args, ["--live-only", "--json", "--tree"], ["--network", "--stale-after"]);
  if (bad) {
    err(`unrecognized flag "${bad}" for \`convoy ls\`. See \`convoy --help\`.`);
    return 2;
  }
  const network = resolveNetworkRoot(optValue(args, "--network"));
  const liveOnly = hasFlag(args, "--live-only");
  const json = hasFlag(args, "--json");
  const agents = await new Bus(stRootOf(network)).agents(true);
  const shown = liveOnly ? agents.filter((a) => isLive(a.status)) : agents;
  if (json) {
    out(JSON.stringify(shown));
    return 0;
  }

  if (hasFlag(args, "--tree")) {
    // Spawn-parentage tree + real cross-machine liveness (JOINT SEAM item 2). Liveness = the synced status
    // file's MTIME (fresh < staleAfter = alive; frozen = dead — the ding heartbeat stops when the harness dies).
    // host file = which machine. Both gate on the host file being PRESENT (= smalltalk's new ding, which also
    // runs the tight ~30s heartbeat, is live for that agent); absent → fall back to #50's activity heuristic /
    // bus status, so this ships safe in any rollout order and auto-upgrades per agent. Uses the FULL member set.
    const staleAfterMs = Number(optValue(args, "--stale-after")) || 120_000;
    const thisHost = shortHost(hostname());
    const now = Date.now();
    const localPty = await localAgentMap(network);
    const pres = new Map(agents.map((a) => [a.identity, readAgentPresence(stRootOf(network), a.identity)]));
    const isLocal = (id: string): boolean => {
      const h = pres.get(id)?.host;
      return h != null ? shortHost(h) === thisHost : localPty.has(id); // host when known, else #50 pty-presence
    };
    const localMap = new Map<string, LocalInfo>();
    for (const a of agents) if (isLocal(a.identity)) localMap.set(a.identity, localPty.get(a.identity) ?? { spawner: undefined, tier: undefined });
    const { roots, remote } = agentForest(agents, localMap);

    // Real mtime-liveness only when the host file is present (= new ding + tight heartbeat); else the bus status.
    const liveLabel = (a: Agent): string => {
      const p = pres.get(a.identity);
      if (p?.host != null && p.statusMtime != null) {
        const age = now - p.statusMtime;
        return age < staleAfterMs ? a.status : `DEAD (status stale ${formatActivityAge(age)})`;
      }
      return a.status;
    };

    out(`network ${network}   (this host: ${thisHost})`);
    out("");
    out("LOCAL (this host) — spawn parentage:");
    if (roots.length === 0) out("  (no local agents)");
    else for (const l of renderForest(roots, liveLabel)) out(`  ${l}`);
    if (remote.length > 0) {
      out("");
      out("REMOTE (other hosts / offline):");
      for (const a of remote) {
        const p = pres.get(a.identity);
        const host = p?.host ? shortHost(p.host) : "?";
        let live: string;
        if (p?.host != null && p.statusMtime != null) {
          const age = now - p.statusMtime;
          live = age < staleAfterMs ? `alive on ${host} (${a.status})` : `DEAD on ${host} (status stale ${formatActivityAge(age)})`;
        } else {
          live = a.lastActivity != null ? `~active ${formatActivityAge(now - a.lastActivity)} (heuristic — no synced status yet)` : "no activity seen (heuristic)";
        }
        out(`  ${a.identity}  ${live}`);
      }
    }
    out("");
    out(`${agents.length} member${agents.length === 1 ? "" : "s"}: ${localMap.size} local, ${remote.length} remote. Liveness = synced status mtime (fresh < ${Math.round(staleAfterMs / 1000)}s); agents without a synced host/status file fall back to the activity heuristic.`);
    return 0;
  }

  if (shown.length === 0) {
    out(`No members${liveOnly ? " live" : ""} on this network.`);
    return 0;
  }
  const nameW = Math.max(8, ...shown.map((a) => a.identity.length));
  out(`${"IDENTITY".padEnd(nameW)}  STATUS  INBOX`);
  for (const a of shown) out(`${a.identity.padEnd(nameW)}  ${a.status.padEnd(6)}  ${a.inbox ?? "-"}`);
  const live = shown.filter((a) => isLive(a.status)).length;
  out(`\n${shown.length} member${shown.length === 1 ? "" : "s"}, ${live} live.`);
  return 0;
}

export async function cmdRemove(args: string[]): Promise<number> {
  const badFlag = unknownFlag(args, ["--dry-run"], ["--network"]);
  if (badFlag) {
    err(`unrecognized flag "${badFlag}" for \`convoy remove\`. See \`convoy remove --help\`.`);
    return 2;
  }
  const network = resolveNetworkRoot(optValue(args, "--network"));
  const identity = positionals(args)[0];
  if (!identity) {
    err("missing identity. Usage: convoy remove <id>");
    return 2;
  }
  const members = (await new Bus(stRootOf(network)).agents()).map((a) => a.identity);
  if (!members.includes(identity)) {
    err(`no agent "${identity}" on this network. \`convoy ls\` to list members.`);
    return 1;
  }
  const host = new PtyHost(network);
  const sessions = (await host.sessions()).filter((s) => {
    const dn = s.tags["ptyfile.session"];
    return s.name === identity || dn === identity || ["claude", "codex", "ding"].some((suf) => `${identity}-${suf}` === dn);
  });
  out("convoy remove — plan:");
  if (sessions.length === 0) out(`  no running pty sessions for ${identity} (already down)`);
  for (const s of sessions) out(`  stop pty session ${s.name}`);
  if (hasFlag(args, "--dry-run")) {
    out("\n✓ Dry run only. Re-run without --dry-run to execute.");
    return 0;
  }
  for (const s of sessions) out((await host.kill(s.name)) ? `✓ stopped ${s.name}` : `• ${s.name} didn't stop cleanly (already exited?)`);
  out(`✓ ${identity} removed from the convoy.`);
  return 0;
}

/** `convoy reload <id>` — re-materialize an agent from its pty.toml (kill + spawnFromPtyFile).
 *  Unlike the reconcile respawn (which reuses the STORED metadata.command — the frozen-metadata
 *  coupling), this RE-READS pty.toml, so edits to permission-mode / displayName / the ding ref /
 *  --resume take effect. The manual escape hatch for "I changed pty.toml and want it applied." */
export async function cmdReload(args: string[]): Promise<number> {
  const network = resolveNetworkRoot(optValue(args, "--network"));
  const identity = positionals(args)[0];
  if (!identity) {
    err("missing identity. Usage: convoy reload <id> [--dry-run] [--write-only]");
    return 2;
  }
  // Match the agent's sessions (claude + ding) robustly by their repo dir — each agent's session
  // runs in its own repo, so the pty.toml dir (or cwd) basename identifies the agent, surviving
  // session-name churn. Normalize both (drop harness suffix + non-alphanumerics).
  const norm = (s: string): string => s.replace(/-(claude|codex)$/i, "").replace(/[^a-z0-9]/gi, "").toLowerCase();
  const dirOf = (s: SupervisedSession): string => {
    const pf = s.tags["ptyfile"];
    return pf ? basename(workspaceOfPtyfile(pf)) : s.cwd ? basename(s.cwd) : "";
  };
  const host = new PtyHost(network);
  const sessions = (await host.sessions()).filter((s) => s.name === identity || norm(dirOf(s)) === norm(identity));
  if (sessions.length === 0) {
    err(`no running pty sessions for "${identity}". \`convoy ls\` to list members.`);
    return 1;
  }
  const ptyfile = sessions.map((s) => s.tags["ptyfile"]).find((p) => p);
  if (!ptyfile) {
    err(`can't resolve pty.toml for "${identity}" (no ptyfile tag on its sessions).`);
    return 1;
  }
  const dir = workspaceOfPtyfile(ptyfile); // the workspace; regenerateDingRoot + spawnFromPtyFile append .convoy/
  const writeOnly = hasFlag(args, "--write-only");
  // Heal the ding block to carry --root (idempotent) BEFORE re-materializing, so the fresh spawn — and
  // every future cold-up — gets a durable ding, not an env-only one that a pty restart would strip.
  // The harness [sessions.claude] block (role prompt + --resume) is left verbatim. See regenerateDingRoot.
  const heal = regenerateDingRoot(dir, { dryRun: true });
  out(`convoy reload — plan for ${identity} (from ${ptyfile}):`);
  if (heal) out(`  heal ding command: ${heal.before}  ->  ${heal.after}`);
  else out("  ding command already durable (--root present) — no pty.toml change");
  if (writeOnly) {
    out("  --write-only: heal the pty.toml only; running sessions left untouched");
  } else {
    for (const s of sessions) out(`  stop ${s.name}`);
    out("  respawn fresh from pty.toml (re-reads it — permission-mode / displayName / ding-ref / --resume edits take effect)");
  }
  if (hasFlag(args, "--dry-run")) {
    out("\n✓ Dry run only. Re-run without --dry-run to execute.");
    return 0;
  }
  const healed = regenerateDingRoot(dir);
  if (healed) out(`✓ healed pty.toml ding command (--root baked in)`);
  if (writeOnly) {
    out(`✓ ${identity}: pty.toml ${healed ? "healed" : "already durable"} — running sessions untouched.`);
    return 0;
  }
  for (const s of sessions) await host.kill(s.name);
  const { spawned, failed } = await spawnFromPtyFile(dir, network);
  for (const n of spawned) out(`✓ spawned ${n}`);
  for (const n of failed) out(`✗ failed ${n}`);
  out(`✓ reloaded ${identity} from pty.toml.`);
  return failed.length > 0 ? 1 : 0;
}

/** `convoy pretrust <dir> [<dir>...] [--harness claude|codex] [--config-dir <path>]` — batch pre-trust agent
 *  working dirs in one atomic write, so a caller spawning MULTIPLE agents back-to-back doesn't hit the
 *  workspace-trust RACE (a sibling's booting harness clobbers a later sibling's just-written trust entry). Call
 *  it ONCE with every dir before the first `convoy add`. `--harness claude` (default) writes Claude Code's
 *  ~/.claude.json (or <config-dir>/.claude.json); `--harness codex` writes codex's ~/.codex/config.toml
 *  (codex's --dangerously-bypass-approvals-and-sandbox does NOT skip its directory-trust prompt). */
export async function cmdPretrust(args: string[]): Promise<number> {
  const bad = unknownFlag(args, [], ["--config-dir", "--harness"]);
  if (bad) {
    err(`unrecognized flag "${bad}" for \`convoy pretrust\`. Usage: convoy pretrust <dir> [<dir>...] [--harness claude|codex] [--config-dir <path>].`);
    return 2;
  }
  const dirs = positionals(args);
  if (dirs.length === 0) {
    err("missing dir. Usage: convoy pretrust <dir> [<dir>...] [--harness claude|codex] [--config-dir <path>]");
    return 2;
  }
  const harness = (optValue(args, "--harness") ?? "claude").toLowerCase();
  if (harness !== "claude" && harness !== "codex") {
    err(`unknown harness "${harness}". Valid: claude, codex`);
    return 2;
  }
  const configDir = optValue(args, "--config-dir");
  if (configDir && harness === "codex") {
    err("--config-dir applies only to --harness claude (relocates ~/.claude.json); codex trust lives in ~/.codex/config.toml");
    return 2;
  }
  const abs = dirs.map((d) => resolve(expandTilde(d)));
  for (const d of abs) if (!existsSync(d)) err(`warning: ${d} does not exist yet — create it before pre-trusting so the realpath matches (proceeding on the literal path)`);
  const cfgPath = harness === "codex" ? codexConfigPath() : configDir ? `${resolve(expandTilde(configDir))}/.claude.json` : claudeConfigPath();
  const { trusted, failed } =
    harness === "codex" ? pretrustDirsCodex(abs) : pretrustDirs(abs, configDir ? resolve(expandTilde(configDir)) : undefined);
  for (const t of trusted) out(`  ✓ ${t}`);
  if (failed.length > 0) {
    err(`could not write pre-trust for ${failed.length} dir(s) — check ${cfgPath} is readable + writable`);
    return 1;
  }
  out(`✓ pre-trusted ${trusted.length} dir(s) for ${harness} in ${cfgPath}. Safe to spawn them back-to-back now.`);
  return 0;
}

// NOT READY / HIDDEN: the Convoy.app menubar host manager. Kept dispatchable but hidden from `convoy
// --help` + the README Commands list until the macOS app is dailyable (Nathan's call). Bring it back onto
// the user-facing surfaces once the app ships for daily use.
export async function cmdApp(args: string[]): Promise<number> {
  const sub = args[0] ?? "status";
  if (sub === "status") {
    const installed = existsSync("/Applications/Convoy.app");
    out(`  ${installed ? "✓" : "✗"} ${installed ? "Convoy.app installed in /Applications" : "Convoy.app not installed"}`);
    const running = (await run("pgrep", ["-x", "Convoy"])).ok;
    out(`  ${running ? "✓" : "•"} ${running ? "menubar app running" : "menubar app not running"}`);
    return 0;
  }
  out("convoy app: the macOS app now lives in the convoy-macos repo (see notes/TS-PORT-PLAN.md §6).");
  return 0;
}
