// convoy CLI command handlers, ported from Sources/convoy/Commands/*.swift + Runner.swift. Each
// returns an exit code. Small arg helpers keep the hand-rolled parsing consistent (like pty's cli.ts).

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./exec.ts";
import { defaultBinDir, installClis } from "./install-cli.ts";
import { Bus, isLive } from "./bus.ts";
import { PtyHost, spawnFromPtyFile, type SupervisedSession } from "./host.ts";
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

/** The effective network root: `--network` if given, else the ambient `ST_ROOT`. Falling back to
 *  ST_ROOT keeps the pty sessions (agent + ding sidecar) in the SAME root as the bus. Without it, a bare
 *  `convoy add` under an isolated ST_ROOT registers the agent on the isolated bus but leaks its pty
 *  sessions to the global pty root — inconsistent isolation that `convoy down` can't then reap. */
export function resolveNetworkRoot(cliNetwork: string | null): string | null {
  return cliNetwork ?? process.env["ST_ROOT"] ?? null;
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

// ---- the shared launch flow (Runner.launch) ----
function printDerived(pf: ReturnType<typeof preflight>): void {
  out("derived wiring (correct-by-construction):");
  for (const [k, v] of pf.derived) out(`  ${k.padEnd(16)} ${v}`);
  for (const w of pf.warnings) out(`  ! ${w}`);
}

async function launchSpec(spec: AgentSpec, o: { dryRun: boolean }): Promise<number> {
  // Footgun-proof: clone role personas if missing (real runs only, no override).
  if (!o.dryRun && spec.personaOverride === null) {
    try {
      const r = await ensureInstalled((s) => out(`  ${s}`));
      if (r.kind === "cloned") out(`  installed personas at ${r.path}`);
    } catch (e) {
      err(`personas: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const existing = (await new Bus(spec.networkRoot).agents()).map((a) => a.identity);
  const pf = preflight(spec, existing);
  printDerived(pf);
  if (!pf.ok) {
    out();
    for (const e of pf.errors) err(e);
    return 1;
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
  const network = optValue(args, "--network");
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
  const bus = new Bus(network);
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
  const dir = positionals(args)[0];
  // Fail EARLY on a too-long network path — before creating anything — not cryptically at spawn.
  const pr = checkPtyRoot(dir ?? null);
  if (!pr.ok) {
    err(pathTooLongMessage(pr.bytes));
    err(`resolved PTY_ROOT would be ${pr.ptyRoot}`);
    return 1;
  }
  if (dir && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    out(`created ${dir}`);
  }
  const stArgs = ["init"];
  if (dir) stArgs.push(dir);
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
  out(`✓ network ready at ${dir ?? "the default network"}. Add agents with \`convoy add <role> --identity <id>${dir ? ` --network ${dir}` : ""}\`.`);
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
  const bad = unknownFlag(args, ["--mcp", "--permanent", "--dry-run"], ["--identity", "--harness", "--transport", "--network", "--persona", "--dir", "--prefix", "--config-dir"]);
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
  return launchSpec(spec, { dryRun: hasFlag(args, "--dry-run") });
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
  const bad = unknownFlag(args, ["--mcp", "--permanent", "--dry-run"], ["--repo", "--identity", "--transport", "--network", "--persona", "--prefix", "--config-dir"]);
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
  const rc = await launchSpec(spec, { dryRun });
  if (rc === 0 && !dryRun) out("The CoS will run its first-run interview on boot.");
  return rc;
}

export async function cmdLs(args: string[]): Promise<number> {
  const network = optValue(args, "--network");
  const liveOnly = hasFlag(args, "--live-only");
  const json = hasFlag(args, "--json");
  const agents = await new Bus(network).agents(true);
  const shown = liveOnly ? agents.filter((a) => isLive(a.status)) : agents;
  if (json) {
    out(JSON.stringify(shown));
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
  const network = optValue(args, "--network");
  const identity = positionals(args)[0];
  if (!identity) {
    err("missing identity. Usage: convoy remove <id>");
    return 2;
  }
  const members = (await new Bus(network).agents()).map((a) => a.identity);
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
  const network = optValue(args, "--network");
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
    return pf ? basename(dirname(pf)) : s.cwd ? basename(s.cwd) : "";
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
  const dir = dirname(ptyfile);
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
