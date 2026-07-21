// convoy CLI command handlers, ported from Sources/convoy/Commands/*.swift + Runner.swift. Each
// returns an exit code. Small arg helpers keep the hand-rolled parsing consistent (like pty's cli.ts).

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execInteractive, run } from "./exec.ts";
import { flagAllowList } from "./command-table.ts";
import { CONVOY_DIR, DEFAULT_NETWORK_NAME, defaultConvoyNetwork, isNetworkName, networkDirForName, networkDirOfStRoot, networkLayout, stRootOf } from "./paths.ts";
import { DING_SERVICES, isDingService, networkNameFromDir, readNetworkConfig, writeNetworkConfig, type DingService } from "./network-config.ts";
import { defaultBinDir, installClis } from "./install-cli.ts";
import { Bus, isLive, type Agent } from "./bus.ts";
import { PtyHost, gone, processAlive, spawnFromPtyFile, workspaceOfPtyfile, type SupervisedSession } from "./host.ts";
import { busIdOf } from "./up.ts";
import { agentBusId } from "./reconcile.ts";
import { discoverSmalltalkDir, nativeLaunch, regenerateDingRoot, writeAgentFiles } from "./launch.ts";
import { agentFilePath, agentFileToSpec, agentFileToToml, catalogDir, isValidBin, readAgentFile, writeAgentFile, SAMPLE_AGENT_TOML, type AgentFile } from "./agent-file.ts";
import { readCatalog } from "./catalog.ts";
import { identityErrors } from "./identity.ts";
import { executeRename, planRename, renamePreview } from "./rename.ts";
import { declareCatalogSync } from "./fabric-sync.ts";
import { authReadiness } from "./doctor/auth.ts";
import { harnessCheckups } from "./doctor/checkup.ts";
import { gitUsableCheck, nodeVersionCheck, osCheck, tmpdirSocketCheck } from "./doctor/env.ts";
import { compactHookHealth, hooksNotLocated } from "./doctor/hooks.ts";
import { runFullOrgSuite, runReadinessSuite } from "./doctor/suite.ts";
import { structureChecks } from "./doctor/structure.ts";
import { baseFile, ensureInstalled, personasDir, personasInstalled } from "./personas.ts";
import { ROLES, parseRole } from "./role.ts";
import { declaredRunNotice, liveForceRefusal, livenessAgentFile, passedDeclarationFlags, resolveRunAction, staleFlagsNote } from "./run.ts";
import { busAgentId, isValidModel, preflight, resolvedPersonaPath, sessionId, shortHostname, type AgentSpec, type Transport } from "./agent-spec.ts";
import { HARNESSES, HARNESS_SESSION_KEYS, HARNESS_SUFFIX_RE, harnessDescriptor, harnessesInPtyToml, harnessLimitations, isHarness, type Harness } from "./harness.ts";
import { claudeConfigPath, codexConfigPath, pretrustDirs, pretrustDirsCodex } from "./trust.ts";
import { DEFAULT_JOB_ID, completionPath, isValidJobId, readCompletion, writeCompletion, type JobStatus } from "./job.ts";

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
const BOOL_FLAGS = new Set(["--dry-run", "--yes", "-y", "--mcp", "--permanent", "--purge", "--json", "--live-only", "--no-channel", "--force", "--once", "--keep", "--quiet"]);
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
 *  win — the default is only the fallback. Never null.
 *
 *  ST_ROOT is the BUS root (`<net>/smalltalk`), NOT the network dir — so the fallback goes through
 *  `networkDirOfStRoot` to recover `<net>`. Skipping that was a live footgun: `convoy add` wrote the catalog
 *  under `<net>/smalltalk/catalog/` (unsynced) instead of `<net>/catalog/`, so the agent silently never
 *  synced/launched (cos, cross-machine demo). */
export function resolveNetworkRoot(cliNetwork: string | null): string {
  if (cliNetwork) return isNetworkName(cliNetwork) ? networkDirForName(cliNetwork) : cliNetwork;
  const st = process.env["ST_ROOT"];
  return st ? networkDirOfStRoot(st) : defaultConvoyNetwork();
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
    // No explicit network: prefer the ambient PTY_ROOT, else derive from ST_ROOT — which is the BUS root
    // (`<net>/smalltalk`), so recover `<net>` first (networkDirOfStRoot) rather than joining `pty` onto the
    // bus root (`<net>/smalltalk/pty`, wrong). ST_ROOT unset → st/pty's global smalltalk root, unchanged.
    : process.env["PTY_ROOT"] ?? join(process.env["ST_ROOT"] ? networkDirOfStRoot(process.env["ST_ROOT"]) : join(homedir(), ".local", "state", "smalltalk"), "pty");
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

/** Host-prefix a bare identity (`cvw-claude` → `silber.cvw-claude`) so a human acting-as an agent gets
 *  an ST_AGENT that MATCHES the host-prefixed bus folder (`<net>/smalltalk/<host>.<id>/`). An identity
 *  that already carries a host prefix (contains a `.`) passes through unchanged. */
export function hostPrefixedIdentity(id: string): string {
  return id.includes(".") ? id : `${shortHostname()}.${id}`;
}

/** `convoy env [network] [--identity <id>]` — print eval-safe exports for a network's env, so
 *  `eval "$(convoy env <net>)"` targets that network's ST_ROOT + PTY_ROOT with zero manual exports
 *  (the footgun: forgetting them → pty/st hit the global root, not the network). Env is DERIVED from
 *  the network layout, never hardcoded. Default network = ambient ST_ROOT (the existing convention). */
export function cmdEnv(args: string[]): number {
  const bad = unknownFlag(args, ...flagAllowList("env"));
  if (bad) {
    err(`unknown flag ${bad}. Usage: convoy env [network] [--identity <id>]`);
    return 2;
  }
  const r = resolveNetworkEnv(args);
  if ("error" in r) {
    err(r.error);
    return 1;
  }
  const id = optValue(args, "--identity");
  for (const line of networkEnvExports(r.networkDir, id ? hostPrefixedIdentity(id) : null)) out(line);
  return 0;
}

/** `convoy shell [network] [--identity <id>]` — drop into an interactive subshell ($SHELL) with the
 *  network's env exported, so `pty ls` / `st` just work inside it. Exiting returns to the original shell
 *  unchanged. Env DERIVED from the network layout. A human shell is not an agent → ST_AGENT unset unless
 *  --identity is given. Sets CONVOY_NETWORK as a marker (users can surface it in their prompt). */
export async function cmdShell(args: string[]): Promise<number> {
  const bad = unknownFlag(args, ...flagAllowList("shell"));
  if (bad) {
    err(`unknown flag ${bad}. Usage: convoy shell [network] [--identity <id>]`);
    return 2;
  }
  const r = resolveNetworkEnv(args);
  if ("error" in r) {
    err(r.error);
    return 1;
  }
  const rawId = optValue(args, "--identity");
  const identity = rawId ? hostPrefixedIdentity(rawId) : null; // match the host-prefixed bus folder
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
      for (const h of harnessesInPtyToml(toml)) used.add(h);
    }
  } catch {
    // best-effort — fall through to the default
  }
  if (used.size === 0) used.add("claude"); // fresh / no network → the default harness
  return used;
}

// ---- commands ----
export async function cmdDoctor(args: string[]): Promise<number> {
  const badFlag = unknownFlag(args, ...flagAllowList("doctor"));
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

  out("Structure — proving the network is laid out correctly");
  for (const c of structureChecks(network)) {
    bullet(c.ok, `${c.name}: ${c.detail}`);
    out(`      → ${c.proves}`); // narrate WHAT each check proves (Nathan: chatty)
    if (c.ok === false) {
      // c.ok === false is a real failure (gates); c.ok === null is neutral/not-applicable (e.g. a
      // pre-init machine with no network yet) — render as • and NEVER count it as a blocking issue.
      if (c.fix) out(`      → fix: ${c.fix}`);
      failures++;
    }
  }

  out("Paths");
  const pr = checkPtyRoot(network);
  bullet(pr.ok, pr.ok ? `PTY_ROOT fits (${pr.bytes}/${PTY_ROOT_MAX_BYTES} bytes: ${pr.ptyRoot})` : pathTooLongMessage(pr.bytes));
  if (!pr.ok) failures++;

  out("Hooks");
  const smalltalk = discoverSmalltalkDir();
  if (smalltalk === null) {
    // Can't LOCATE smalltalk (no SMALLTALK_DIR/ST_BIN, `st` off-PATH, no sibling checkout). That is NOT proof
    // the hooks are absent — they may be installed + wired via each agent's absolute ST_BIN. Nathan's bar: never
    // assert a false absence. Honest WARN (couldn't verify; set SMALLTALK_DIR), never a red hard fail. Real fix
    // to follow: consume smalltalk's `st hooks path --json` once it ships.
    const leg = hooksNotLocated();
    bullet(leg.state, leg.detail);
    if (leg.blocking) failures++;
  } else {
    bullet(true, `smalltalk hooks found (${smalltalk})`);
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
  const bad = unknownFlag(args, ...flagAllowList("install-cli"));
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

/** Prompt on a TTY. The question goes to STDERR so stdout stays clean for a piped/eval'd caller; returns
 *  the trimmed answer, or `def` when the user just hits enter. */
async function ask(question: string, def = ""): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const a = await new Promise<string>((res) => rl.question(`${question}${def ? ` [${def}]` : ""}: `, res));
    return a.trim() || def;
  } finally {
    rl.close();
  }
}
async function askYesNo(question: string, def: boolean): Promise<boolean> {
  const a = (await ask(`${question} (${def ? "Y/n" : "y/N"})`)).toLowerCase();
  return a ? a.startsWith("y") : def;
}

/** `convoy init [name|dir] [--megarepo <path>] [--ding node|rust] [--quiet|--json] [--yes] [--no-channel]` — stand up a
 *  correctly-structured network. INTERACTIVE + NARRATED by default (Nathan): on a TTY it walks the user
 *  through network name → megarepo → CoS, and tells them what it's doing at each step. `--quiet`/`--json`
 *  (or a non-TTY, e.g. scripts/evals) skips prompts + narration; `--yes` accepts defaults non-interactively;
 *  `--json` also prints a one-line JSON summary. Explicit args always win over prompts. */
export async function cmdInit(args: string[]): Promise<number> {
  const badFlag = unknownFlag(args, ...flagAllowList("init"));
  if (badFlag) {
    err(`unrecognized flag "${badFlag}" for \`convoy init\`. See \`convoy init --help\`.`);
    return 2;
  }
  const json = hasFlag(args, "--json");
  const quiet = json || hasFlag(args, "--quiet");
  const interactive = Boolean(process.stdin.isTTY) && !quiet && !hasFlag(args, "--yes");
  const say = (s: string): void => {
    if (!quiet) out(s);
  };

  say("Let's set up your convoy network.");

  // 1. Network name / dir — explicit arg or --name wins; else prompt (interactive) or the default.
  let choice = positionals(args)[0] ?? optValue(args, "--name");
  if (!choice && interactive) choice = await ask("Network name (or a path)", DEFAULT_NETWORK_NAME);
  const dir = resolveNetworkRoot(choice ?? null);
  const layout = networkLayout(dir);
  say(`→ Network "${networkNameFromDir(dir)}" will live at ${dir}`);

  // Fail EARLY on a too-long network path — before creating anything — not cryptically at spawn.
  const pr = checkPtyRoot(dir);
  if (!pr.ok) {
    err(pathTooLongMessage(pr.bytes));
    err(`resolved PTY_ROOT would be ${pr.ptyRoot}`);
    return 1;
  }

  // 2. Megarepo — agents cut worktrees off it. --megarepo wins; else prompt; else preserve a prior config.
  const priorCfg = readNetworkConfig(dir);
  let megarepo: string | undefined = priorCfg?.megarepo;
  const megarepoInput = optValue(args, "--megarepo") ?? (interactive ? await ask("Megarepo path (agents cut worktrees off it) — blank for none", "") : "");
  if (megarepoInput) {
    const abs = resolve(expandTilde(megarepoInput));
    if (!existsSync(join(abs, ".git"))) {
      err(`${abs} is not a git repo (no .git). Point --megarepo at a git checkout, or omit it (agents symlink their own repo).`);
      return 1;
    }
    megarepo = abs;
  }

  // 2b. Ding service — which ding sidecar this net runs: node `st ding` (default) or the rust `ding`.
  //     --ding wins; else preserve a prior config. A machine-runtime choice, so it is NOT prompted for.
  let ding: DingService | undefined = priorCfg?.ding;
  const dingInput = optValue(args, "--ding");
  if (dingInput) {
    if (!isDingService(dingInput)) {
      err(`invalid --ding "${dingInput}" (want: ${DING_SERVICES.join(" | ")})`);
      return 1;
    }
    ding = dingInput;
  }

  // 3. Create the structure + config, narrating each step.
  say("→ Creating the network structure (smalltalk/ = the bus · catalog/ = agent files (desired state) · pty/ = runtime · worktrees/ = workspaces)…");
  mkdirSync(layout.stRoot, { recursive: true });
  mkdirSync(catalogDir(dir), { recursive: true }); // the catalog — `convoy add` writes agent files here (desired state); convoy declares it to `fabric sync` (below) so it propagates cross-machine
  mkdirSync(layout.ptyRoot, { recursive: true });
  mkdirSync(layout.worktrees, { recursive: true });
  say("→ Recording the network config (convoy.toml)…");
  writeNetworkConfig(dir, { name: networkNameFromDir(dir), ...(megarepo ? { megarepo } : {}), ...(ding ? { ding } : {}) });
  if (megarepo) say(`   megarepo: ${megarepo}`);
  if (ding) say(`   ding: ${ding}${ding === "rust" ? " (compoundingtech/ding — rust)" : " (smalltalk st ding — node)"}`);
  say("→ Initializing the smalltalk bus…");
  const stArgs = ["init", layout.stRoot];
  if (hasFlag(args, "--no-channel")) stArgs.push("--no-channel");
  const r = await run("st", stArgs);
  if (!r.ok) {
    err(`st init failed: ${r.stderr.trim()}`);
    err("→ next: check `st`/`pty` are on PATH and the bus works — run `convoy doctor --quick`.");
    return 1;
  }
  // Declare the catalog to fabric's `fabric sync` so it propagates cross-machine — a `host=B` agent file
  // dropped here reaches B, whose `convoy up` launches it (the declarative scheduler). fabric owns the
  // transport (an always-on daemon); convoy just writes the `[[sync]]` entry. Version-gated + best-effort:
  // an absent/pre-sync fabric WARNS (single-machine still works), never fails init.
  say("→ Declaring the catalog to fabric sync (cross-machine propagation)…");
  {
    const d = await declareCatalogSync(dir);
    if (d.declared) say(`   ✓ declared "${d.name}" → fabric sync (union / newer-wins / no-delete); drop a host=<box> agent file and it runs on that box`);
    else say(`   • skipped: ${d.reason}`);
  }

  say("→ Installing personas…");
  try {
    const res = await ensureInstalled((s) => say(`   ${s}`));
    if (res.kind === "cloned") say(`   installed personas at ${res.path}`);
  } catch (e) {
    err(`personas: ${e instanceof Error ? e.message : String(e)} (add/cos will retry)`);
  }

  // 4. CoS bootstrap (interactive only — optional). `null` = the user never asked for one (the default and
  // the whole non-interactive path); a number = cmdCos actually ran and this is its rc.
  let cosCode: number | null = null;
  if (interactive && (await askYesNo("Bootstrap a Chief of Staff for this network now?", false))) {
    const repo = await ask("CoS repo path (its durable memory lives here)", join(dir, "cos"));
    say("→ Bootstrapping the Chief of Staff…");
    cosCode = await cmdCos(["--repo", repo, "--network", dir]);
    if (cosCode !== 0) err("CoS bootstrap did not complete — you can run `convoy cos --repo <dir>` later.");
  }

  const rc = initExitCode(cosCode);
  if (rc !== 0) {
    // Don't tell the user the network "is ready" — they asked for a network WITH a root agent, the root
    // agent failed to come up, and the catalog is empty. `convoy doctor` next would just fail confusingly.
    err(`Network structure was created at ${dir}, but its Chief of Staff was NOT bootstrapped — the network has no agents.`);
    err(`→ next: fix the cause above, then \`convoy cos --repo <dir> --network ${dir}\`.`);
    return rc;
  }
  const addHint = choice ? ` --network ${dir}` : "";
  say(`✓ Network "${networkNameFromDir(dir)}" is ready at ${dir}.`);
  say(`  Next: run \`convoy doctor\` to prove it's set up correctly and can do real work — or add an agent with \`convoy add <role> --identity <id>${addHint}\`.`);
  if (json) out(JSON.stringify({ network: networkNameFromDir(dir), dir, stRoot: layout.stRoot, ptyRoot: layout.ptyRoot, worktrees: layout.worktrees, ...(megarepo ? { megarepo } : {}) }));
  return 0;
}

/** `convoy init`'s exit code, given the CoS bootstrap's outcome: `null` when the user didn't ask for a CoS
 *  (nothing was attempted → the network structure IS the whole deliverable → 0), else cmdCos's rc.
 *
 *  The bug this closes: init used to PRINT "CoS bootstrap did not complete" and then unconditionally
 *  `return 0` — reporting SUCCESS for a bootstrap that failed and left an EMPTY catalog behind. A caller
 *  that scripts `convoy init && convoy up` saw green and moved on to a network with no agents. A failed
 *  bootstrap must not report success. Pure → unit-testable (cmdInit's CoS branch is TTY-gated). */
export function initExitCode(cosCode: number | null): number {
  return cosCode === null ? 0 : cosCode;
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

/** Cut a git worktree off `megarepo` at `path` on branch `convoy/<identity>`. Idempotent — a no-op if the
 *  worktree dir already exists (so a re-add doesn't fail). Returns the branch name, or an actionable error. */
export async function cutWorktree(megarepo: string, path: string, identity: string): Promise<{ ok: true; branch: string } | { ok: false; error: string }> {
  const branch = `convoy/${identity}`;
  if (existsSync(path)) return { ok: true, branch }; // already cut — reuse it
  mkdirSync(dirname(path), { recursive: true });
  const r = await run("git", ["-C", megarepo, "worktree", "add", "-B", branch, path]);
  if (!r.ok) return { ok: false, error: `git worktree add off ${megarepo} failed: ${r.stderr.trim() || r.stdout.trim()}` };
  return { ok: true, branch };
}

/** A built-but-NOT-yet-written declaration, plus the context the callers need to report it. */
interface Declaration {
  readonly af: AgentFile;
  readonly path: string;
  readonly existed: boolean;
  readonly network: string;
  /** True when the workspace came from an explicit --dir (vs. the derived megarepo worktree path). */
  readonly dirGiven: boolean;
  readonly megarepo: string | null;
}

/** Build + validate the declaration for `convoy add` and `convoy run` from the SAME flags.
 *
 *  Extracted so the two verbs cannot drift: `run` is `add` plus a launch and an attach, and the only honest
 *  way to promise that is for both to compile their agent file through one function. Writes NOTHING — the
 *  caller decides whether and when to persist it (add gates on --force; run's decision table is richer).
 *  Returns a numeric exit code on failure, having already reported the error. */
async function buildDeclaration(args: string[], verb: "add" | "run"): Promise<Declaration | number> {
  const roleRaw = positionals(args)[0];
  if (!roleRaw) {
    err(`missing role. Usage: convoy ${verb} <role> --identity <id>`);
    return 2;
  }
  const role = parseRole(roleRaw);
  if (!role) {
    err(`unknown role "${roleRaw}". Valid: ${ROLES.join(", ")}`);
    return 2;
  }
  // --identity is REQUIRED for `run`, exactly as for `add`. #92 generated one (`run-b3ur0v`) when it was
  // omitted; that is precisely the hashed-name problem that makes durable context unreachable — nobody
  // re-derives a random name on the next cold boot, so the agent can never find its own context/ again.
  // A meaningful name is the cheapest thing a caller can supply and the one thing continuity depends on.
  const identity = optValue(args, "--identity");
  if (!identity) {
    err(
      verb === "run"
        ? "--identity is required. `convoy run` DECLARES the agent, and a declared agent needs a name you can re-derive — that is what lets its context/ survive a restart. Pick something meaningful: `convoy run worker --identity fodfix`."
        : "--identity is required",
    );
    return 2;
  }
  const harnessRaw = (optValue(args, "--harness") ?? "claude").toLowerCase();
  if (!isHarness(harnessRaw)) {
    err(`unknown harness "${harnessRaw}". Valid: ${HARNESSES.join(", ")}`);
    return 2;
  }
  const transport = resolveTransport(args);
  if (!transport) {
    err(`unknown transport. Valid: ding, mcp`);
    return 2;
  }
  const model = optValue(args, "--model");
  if (model !== null && !isValidModel(model)) {
    err(`invalid --model "${model}" — use letters, digits, and . _ : / - (start alphanumeric), e.g. claude-fable-5`);
    return 2;
  }
  const binRaw = optValue(args, "--bin");
  if (binRaw !== null && !isValidBin(binRaw)) {
    err(`invalid --bin "${binRaw}" — it is interpolated into the launch command, so it must be a plain path or command name (letters, digits, and . _ / -), with no spaces, quotes, or shell metacharacters`);
    return 2;
  }
  const network = resolveNetworkRoot(optValue(args, "--network"));

  // VALIDATE THE IDENTITY HERE — this is the DECLARE path, and it used to check only truthiness, so a
  // name the bus rejects (`worker_fodfix`) was written into the SYNCED catalog and propagated to every
  // peer machine before anything noticed. Validating at launch is too late by several machines. The
  // network is resolved above, so the check gets its real context: the bus grammar, the socket budget
  // for THIS network's path, and the identities already declared on it.
  const addHost = (optValue(args, "--host") ?? shortHostname()).toLowerCase();
  const declaredIds = readCatalog(network).entries.map((e) => e.af.identity);
  const idErrors = identityErrors(identity, {
    ptyRoot: networkLayout(network).ptyRoot,
    prefix: addHost,
    // A re-declare of the SAME name is an overwrite (add: gated by --force; run: the resume path), not a
    // uniqueness failure.
    existing: declaredIds.filter((d) => d !== identity),
  });
  if (idErrors.length > 0) {
    for (const e of idErrors) err(e);
    return 2;
  }

  const path = agentFilePath(catalogDir(network), identity);
  const existed = existsSync(path);

  // workspace: --dir <abs path> wins; else, with a megarepo configured, the intended per-agent worktree
  // path <net>/worktrees/<id> (materialized at launch — reuses #59). No --dir + no megarepo → no workspace
  // (agents need one) → refuse with a clear fix.
  //
  // EXCEPT when `run` is resuming an agent that is ALREADY declared: the existing agent file already carries
  // its workspace, and demanding `--dir` again would make the resume path — the everyday path, the one this
  // whole design exists to deliver — impossible to invoke without repeating what the catalog already knows.
  // `add` keeps the hard requirement: it only ever authors a declaration, so it has nothing to fall back on.
  const dir = optValue(args, "--dir");
  const cfg = readNetworkConfig(network);
  const workspace = dir ? resolve(expandTilde(dir)) : cfg?.megarepo ? join(networkLayout(network).worktrees, identity) : null;
  if (!workspace && !(verb === "run" && existed)) {
    err(`no workspace for "${identity}": pass --dir <repo>, or configure a megarepo (\`convoy init --megarepo <path>\`) so a worktree is cut for it at launch.`);
    return 1;
  }

  const persona = optValue(args, "--persona");
  const supervisor = optValue(args, "--supervisor");
  const af: AgentFile = {
    identity,
    role,
    host: addHost,
    ...(workspace ? { workspace } : {}),
    harness: harnessRaw as Harness,
    transport,
    ...(supervisor ? { supervisor } : {}),
    ...(binRaw ? { bin: binRaw } : {}),
    ...(model ? { model } : {}),
    ...(persona ? { persona } : {}),
    ...(hasFlag(args, "--permanent") ? { strategy: "permanent" as const } : {}),
  };

  return { af, path, existed, network, dirGiven: dir !== null, megarepo: cfg?.megarepo ?? null };
}

export async function cmdAdd(args: string[]): Promise<number> {
  const bad = unknownFlag(args, ...flagAllowList("add"));
  if (bad) {
    err(`unrecognized flag "${bad}" for \`convoy add\` — refusing rather than silently ignoring it. See \`convoy add --help\`.`);
    return 2;
  }
  const built = await buildDeclaration(args, "add");
  if (typeof built === "number") return built;
  const { af, path, existed, dirGiven, megarepo } = built;
  const identity = af.identity;

  // DECLARE-ONLY: `convoy add` writes the agent file (declarative intent) into the SYNCED catalog and does
  // NOTHING else — no render, no launch, no bus folder, no pretrust, no persona-clone, no worktree cut. The
  // catalog is desired state; `convoy up` renders-if-needed + launches this host's agents, `convoy render
  // <id>` materializes the overlay standalone, and `convoy run` is this same declaration plus a launch and
  // an attach. Declaring != running.
  if (existed && !hasFlag(args, "--force")) {
    err(`agent "${identity}" is already declared at ${path}. The catalog SYNCS across machines — overwriting could disrupt a running agent. Re-run with --force to replace it.`);
    return 1;
  }
  if (hasFlag(args, "--dry-run")) {
    out(`convoy add — DRY RUN: would ${existed ? "OVERWRITE" : "write"} the agent file ${path}:\n`);
    out(agentFileToToml(af));
    out("✓ Dry run only. Re-run without --dry-run to declare it.");
    return 0;
  }
  writeAgentFile(path, af);
  out(`✓ declared "${identity}" (${af.role}, host ${af.host})${existed ? " — REPLACED" : ""} → ${path}`);
  out(`  workspace: ${af.workspace}${!dirGiven && megarepo ? ` (a worktree off megarepo ${megarepo}, cut at launch)` : ""}`);
  out(`  NOTHING launched — the catalog is desired state. Run \`convoy up\` to reconcile + launch this host's agents (or \`convoy render ${identity}\` to materialize the overlay now), or \`convoy run\` to declare+launch+attach in one step.`);
  return 0;
}

/** `convoy rename <old> <new>` — move the catalog entry AND the durable bus folder, leaving a tombstone. */
export async function cmdRename(args: string[]): Promise<number> {
  const bad = unknownFlag(args, ...flagAllowList("rename"));
  if (bad) {
    err(`unrecognized flag "${bad}" for \`convoy rename\`. See \`convoy --help\`.`);
    return 2;
  }
  const [from, to] = positionals(args);
  if (!from || !to) {
    err("usage: convoy rename <old-identity> <new-identity>");
    return 2;
  }
  const network = resolveNetworkRoot(optValue(args, "--network"));
  const hostOpt = optValue(args, "--host");
  const opts = hostOpt ? { host: hostOpt } : {};

  if (hasFlag(args, "--dry-run")) {
    out(renamePreview(network, from, to, opts));
    const { errors } = planRename(network, from, to, opts);
    return errors.length > 0 ? 1 : 0;
  }

  const { plan, errors, alreadyDone } = executeRename(network, from, to, opts);
  if (errors.length > 0) {
    for (const e of errors) err(e);
    return 1;
  }
  if (alreadyDone) out(`✓ "${from}" was already renamed to "${to}" — completed the remaining steps`);
  else out(`✓ renamed "${from}" → "${to}"`);
  for (const n of plan.notes) out(`  · ${n}`);
  out(`  A RUNNING session keeps its old bus id until restarted — \`convoy reload ${to}\` (or down+up) to re-materialize it.`);
  return 0;
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
  const bad = unknownFlag(args, ...flagAllowList("cos"));
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
    bin: null,
    env: null,
    model: null, // `convoy cos` (direct CoS launch) uses the harness default; per-agent --model is a `convoy add` feature
  };
  const rc = await launchSpec(spec, { dryRun, force: hasFlag(args, "--force") });
  if (rc === 0 && !dryRun) out("The CoS will run its first-run interview on boot.");
  return rc;
}

/** `convoy run [role] --identity <id>` — DECLARE, launch, and attach.
 *
 *  `run` is `convoy add` plus a launch and an attach: the same flags, the same validation, the same catalog
 *  write (they share `buildDeclaration`, so they cannot drift), and then it starts the agent and hands the
 *  caller the terminal. This SUPERSEDES the ad-hoc session that shipped in #92 — see the header of run.ts
 *  for why the declared model is right and why #92's three objections do not survive.
 *
 *  Everything an agent needs to converge — a stable identity, a durable `context/`, reconcile and respawn
 *  under `convoy up` — follows from being DECLARED. So `run` declares, and there is no longer a second class
 *  of session for the codebase (or the operator) to keep track of.
 *
 *  `--permanent` is now accepted, unlike in #92: a run-created agent is a real catalog member, so "always-on"
 *  is a coherent thing to ask for and `strategy = "permanent"` is the legal value that expresses it. */
export async function cmdRun(args: string[]): Promise<number> {
  const bad = unknownFlag(args, ...flagAllowList("run"));
  if (bad) {
    err(`unrecognized flag "${bad}" for \`convoy run\` — refusing rather than silently ignoring it. See \`convoy run --help\`.`);
    return 2;
  }

  // Role defaults to `worker` (kept from #92): the least-privileged role that still gets a persona, and by
  // far the most common thing started by hand. `buildDeclaration` reads the role as a positional, so supply
  // the default by prepending it rather than by teaching the shared builder a run-only special case.
  const withRole = positionals(args).length > 0 ? args : ["worker", ...args];

  const built = await buildDeclaration(withRole, "run");
  if (typeof built === "number") return built;
  const { af, path, existed, network } = built;
  const identity = af.identity;
  const force = hasFlag(args, "--force");
  const dryRun = hasFlag(args, "--dry-run");

  // ACTUAL state, keyed EXACTLY as `convoy up`'s reconcile keys it (reconcile.ts `agentBusId` + up.ts
  // `busIdOf`), so `run` and `up` can never disagree about what "already running" means. The gone-but-pid-
  // alive tolerance is reconcile's too: pty can transiently report `gone` under load, and treating that as
  // dead would relaunch a live agent.
  // Read the EXISTING declaration first, because liveness must be keyed off it, not off this invocation's
  // flags. `buildDeclaration` always sets `af.host` (`--host` ?? this machine), whereas reconcile keys on
  // `entry.af.host ?? thisHost` — the DECLARATION's host. Keying on the args host would mean that for an
  // agent declared `host = dev4`, a `convoy run --identity <id>` on another box (its catalog file is present
  // via fabric sync) computes the wrong bus id, sees nothing live, and launches a duplicate. That would
  // falsify the exact property this design rests on: `run` and `up` must agree on what "already running"
  // means. Deriving both from the same source makes them agree by construction.
  let existingAf: AgentFile | null = null;
  if (existed) {
    try {
      existingAf = readAgentFile(path);
    } catch (e) {
      err(`agent "${identity}" is declared at ${path} but its agent file could not be read: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
  }

  const busId = agentBusId(livenessAgentFile(existingAf, af), shortHostname());
  const live = (await new PtyHost(network).sessions()).filter(
    (s) => busIdOf(s) === busId && (!gone(s) || processAlive(s.pid)),
  );

  const action = resolveRunAction({ declared: existed, live: live.length > 0, force });
  if (action === "refuse-live-force") {
    err(liveForceRefusal(identity));
    return 1;
  }

  // On resume/attach the EXISTING declaration is authoritative — the catalog is the source of truth once it
  // exists, and silently re-declaring from this invocation's flags would let a stray `--model` mutate a
  // synced, fleet-visible agent file as a side effect of attaching to it.
  const reuseExisting = action === "resume" || action === "attach";
  const effective = reuseExisting && existingAf ? existingAf : af;
  if (reuseExisting) {
    // The role is a POSITIONAL, not a flag, so `passedDeclarationFlags` cannot see it — report it
    // separately rather than silently resuming `cos` as its declared role when the caller typed another.
    const declaredRole = existingAf?.role;
    const askedRole = positionals(args)[0];
    const roleDiffers = askedRole !== undefined && declaredRole !== undefined && parseRole(askedRole) !== declaredRole;
    const note = staleFlagsNote(identity, [...(roleDiffers ? [`role "${askedRole}"`] : []), ...passedDeclarationFlags(args)]);
    if (note) out(note);
  }

  const spec = agentFileToSpec(effective, { networkRoot: network });
  const ref = sessionId(spec);
  const attach = !hasFlag(args, "--no-attach");

  out(`convoy run — ${identity} (${effective.harness ?? "claude"}, ${effective.role})`);
  out(`workspace: ${effective.workspace ?? "(none)"}`);
  // Print the host-prefixed ids: they are what `convoy up`, `pty attach`, and `st` all key on, and showing
  // them makes an unexpected host (a declaration owned by another box) visible before anything launches.
  out(`session: ${ref} · bus: ${busAgentId(spec)}`);

  if (action === "attach") {
    out(`  already running (${live.map((s) => s.name).join(", ")}) — attaching, NOT restarting it.`);
    if (dryRun) {
      out(`✓ Dry run only. Re-run without --dry-run to attach to ${ref}.`);
      return 0;
    }
    if (!attach) {
      out(`✓ ${identity} is running. \`pty attach ${ref}\` to join it.`);
      return 0;
    }
    return execInteractive("pty", ["attach", ref]);
  }

  // declare / redeclare → persist the declaration. `resume` deliberately writes NOTHING.
  if (action === "declare" || action === "redeclare") {
    if (dryRun) {
      out(`convoy run — DRY RUN: would ${existed ? "OVERWRITE" : "write"} the agent file ${path}:\n`);
      out(agentFileToToml(af));
      out(`✓ Dry run only. Re-run without --dry-run to declare, launch, and attach ${identity}.`);
      return 0;
    }
    writeAgentFile(path, af);
    out(`✓ declared "${identity}" (${af.role}, host ${af.host})${action === "redeclare" ? " — REPLACED" : ""} → ${path}`);
  } else {
    out(`  resuming the declared agent — its context/ and bus folder are picked back up where they were.`);
    if (dryRun) {
      out(`✓ Dry run only. Re-run without --dry-run to launch and attach ${identity}.`);
      return 0;
    }
  }

  const rc = await launchSpec(spec, { dryRun: false, force });
  if (rc !== 0) return rc;

  out();
  out(declaredRunNotice(identity, busAgentId(spec), ref));
  out();
  if (!attach) return 0;
  return execInteractive("pty", ["attach", ref]);
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
  const bad = unknownFlag(args, ...flagAllowList("ls"));
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

/** DECOMMISSION an agent in the catalog: set `retired = true` in its agent file — NEVER delete the file. The
 *  catalog syncs UNION / no-delete (see agent-file.ts), so a file DELETE is undone by a peer (the agent then
 *  respawns), while a `retired = true` EDIT syncs newer-wins and `convoy up` reconcile tears the agent down +
 *  never relaunches it — on every machine. Resolves the file from either a BARE identity (the catalog stem, as
 *  `convoy render` takes) or a host-prefixed BUS id (`<host>.<identity>`, what `convoy ls` shows — strips the
 *  leading `<host>.`). Returns `{ path, already }` when a catalog file is found (`already` = it was already
 *  retired, so no rewrite), or `null` when there is no catalog entry for the id. Pure-ish (fs) → unit-testable. */
export function retireInCatalog(catalog: string, identity: string): { path: string; already: boolean } | null {
  let path = agentFilePath(catalog, identity);
  if (!existsSync(path) && identity.includes(".")) {
    path = agentFilePath(catalog, identity.slice(identity.indexOf(".") + 1)); // strip a leading <host>. bus prefix
  }
  if (!existsSync(path)) {
    // Not at the flat path: the catalog is a TREE and identity comes from CONTENT, so a spec declaring
    // this agent can live at any depth under any filename. Fall back to discovery rather than reporting
    // a hand-authored (or spec-layout) agent as absent.
    // Only TOML specs are REWRITABLE — convoy reads three formats but serializes one, so retiring a
    // KDL/JSON spec would mean writing TOML into a `.kdl` file. Those are left for the author to edit
    // (`retired = true`); see the write-what-you-read gap in the VRS.
    const bare = identity.includes(".") ? identity.slice(identity.indexOf(".") + 1) : identity;
    const found = readCatalog(dirname(catalog)).entries.find(
      (e) => (e.af.identity === identity || e.af.identity === bare) && e.path.endsWith(".toml"),
    );
    if (!found) return null;
    path = found.path;
  }
  const af = readAgentFile(path);
  if (af.retired) return { path, already: true };
  writeAgentFile(path, { ...af, retired: true });
  return { path, already: false };
}

export async function cmdRemove(args: string[]): Promise<number> {
  const badFlag = unknownFlag(args, ...flagAllowList("remove"));
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
  // Resolve the catalog agent file up front (bare id or host-prefixed bus id). An agent "exists" if it has a
  // catalog entry OR is a live bus member — a DECLARED-but-down agent (catalog entry, no session) is still
  // removable (that's exactly the decommission case).
  const catalog = catalogDir(network);
  let afPath = agentFilePath(catalog, identity);
  if (!existsSync(afPath) && identity.includes(".")) afPath = agentFilePath(catalog, identity.slice(identity.indexOf(".") + 1));
  const hasCatalogEntry = existsSync(afPath);
  const members = (await new Bus(stRootOf(network)).agents()).map((a) => a.identity);
  if (!hasCatalogEntry && !members.includes(identity)) {
    err(`no agent "${identity}" on this network (no catalog entry and not a live member). \`convoy ls\` to list members.`);
    return 1;
  }
  const host = new PtyHost(network);
  const sessions = (await host.sessions()).filter((s) => {
    const dn = s.tags["ptyfile.session"];
    return s.name === identity || dn === identity || [...HARNESS_SESSION_KEYS, "ding"].some((suf) => `${identity}-${suf}` === dn);
  });
  out("convoy remove — plan:");
  // Decommission = set retired=true (the union-safe edit), NOT delete — a deleted catalog file is restored by a
  // peer's union/no-delete sync, so the agent respawns; retired=true syncs + reconcile tears it down for good.
  if (hasCatalogEntry) out(`  set retired=true in ${afPath} (the union-safe decommission — syncs to peers; reconcile won't relaunch)`);
  else out(`  no catalog entry for "${identity}" — stopping its sessions only (nothing to retire)`);
  if (sessions.length === 0) out(`  no running pty sessions for ${identity} (already down)`);
  for (const s of sessions) out(`  stop pty session ${s.name}`);
  if (hasFlag(args, "--dry-run")) {
    out("\n✓ Dry run only. Re-run without --dry-run to execute.");
    return 0;
  }
  const retired = retireInCatalog(catalog, identity);
  if (retired && !retired.already) out(`✓ set retired=true for ${identity} (${retired.path})`);
  else if (retired?.already) out(`  ${identity} was already retired=true`);
  for (const s of sessions) out((await host.kill(s.name)) ? `✓ stopped ${s.name}` : `• ${s.name} didn't stop cleanly (already exited?)`);
  out(`✓ ${identity} removed from the convoy.`);
  return 0;
}

/** `convoy job <done|status> [--job <id>] [--status ok|fail] [--message <t>] [--network <net>]` — the
 *  batch-job lifecycle verb. `done` writes the COMPLETION EVENT the eval orchestrator waits on: an agent
 *  (a team cell's supervisor) calls `convoy job done --status ok` when the whole task is verified complete,
 *  which replaces the human-watching-the-bus with a deterministic, machine-clean signal. `status` reads it
 *  back (pending vs done) — for debugging + scripts. The network is resolved by convoy's ONE resolver, so
 *  the file the agent writes is exactly the one the orchestrator polls (see src/job.ts). */
export async function cmdJob(args: string[]): Promise<number> {
  if (hasFlag(args, "--help", "-h")) {
    out(
      "convoy job <done|status> — the batch-job completion signal `convoy eval` waits on.\n\n" +
        "  done                write the completion event (the job is finished)\n" +
        "    --status ok|fail   the job's self-reported outcome (default: ok)\n" +
        "    --message <text>   optional note (why ok/fail) — surfaced in the verdict\n" +
        "  status                read the completion event back (rc=0 done, rc=1 pending)\n" +
        "    --json              print the event (or {status:\"pending\"}) as JSON\n" +
        "  --job <id>            job id within the network (default: \"" + DEFAULT_JOB_ID + "\")\n" +
        "  --network <net>       the network (default: ambient ST_ROOT / convoy default)\n" +
        "\nAn agent (a team cell's supervisor) calls `convoy job done --status ok` when the whole task is verified\n" +
        "complete; the event lands at <net>/jobs/<job>.done.json, which `convoy eval` polls.",
    );
    return 0;
  }
  const sub = positionals(args)[0];
  if (sub !== "done" && sub !== "status") {
    err(`unknown \`convoy job\` subcommand ${sub ? `"${sub}"` : "(none)"}. Usage: convoy job done [--status ok|fail] | convoy job status`);
    return 2;
  }
  const badFlag = unknownFlag(args, ...flagAllowList("job"));
  if (badFlag) {
    err(`unrecognized flag "${badFlag}" for \`convoy job\`. See \`convoy job --help\`.`);
    return 2;
  }
  const network = resolveNetworkRoot(optValue(args, "--network"));
  const job = optValue(args, "--job") ?? DEFAULT_JOB_ID;
  if (!isValidJobId(job)) {
    err(`invalid --job "${job}": use lowercase letters, digits, and . _ - (start alphanumeric)`);
    return 2;
  }

  if (sub === "status") {
    const ev = readCompletion(network, job);
    if (hasFlag(args, "--json")) {
      out(JSON.stringify(ev ?? { job, status: "pending" }));
    } else if (ev) {
      out(`job ${job}: DONE — status=${ev.status}${ev.by ? ` by ${ev.by}` : ""}${ev.message ? ` — ${ev.message}` : ""}`);
      out(`  event: ${completionPath(network, job)}`);
    } else {
      out(`job ${job}: pending (no completion event at ${completionPath(network, job)})`);
    }
    return ev ? 0 : 1; // rc=1 = not-yet-done, so a script can `until convoy job status` poll
  }

  // done
  const statusRaw = optValue(args, "--status") ?? "ok";
  if (statusRaw !== "ok" && statusRaw !== "fail") {
    err(`invalid --status "${statusRaw}" (want: ok | fail)`);
    return 2;
  }
  const status: JobStatus = statusRaw;
  const message = optValue(args, "--message") ?? undefined;
  const by = process.env["ST_AGENT"] || undefined;
  const path = writeCompletion(network, { job, status, message, by, ts: Date.now() });
  out(`✓ convoy job ${job} done — status=${status}${by ? ` (by ${by})` : ""}. Wrote ${path}`);
  return 0;
}

/** `convoy render <identity> [--dir <workspace>] [--network <net>] [--dry-run]` — the "materialize the
 *  overlay" verb of the declarative model (add = declare · render = materialize · up = reconcile). Reads the
 *  agent file `<net>/catalog/<identity>.toml` (the declarative intent), compiles it to an AgentSpec, and
 *  writes the worktree-local overlay — .claude/rules/convoy.md (loader) + .convoy/{PERSONA.md,DING-BUS.md,
 *  pty.toml} + .claude/settings.local.json — git-excluding all of it. It does NOT launch a pty or touch the
 *  bus (that's `convoy up`). --dry-run prints exactly which files it would write + git-exclude, touching
 *  nothing — the no-pollution footprint, made inspectable. Independently useful now (hand-author an agent
 *  file, render it, look); `convoy add` will author the file in piece 2. */
export async function cmdRender(args: string[]): Promise<number> {
  const bad = unknownFlag(args, ...flagAllowList("render"));
  if (bad) {
    err(`unrecognized flag "${bad}" for \`convoy render\`. See \`convoy render --help\`.`);
    return 2;
  }
  const identity = positionals(args)[0];
  if (!identity) {
    err("missing identity. Usage: convoy render <identity> [--dir <workspace>] [--dry-run]");
    return 2;
  }
  const network = resolveNetworkRoot(optValue(args, "--network"));
  const dryRun = hasFlag(args, "--dry-run", "--print");
  const dirOverride = optValue(args, "--dir") ?? undefined;

  // Resolve the agent file (the declarative intent) from the SYNCED catalog. Pre-piece-2 nothing auto-writes
  // these, so a user hand-authors <net>/catalog/<identity>.toml for the manual/inspect use case.
  const afPath = agentFilePath(catalogDir(network), identity);
  if (!existsSync(afPath)) {
    err(`no agent file for "${identity}" at ${afPath}.\n  Write one (a sample is below), or once \`convoy add\` writes the catalog (piece 2) it'll be there.\n\n${SAMPLE_AGENT_TOML}`);
    return 1;
  }
  let spec: AgentSpec;
  try {
    const af = readAgentFile(afPath);
    spec = agentFileToSpec(af, { networkRoot: network, workspace: dirOverride });
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    return 1;
  }
  const workspace = spec.workingDir;
  if (!workspace) {
    err(`no workspace for "${identity}": the agent file has no \`workspace\` and no --dir was given.`);
    return 1;
  }

  // The overlay files render materializes (conditional ones match the writers: PERSONA.md only when a
  // persona resolves; DING-BUS.md only on the ding transport). pty.toml + hooks + the loader are always written.
  const hasPersona = (() => {
    const p = resolvedPersonaPath(spec);
    return p !== null && existsSync(p);
  })();
  const files = [
    ".claude/rules/convoy.md",
    ...(hasPersona ? [`${CONVOY_DIR}/PERSONA.md`] : []),
    ...(spec.transport === "ding" ? [`${CONVOY_DIR}/DING-BUS.md`] : []),
    `${CONVOY_DIR}/pty.toml`,
    ".claude/settings.local.json",
  ];
  const excludes = [`${CONVOY_DIR}/`, ".claude/rules/convoy.md"];

  if (dryRun) {
    out(`convoy render — DRY RUN for "${identity}" (agent file ${afPath}) → ${workspace}`);
    out("  would WRITE:");
    for (const f of files) out(`    ${join(workspace, f)}`);
    out("  would GIT-EXCLUDE (in .git/info/exclude):");
    for (const e of excludes) out(`    ${e}`);
    out("  would launch NO pty + touch NO bus.");
    out("\n✓ Dry run only. Re-run without --dry-run to materialize.");
    return 0;
  }

  // Footgun-proof: clone the role's default persona if there's no override, so PERSONA.md resolves.
  if (spec.personaOverride === null) {
    try {
      await ensureInstalled();
    } catch (e) {
      err(`personas: ${e instanceof Error ? e.message : String(e)} (rendering without the role persona)`);
    }
  }
  mkdirSync(workspace, { recursive: true });
  writeAgentFiles(workspace, spec);
  out(`✓ rendered "${identity}" → ${workspace}`);
  out(`  wrote ${files.length} overlay file(s) + git-excluded them; launched NO pty, touched NO bus.`);
  out("  `git status` in the workspace stays clean; inspect .convoy/ + .claude/rules/convoy.md to see the whole footprint.");
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
  const norm = (s: string): string => s.replace(HARNESS_SUFFIX_RE, "").replace(/[^a-z0-9]/gi, "").toLowerCase();
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
  const bad = unknownFlag(args, ...flagAllowList("pretrust"));
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
  if (!isHarness(harness)) {
    err(`unknown harness "${harness}". Valid: ${HARNESSES.join(", ")}`);
    return 2;
  }
  const configDir = optValue(args, "--config-dir");
  // `--config-dir` names the harness's OWN config-relocation target — `<dir>/.claude.json` for claude,
  // `<dir>/config.toml` for codex. It was previously refused for codex on the grounds that it "applies
  // only to claude"; that was true of the implementation, not of codex, which relocates via CODEX_HOME
  // exactly as claude does via CLAUDE_CONFIG_DIR (decision 0004 names both). The refusal now falls where
  // it is actually true: a harness with no config-relocation var at all.
  const configEnvName = harnessDescriptor(harness).configEnv;
  if (configDir && configEnvName === null) {
    err(`--config-dir does not apply to --harness ${harness}: it has no config-relocation environment variable, so convoy cannot select an account for it`);
    return 2;
  }
  // Pre-trust writes a harness-specific trust store. convoy only knows two of those shapes; for anything
  // else, writing the claude file would report success for a trust the agent never reads. Refuse instead.
  if (harness !== "claude" && harness !== "codex") {
    err(`convoy has no trust store for --harness ${harness}; pre-trust its workspace with the harness itself`);
    return 2;
  }
  const abs = dirs.map((d) => resolve(expandTilde(d)));
  for (const d of abs) if (!existsSync(d)) err(`warning: ${d} does not exist yet — create it before pre-trusting so the realpath matches (proceeding on the literal path)`);
  const cfgDirAbs = configDir ? resolve(expandTilde(configDir)) : undefined;
  const cfgPath = harness === "codex" ? codexConfigPath(cfgDirAbs) : cfgDirAbs ? `${cfgDirAbs}/.claude.json` : claudeConfigPath();
  const { trusted, failed } =
    harness === "codex" ? pretrustDirsCodex(abs, cfgDirAbs) : pretrustDirs(abs, cfgDirAbs);
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
  out("convoy app: the macOS app now lives in the convoy-macos repo.");
  return 0;
}
