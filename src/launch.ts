// Native launch — convoy writes ALL agent wiring itself. No `st launch` shell, no `cmdLaunch` import
// (both are being deleted). This reimplements what `st launch` wrote (captured from st 2026-07-07):
// pty.toml, the claude session command (cold-start boot prompt), PERSONA.md / DING-BUS.md / CLAUDE.md,
// the Claude Code hooks, and the `st ding` sidecar. smalltalk keeps ONLY: the bus (`st`), the `st ding`
// binary (spawned as a command, not imported), and the hook SCRIPTS (referenced by path).

import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as tomlParse, stringify as tomlStringify } from "smol-toml";
import { spawnFromPtyFile } from "./host.ts";
import { ensureInstalled } from "./personas.ts";
import { busAgentId, resolvedPersonaPath, sessionId, specPermanent, specPermissionMode, type AgentSpec, type Harness } from "./agent-spec.ts";
import type { Role } from "./role.ts";
import { pretrustDir, pretrustDirsCodex } from "./trust.ts";
import { CONVOY_DIR, networkLayout, stRootOf } from "./paths.ts";
import { counterContextRefusal } from "./identity.ts";

// The pty session key is per-harness: claude → [sessions.claude], codex → [sessions.codex]. (Before,
// this was hardcoded "claude", so `--harness codex` silently wrote a claude session — a false-harness
// footgun.)
const HARNESS_SESSION_KEY: Record<Harness, string> = { claude: "claude", codex: "codex" };

/** codex has no MCP transport, so a codex agent always runs the ding sidecar; claude honors its transport. */
function usesDing(spec: AgentSpec): boolean {
  return spec.harness === "codex" || spec.transport === "ding";
}

// The initial boot-ritual PROMPT handed to claude as its first arg — a COLD start. A real prompt
// actually processes on launch and triggers the agent's boot (set available, drain inbox); a blank
// auto-poker just left queued input. Keep these single-quote-safe (no apostrophes) — the launch
// command wraps them in single quotes for `sh -c`.
const BOOT_PROMPT_WORKER =
  "You just cold-started. Run your boot ritual now: set your st status to available and drain your inbox (read, act on, and archive each message). Then stand by for work delivered via ding.";
const BOOT_PROMPT_COS =
  "You just cold-started. Run your boot ritual (set status available, drain inbox). If this is a fresh network with no populated private cos repo, run your first-run interview now, per your persona.";
/** The CoS gets the first-run-interview variant; every other role gets the worker boot. */
export function bootPrompt(role: Role): string {
  return role === "chief-of-staff" ? BOOT_PROMPT_COS : BOOT_PROMPT_WORKER;
}

/** Find an executable by name on PATH (sync, no subprocess), or null. */
function whichSync(cmd: string): string | null {
  for (const dir of (process.env["PATH"] ?? "").split(delimiter)) {
    if (!dir) continue;
    try {
      const p = join(dir, cmd);
      if (statSync(p).isFile()) return p;
    } catch {
      // not in this dir
    }
  }
  return null;
}

/** Does this dir hold smalltalk's Claude Code hook scripts? */
function hasHooks(dir: string): boolean {
  return existsSync(join(dir, "examples", "claude-code", "hooks", "session-start.sh"));
}

/** The smalltalk repo that owns an `st` binary path: `<smalltalk>/bin/st` → its resolved grandparent. Null
 *  if the path is empty or an unresolvable symlink. Shared by the ST_BIN + `which st` discovery candidates. */
function smalltalkFromStBinary(stBin: string): string | null {
  if (!stBin) return null;
  try {
    return dirname(dirname(realpathSync(stBin))); // <smalltalk>/bin/st → <smalltalk>
  } catch {
    return null; // unresolvable symlink / missing path
  }
}

/** Discover the smalltalk repo (for its hook scripts + the `st` binary the hooks invoke), tolerating a
 *  fresh install with NO `SMALLTALK_DIR` set. Order: (1) `SMALLTALK_DIR` env; (2) `ST_BIN` env — the
 *  ABSOLUTE `st` path baked into each agent's hook commands, so it works even when `st` is NOT on PATH
 *  (Johannes's box: the hooks run via ST_BIN, not PATH — the old check false-failed there); (3) the `st`
 *  binary on PATH (`<smalltalk>/bin/st` → grandparent); (4) the sibling `../smalltalk` dev checkout.
 *  Returns the first candidate that actually contains the hooks, else null. */
export function discoverSmalltalkDir(): string | null {
  const candidates: string[] = [];
  const env = process.env["SMALLTALK_DIR"];
  if (env) candidates.push(env);
  const fromStBin = smalltalkFromStBinary(process.env["ST_BIN"] ?? ""); // the hooks bake ST_BIN — usable off-PATH
  if (fromStBin) candidates.push(fromStBin);
  const st = whichSync("st");
  if (st) {
    const fromPath = smalltalkFromStBinary(st);
    if (fromPath) candidates.push(fromPath);
  }
  candidates.push(join(dirname(dirname(fileURLToPath(import.meta.url))), "..", "smalltalk"));
  for (const c of candidates) if (hasHooks(c)) return c;
  return null;
}

/** Resolve the hook scripts + the st binary the hooks invoke. Throws loud (naming every discovery path)
 *  if smalltalk can't be found — so a fresh install fails clearly, not silently at spawn. */
function hookRefs(): { stBin: string; sessionStart: string; preCompact: string; stopFailure: string } {
  const root = discoverSmalltalkDir();
  if (root === null) {
    throw new Error(
      "smalltalk hook scripts not found. convoy looks via SMALLTALK_DIR, the `st` binary on PATH " +
        "(<smalltalk>/bin/st), and the sibling ../smalltalk. Set SMALLTALK_DIR to your smalltalk clone, " +
        "or make sure `st` is on PATH.",
    );
  }
  const hooks = join(root, "examples", "claude-code", "hooks");
  return {
    stBin: join(root, "bin", "st"),
    sessionStart: join(hooks, "session-start.sh"),
    preCompact: join(hooks, "pre-compact.sh"),
    stopFailure: join(hooks, "stop-failure.sh"),
  };
}

/** The agent's main harness session command: a COLD start — no auto-poker — handing the harness the
 *  INITIAL BOOT-RITUAL PROMPT as its first arg (single-quoted so `sh -c` passes it as one argument).
 *  claude gates on `--permission-mode`; codex, which runs unattended like every other agent, bypasses
 *  approvals + sandbox (the parallel to claude's bypass posture). `model` (null → the harness default,
 *  today's behavior) adds `--model '<id>'` — single-quoted for `sh -c`, and the id is charset-validated
 *  upstream (isValidModel) so the quotes can't be broken out of. Both harnesses accept `--model`. */
export function harnessCommand(harness: Harness, permissionMode: string, prompt: string, model?: string | null, bin?: string | null): string {
  const modelFlag = model ? ` --model '${model}'` : "";
  // `bin` replaces ONLY the binary name; every derived flag still applies, so a wrapper inherits the
  // correct-by-construction wiring instead of having to re-derive it. Charset-validated upstream
  // (isValidBin) because it lands unquoted in the `sh -c` string.
  const cmd = bin || harness;
  if (harness === "codex") return `exec ${cmd} --dangerously-bypass-approvals-and-sandbox${modelFlag} '${prompt}'`;
  return `exec ${cmd} --permission-mode ${permissionMode}${modelFlag} '${prompt}'`;
}

/** The ding sidecar command — pokes the agent's claude session when its bus inbox gets mail. Points at
 *  the stable session id (`st ding <prefix.agentShort> --identity <bus-id>`). `st ding` stays a
 *  smalltalk runtime binary. When a network `root` is given we bake `--root <net>` (smalltalk #85) into
 *  the command line — NOT just the env — so a `pty restart` (which replays the stored command) can never
 *  drop it and silently fall back to st's install-default root (the fleet phantom-poke/non-delivery bug). */
export function dingCommand(busId: string, claudeSessionId: string, root?: string | null): string {
  const rootFlag = root ? ` --root ${root}` : "";
  return `st ding ${claudeSessionId} --identity ${busId}${rootFlag}`;
}

/** Provision the agent's DURABLE CONTEXT dir (`<member>/context/`) — unless the identity is a counter.
 *
 *  `context/now.md` is the memory a cold-booted agent reconstructs itself from, so it is only safe when
 *  the name that addresses it means ONE agent for as long as the file exists. A `<role>-<n>` counter does
 *  not: it re-derives per parent lifetime, so after a restart `worker-2` names a different agent and would
 *  read its predecessor's now.md as its own memory — and act on it. That failure is silent and arrives
 *  weeks after the naming choice, which is exactly the kind a warning does not prevent.
 *
 *  So the dir is REFUSED rather than warned about, and the refusal is narrow: the agent still launches and
 *  still gets a bus folder — convoy just does not hand it a pre-made place to keep memory.
 *
 *  This is a strong DEFAULT, not an invariant. The dir is not convoy's to withhold: `st context write`
 *  creates it unconditionally, so an agent that externalizes work state makes its own. What this removes
 *  is the case where a renumbered agent finds one already waiting for it. Real enforcement belongs where
 *  the dir is created (the bus) — see context/.delta/DELTA-005. Returns the refusal message, else null. */
export function provisionContext(memberDir: string, identity: string): string | null {
  const refusal = counterContextRefusal(identity);
  if (refusal !== null) {
    process.stderr.write(`convoy: ${refusal}\n`);
    return refusal;
  }
  mkdirSync(join(memberDir, "context", "decisions"), { recursive: true });
  return null;
}

/** Serialize the per-agent pty.toml (pty's manifest format — NOT a convoy.toml). Pins the session ids
 *  to `<prefix>.<agentShort>` (claude) and `<prefix>.<agentShort>.ding` so the ding + name refs stay
 *  stable across respawns; prefix defaults to the short hostname. `opts.spawner` (the bus id of whoever ran
 *  `convoy add`, from their ST_AGENT) is stamped on the HARNESS session so a crash-ding reaches this agent's
 *  ACTUAL supervisor, not the whole permanent crew (see up.ts crashDingTargets). */
export function writePtyToml(dir: string, spec: AgentSpec, opts?: { spawner?: string | null }): void {
  const busId = busAgentId(spec); // the host-prefixed bus identity, e.g. silber.convoy-claude
  const root = spec.networkRoot; // the network DIR; ST_ROOT is <root>/smalltalk (the bus), PTY_ROOT is <root>/pty
  const harnessId = sessionId(spec); // e.g. silber.convoy (agentShort strips the -claude/-codex suffix)
  const dingId = `${harnessId}.ding`; // e.g. silber.convoy.ding
  const permanent = specPermanent(spec);
  const stTag = root ? { "st.network": root } : {};
  // Crash-ding targeting tags (read by up.ts crashDingTargets), HARNESS session only — never the ding sidecar
  // (else a crash double-dings the same busId): `convoy.tier=cos` marks the CoS (the always-ding backstop);
  // `convoy.spawner` records who spawned this agent (its supervisor) so a worker crash pages the parent.
  const agentTags: Record<string, string> = {
    ...(spec.role === "chief-of-staff" ? { "convoy.tier": "cos" } : {}),
    ...(opts?.spawner ? { "convoy.spawner": opts.spawner } : {}),
  };
  const env: Record<string, string> = { ST_AGENT: busId };
  if (root) {
    env["ST_ROOT"] = stRootOf(root); // the bus root is <net>/smalltalk, NOT the network dir
    env["PTY_ROOT"] = `${root}/pty`;
  }
  // CLAUDE_CONFIG_DIR relocates Claude Code's whole config (auth/settings/skills) — harness session only,
  // never the ding sidecar (which is just `st ding` and doesn't read it).
  // Spec `env` first, derived wiring LAST: ST_AGENT/ST_ROOT/PTY_ROOT are correct-by-construction (AC-1)
  // and a hand-written env key must never be able to repoint the agent at another bus.
  const specEnv = spec.env ?? {};
  const harnessEnv = { ...specEnv, ...env, ...(spec.configDir ? { CLAUDE_CONFIG_DIR: spec.configDir } : {}) };
  const doc: Record<string, unknown> = {
    prefix: harnessId,
    sessions: {
      [HARNESS_SESSION_KEY[spec.harness]]: {
        id: harnessId,
        command: harnessCommand(spec.harness, specPermissionMode(spec), bootPrompt(spec.role), spec.model, spec.bin),
        tags: { role: "agent", ...(permanent ? { strategy: "permanent" } : {}), ...stTag, ...agentTags },
        env: harnessEnv,
      },
      ...(usesDing(spec)
        ? {
            ding: {
              id: dingId,
              command: dingCommand(busId, harnessId, root ? stRootOf(root) : null),
              tags: { role: "ding", ...(permanent ? { strategy: "permanent" } : {}), ...stTag },
              env,
            },
          }
        : {}),
    },
  };
  const convoyDir = join(dir, CONVOY_DIR);
  mkdirSync(convoyDir, { recursive: true });
  writeFileSync(join(convoyDir, "pty.toml"), tomlStringify(doc));
  excludeFromGit(dir, [`${CONVOY_DIR}/`]); // the whole convoy-authored overlay stays out of git status
}

/** Heal a PRE-#43 pty.toml so its ding survives a `pty restart` (which preserves the command but drops
 *  the env — the actual ST_ROOT durability engine). Rewrites ONLY the `[sessions.ding]` command to carry
 *  `--root <net>` (via `dingCommand`), leaving the `[sessions.claude]` harness block — the role boot
 *  prompt + `--resume` uuid, which are NOT structurally recoverable — VERBATIM. Idempotent (a no-op once
 *  `--root` is present) and surgical (a literal replace of the ding command string; the rest of the file
 *  is byte-for-byte untouched). Returns the before/after ding command, or null if nothing changed / there
 *  is no ding / no root is known. `dryRun` computes the diff without writing. This is convoy#43's
 *  cold-start counterpart: #43 fixed writePtyToml for NEW agents; this heals the existing FILES so a
 *  `convoy reload` / cold `convoy up` re-materializes a durable ding instead of an env-only one. */
export function regenerateDingRoot(dir: string, opts?: { dryRun?: boolean }): { before: string; after: string } | null {
  const path = join(dir, CONVOY_DIR, "pty.toml"); // `dir` is the workspace; the manifest lives in .convoy/
  const text = readFileSync(path, "utf8");
  const doc = tomlParse(text) as { sessions?: { ding?: { command?: unknown; env?: Record<string, string>; tags?: Record<string, string> } } };
  const ding = doc.sessions?.ding;
  if (!ding || typeof ding.command !== "string") return null;
  const before = ding.command;
  const m = before.match(/st ding (\S+) --identity (\S+)/); // target + bus id, robust to a leading inline env or trailing --root
  if (!m) return null;
  const [, target, busId] = m;
  const net = ding.env?.["ST_ROOT"] ?? ding.tags?.["st.network"];
  if (!target || !busId || !net) return null; // incomplete — don't emit a bare/guessed --root
  const after = dingCommand(busId, target, net);
  if (after === before) return null; // already durable (has --root) — idempotent
  const updated = text.replace(`command = "${before}"`, `command = "${after}"`);
  if (updated === text) return null; // literal command not found verbatim — refuse to half-write
  if (!opts?.dryRun) writeFileSync(path, updated);
  return { before, after };
}

/** The Claude Code hooks (SessionStart boot-ritual, PreCompact flush, StopFailure ding) — reference
 *  smalltalk's kept hook scripts by path. Reproduces st launch's settings.local.json. */
function writeHooks(dir: string): void {
  const h = hookRefs();
  const cmd = (script: string): string => `ST_BIN=${h.stBin} ${script}`;
  const settings = {
    $schema: "https://json.schemastore.org/claude-code-settings.json",
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", async: true, asyncRewake: true, command: cmd(h.sessionStart) }] }],
      PreCompact: [{ hooks: [{ type: "command", command: cmd(h.preCompact) }] }],
      StopFailure: [{ hooks: [{ type: "command", command: cmd(h.stopFailure) }] }],
    },
  };
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(join(dir, ".claude", "settings.local.json"), `${JSON.stringify(settings, null, 2)}\n`);
  // convoy-authored — keep it out of the composed repo's git status. Belt-and-suspenders + host-
  // independent: some machines have a global gitignore for settings.local.json, most don't.
  excludeFromGit(dir, [".claude/settings.local.json"]);
}

/** Add `names` to a repo's git exclude (itself untracked) so the convoy-authored context files never show
 *  up in `git status` — convoy must not leave a repo it composes into dirty. Idempotent (skips names
 *  already listed) and best-effort: silently no-ops when `dir` isn't a git repo. NOT a tracked `.gitignore`
 *  (that would itself dirty the tree) and NOT a behavior change for a repo that legitimately tracks these
 *  files (an exclude entry for an already-tracked path is a git no-op). Uses `git rev-parse --git-path
 *  info/exclude` so it resolves the RIGHT file for any layout — a plain repo, a WORKTREE (the shared
 *  `<common>/.git/info/exclude`, which git actually reads for worktrees), or a submodule. */
function excludeFromGit(dir: string, names: string[]): void {
  if (names.length === 0) return;
  const gitPath = join(dir, ".git");
  let commonGitDir: string;
  try {
    if (statSync(gitPath).isDirectory()) {
      commonGitDir = gitPath; // a plain repo
    } else {
      // a WORKTREE: `.git` is a file (`gitdir: <path>`); git reads the exclude from the SHARED common
      // dir, NOT the per-worktree gitdir — resolve it via the gitdir's `commondir` pointer.
      const m = readFileSync(gitPath, "utf8").match(/^gitdir:\s*(.+)$/m);
      if (!m || !m[1]) return;
      const gitDir = resolve(dir, m[1].trim());
      let common = gitDir;
      try {
        common = resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim());
      } catch {
        // no commondir → the gitdir IS the common dir
      }
      commonGitDir = common;
    }
  } catch {
    return; // not a git repo — nothing to exclude
  }
  const infoDir = join(commonGitDir, "info");
  const excludePath = join(infoDir, "exclude");
  let existing = "";
  try {
    existing = readFileSync(excludePath, "utf8");
  } catch {
    // no exclude file yet — we'll create it
  }
  const lines = new Set(existing.split("\n").map((l) => l.trim()));
  const missing = names.filter((n) => !lines.has(n));
  if (missing.length === 0) return;
  const marker = "# convoy: agent context (local, not committed)";
  const block = (lines.has(marker) ? "" : `${marker}\n`) + missing.join("\n") + "\n";
  const sep = existing && !existing.endsWith("\n") ? "\n" : "";
  mkdirSync(infoDir, { recursive: true });
  writeFileSync(excludePath, `${existing}${sep}${block}`);
}

/** Install the persona + ding-bus instructions into the workspace's `.convoy/` overlay dir (moved OUT
 *  of the repo root so the product repo stays pristine), and wire their `@`-imports through a loader
 *  Claude Code auto-loads. Loader = `.claude/rules/convoy.md` (cos/Nathan decision): Claude auto-loads
 *  `.claude/rules/*.md` (empirically verified), it's a DISTINCT file so it never clobbers a repo's own
 *  `.claude/CLAUDE.md` or rules, and it `@`-imports the `.convoy/` content (path is relative to the
 *  rules file: `../../.convoy/…`). Result: the workspace ROOT has ZERO visible convoy files — only the
 *  `.claude/` + `.convoy/` dot-dirs, both git-excluded. Append-only (never clobber a user's file). */
export function writeContextFiles(dir: string, spec: AgentSpec): void {
  const convoyDir = join(dir, CONVOY_DIR);
  const imports: string[] = [];

  const persona = resolvedPersonaPath(spec);
  if (persona && existsSync(persona)) {
    mkdirSync(convoyDir, { recursive: true });
    writeFileSync(join(convoyDir, "PERSONA.md"), readFileSync(persona, "utf8"));
    imports.push(`@../../${CONVOY_DIR}/PERSONA.md`);
  }
  if (usesDing(spec)) {
    mkdirSync(convoyDir, { recursive: true });
    writeFileSync(join(convoyDir, "DING-BUS.md"), DING_BUS_MD);
    imports.push(`@../../${CONVOY_DIR}/DING-BUS.md`);
  }

  // Loader: .claude/rules/convoy.md — @imports the .convoy/ content. Append-only + no-double-load.
  const rulesFile = join(dir, ".claude", "rules", "convoy.md");
  const existing = existsSync(rulesFile) ? readFileSync(rulesFile, "utf8") : "";
  const missing = imports.filter((i) => !existing.includes(i));
  if (missing.length > 0) {
    mkdirSync(dirname(rulesFile), { recursive: true });
    const sep = existing && !existing.endsWith("\n") ? "\n" : "";
    writeFileSync(rulesFile, `${existing}${sep}${missing.join("\n")}\n`);
  }

  // Keep the whole .convoy/ overlay + the loader (a distinct file, NOT the repo's own rules) out of git.
  excludeFromGit(dir, [`${CONVOY_DIR}/`, ".claude/rules/convoy.md"]);
}

/** Write ALL of convoy's agent wiring into the repo `dir` — the persona/ding context files
 *  (PERSONA.md, DING-BUS.md, CLAUDE.local.md), the Claude Code hooks (.claude/settings.local.json),
 *  and pty.toml — each of which self-excludes itself from `git status` via .git/info/exclude so convoy
 *  never dirties a repo it composes into. Extracted from nativeLaunch so the clean-worktree guarantee
 *  is unit-testable without spawning. Composing this into a clean repo leaves `git status` empty. */
export function writeAgentFiles(dir: string, spec: AgentSpec): void {
  writeContextFiles(dir, spec);
  writeHooks(dir);
  // The spawner = whoever ran `convoy add` (their bus id, from ST_AGENT) — stamped so a crash-ding reaches
  // this agent's actual supervisor, not the whole permanent crew. Null when a human spawns it (→ cos-only ding).
  writePtyToml(dir, spec, { spawner: process.env["ST_AGENT"] ?? null });
}

/**
 * Native launch: write all wiring + spawn the agent's sessions. Replaces the `st launch --fresh`
 * shell + spawnFromPtyFile stopgap. Returns the spawned pty session names.
 */
export async function nativeLaunch(spec: AgentSpec): Promise<{ spawned: string[]; failed: string[] }> {
  const dir = spec.workingDir ?? process.cwd();
  mkdirSync(dir, { recursive: true });

  // Pre-trust the agent's repo folder so its cold-started harness never hits the workspace-trust dialog
  // (nothing clears it now that the launch command has no auto-poker). Harness-specific: claude checks
  // ~/.claude.json, codex checks ~/.codex/config.toml (its --dangerously-bypass flag does NOT skip the
  // directory-trust prompt). Best-effort — never blocks launch.
  if (spec.harness === "codex") pretrustDirsCodex([dir]);
  else pretrustDir(dir);

  // Footgun-proof: clone role personas if missing (no override).
  if (spec.personaOverride === null) {
    try {
      await ensureInstalled();
    } catch {
      // non-fatal: writeContextFiles just skips the persona import if it can't resolve
    }
  }

  writeAgentFiles(dir, spec);

  // Create the agent's bus member folder BEFORE spawning `st ding`. The ding watcher errors at startup
  // if `$ST_ROOT/<agent>/{inbox,archive}` is missing → the worker is never poked → it parks. `st launch`
  // used to create these; convoy owns that wiring now, so getting the ORDER right (folder → then ding)
  // kills the race at the source. The folder is `<net>/smalltalk/<host>.<identity>/` (ST_ROOT is the
  // smalltalk/ subdir; the agent is the host-prefixed bus id). (smalltalk's `st ding mkdir -p` is
  // defense-in-depth on top of this.)
  if (spec.networkRoot) {
    const member = join(stRootOf(spec.networkRoot), busAgentId(spec));
    mkdirSync(join(member, "inbox"), { recursive: true });
    mkdirSync(join(member, "archive"), { recursive: true });
    provisionContext(member, spec.identity);

    // Give the agent's workspace a home under the network's worktrees/ — a single view of everything the
    // network is working on. With no megarepo, that's a SYMLINK to the agent's repo. Best-effort +
    // idempotent (replace a stale link). (Megarepo worktree-cutting is a follow-up.)
    if (spec.workingDir) {
      const link = join(networkLayout(spec.networkRoot).worktrees, spec.identity);
      // Only symlink when the workspace lives ELSEWHERE (no-megarepo case). When the workspace already IS
      // the worktree (megarepo model cut it here), skip — else rmSync would delete the worktree.
      if (resolve(spec.workingDir) !== resolve(link)) {
        try {
          mkdirSync(dirname(link), { recursive: true });
          rmSync(link, { force: true });
          symlinkSync(spec.workingDir, link);
        } catch {
          // non-fatal — the visibility symlink never blocks a launch
        }
      }
    }
  }

  return spawnFromPtyFile(dir, spec.networkRoot);
}

// The ding-mode bus instructions installed into each ding agent's dir. Vendored from smalltalk's
// st-launch template (captured 2026-07-07), with the "spawn children" section updated: children are
// now added via `convoy add` (st launch is gone).
const DING_BUS_MD = `# Ding-mode bus instructions

You are connected to smalltalk via ding-mode (no MCP). Bus ops go through the \`st\` CLI. **You will
NOT receive \`<channel>\` blocks — those are MCP-only.** Inbound messages arrive as \`[DING]\` pokes in
your terminal; confirm the actual message via \`st message ls\` + \`st message read\` before acting on a new
one (each poke carries a stable \`[id:<rand6>]\` so you can dedup re-pokes at a glance — see below).

## Boot ritual (on cold start or /clear)

1. \`st status $ST_AGENT --set available\` — set your status so peers see you as active.
2. Drain your inbox backlog: \`st message ls\` to enumerate filenames, then for each: \`st message read
   <filename>\`, \`st message reply <filename> -m "<your reply>"\` if a response is warranted, and
   \`st message archive <filename>\` to clear. Don't leave inbox items unaddressed.
3. \`st agents --json --enrich\` to see who's around and whether any peers are waiting on you.

## Resume safety — do NOT double-act (important for hosted/respawned agents)

The host (\`convoy up\`) respawns you on a COLD start (no \`--resume\` yet — restart context-preservation
is coming as separate hooks work), so a restart re-runs your boot ritual from scratch. The boot re-drain
(step 2) re-surfaces every inbox item you had not archived yet. If a
drained item is one your resumed context shows you ALREADY acted on — e.g. a delegation "kick" you
already delegated — **archive it WITHOUT re-acting.** Re-reading and re-delegating an already-processed
kick is a double-delegation bug.

Rule: **archive a message the moment you act on it** (not at the end of the task), so a mid-task restart
never leaves an acted-on item to be reprocessed. On resume, for each un-archived item ask "did I already
handle this?" first — only act on genuinely new ones.

## Inbound message handling ([DING] pokes)

New peer messages surface as \`[DING] new smalltalk message: [id:<rand6>] <subject> (from <sender>); check
your inbox\` lines. The \`[id:<rand6>]\` is the message filename's rand6 suffix — it is STABLE across re-pokes
of the SAME message, so you can dedup a re-poke AT A GLANCE: if the id matches one you have already
handled, it is a duplicate poke — skip it, no \`st message ls\` needed. Dedup on the \`[id:<rand6>]\`, NEVER
the subject line: the subject text is display-only and can show stale pixels from a pane-render overlap, so
a subject-based dedup could skip a real message wearing phantom pixels. For a NEW id: \`st message ls\` to
find the filename (it contains that rand6), \`st message read <filename>\`, \`st message reply <filename> -m
"<reply>"\` if warranted (recipient + threading are derived from the message), \`st message archive
<filename>\` to clear.

## Threads stay on the bus

A thread that originated from a \`[DING]\` poke or an inbox message is conversed ONLY via \`st message
send\` / \`st message reply\` — questions, blockers, "I think I'm done" signals, all of it. Your pty REPL
is unattended; your correspondent is your interlocutor. If you would pause to ask "should I do X?", send
it via \`st message reply\` instead. Only address the REPL when a human directly typed there.

## Spawning children — use \`convoy add\` (ding is the default)

This machine is ding-only. Spawn every child agent with convoy (NOT the removed \`st launch\`):

\`\`\`sh
convoy add <role> --identity <child-id> [--permanent] [--persona <path>]
\`\`\`

\`convoy add\` is ding-by-default and writes the child its own DING-BUS.md + CLAUDE.md + hooks, so the
ding contract propagates through every level of a cos → supervisor → worker tree. Pass \`--mcp\` only if
you explicitly want MCP (you don't, on this machine). Use \`convoy up <network>\` to host the network.

## CLI inventory

Bus ops:
- \`st message send <to> [-m <body>] [--subject S] [--in-reply-to F] [--tags T,T] [--priority P]\`
- \`st message reply <filename> -m <body> [--subject S]\`
- \`st message ls [<identity>] [--archive] [--count | --json] [--from ID]\`
- \`st message read [<identity>] <filename> [--raw | --json] [--archive]\`
- \`st message archive [<identity>] <filename>\`
- \`st message thread [<identity>] <filename> [--tree]\`

Peer discovery + state:
- \`st agents [--status STATE] [--json [--enrich]]\`
- \`st status [<identity>] [--set <state>]\`

Working state (lossless-restart):
- \`st context read [<identity>] [--decisions | --full]\`
- \`st context write [<identity>]\` (reads new content from stdin)
- \`st context append [<identity>] --decision "<text>" --why "<text>"\`

Spawning children: \`convoy add <role> --identity <id> [--permanent]\` (see above).

Every command supports \`--help\`.
`;
