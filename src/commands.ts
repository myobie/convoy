// convoy CLI command handlers, ported from Sources/convoy/Commands/*.swift + Runner.swift. Each
// returns an exit code. Small arg helpers keep the hand-rolled parsing consistent (like pty's cli.ts).

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { run } from "./exec.ts";
import { Bus, isLive } from "./bus.ts";
import { PtyHost, spawnFromPtyFile, type SupervisedSession } from "./host.ts";
import { nativeLaunch } from "./launch.ts";
import { baseFile, ensureInstalled, personasDir, personasInstalled } from "./personas.ts";
import { ROLES, parseRole } from "./role.ts";
import { preflight, type AgentSpec, type Harness, type Transport } from "./agent-spec.ts";

// ---- arg helpers ----
export function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      if (!BOOL_FLAGS.has(a)) i++; // skip the value of a value-option
    } else if (!a.startsWith("-")) {
      out.push(a);
    }
  }
  return out;
}
const BOOL_FLAGS = new Set(["--dry-run", "--yes", "-y", "--mcp", "--permanent", "--purge", "--json", "--live-only", "--no-channel", "--force"]);
export function optValue(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1]! : null;
}
export function hasFlag(args: string[], ...names: string[]): boolean {
  return names.some((n) => args.includes(n));
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

// ---- commands ----
export async function cmdDoctor(args: string[]): Promise<number> {
  const network = optValue(args, "--network");
  let failures = 0;
  const bullet = (ok: boolean | null, s: string): void => out(`  ${ok === null ? "•" : ok ? "✓" : "✗"} ${s}`);

  out("Tooling");
  const st = await whichCmd("st");
  const pty = await whichCmd("pty");
  bullet(st !== null, st ? `st on PATH (${st})` : "st NOT on PATH — install smalltalk");
  if (!st) failures++;
  bullet(pty !== null, pty ? `pty on PATH (${pty})` : "pty NOT on PATH — sessions can't be managed");
  if (!pty) failures++;

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

  out("Personas");
  bullet(personasInstalled() ? true : null, personasInstalled() ? `base personas installed (${personasDir()})` : "base personas not installed — `convoy personas install` (auto-installed by add/cos)");

  out();
  if (failures === 0) {
    out("✓ convoy is ready here.");
    return 0;
  }
  out(`✗ ${failures} blocking issue${failures === 1 ? "" : "s"} — resolve the ✗ lines above.`);
  return 1;
}

export async function cmdInit(args: string[]): Promise<number> {
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
    networkRoot: optValue(args, "--network"),
    personaOverride: optValue(args, "--persona"),
    workingDir: optValue(args, "--dir"),
    permanentOverride: hasFlag(args, "--permanent") ? true : null,
    prefix: optValue(args, "--prefix"),
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
    networkRoot: optValue(args, "--network"),
    personaOverride: optValue(args, "--persona"),
    workingDir: absRepo,
    permanentOverride: null,
    prefix: optValue(args, "--prefix"),
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
    err("missing identity. Usage: convoy reload <id> [--dry-run]");
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
  out(`convoy reload — plan for ${identity} (from ${ptyfile}):`);
  for (const s of sessions) out(`  stop ${s.name}`);
  out("  respawn fresh from pty.toml (re-reads it — permission-mode / displayName / ding-ref / --resume edits take effect)");
  if (hasFlag(args, "--dry-run")) {
    out("\n✓ Dry run only. Re-run without --dry-run to execute.");
    return 0;
  }
  for (const s of sessions) await host.kill(s.name);
  const { spawned, failed } = await spawnFromPtyFile(dir, network);
  for (const n of spawned) out(`✓ spawned ${n}`);
  for (const n of failed) out(`✗ failed ${n}`);
  out(`✓ reloaded ${identity} from pty.toml.`);
  return failed.length > 0 ? 1 : 0;
}

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
