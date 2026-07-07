// Native launch — convoy writes ALL agent wiring itself. No `st launch` shell, no `cmdLaunch` import
// (both are being deleted). This reimplements what `st launch` wrote (captured from st 2026-07-07):
// pty.toml, the claude session command + session-id/--resume, PERSONA.md / DING-BUS.md / CLAUDE.md,
// the Claude Code hooks, and the `st ding` sidecar. smalltalk keeps ONLY: the bus (`st`), the `st ding`
// binary (spawned as a command, not imported), and the hook SCRIPTS (referenced by path).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify as tomlStringify } from "smol-toml";
import { run } from "./exec.ts";
import { spawnFromPtyFile } from "./host.ts";
import { ensureInstalled } from "./personas.ts";
import { resolvedPersonaPath, specPermanent, specPermissionMode, type AgentSpec } from "./agent-spec.ts";

const HARNESS_SESSION = "claude"; // the pty session key for the agent's main session (claude harness)

/** Where smalltalk's Claude Code hook scripts live (smalltalk keeps these; st launch is gone).
 *  SMALLTALK_DIR overrides; else the sibling `../smalltalk` repo (github.com/myobie layout). */
function smalltalkDir(): string {
  const env = process.env["SMALLTALK_DIR"];
  if (env && existsSync(env)) return env;
  const convoyRoot = dirname(dirname(fileURLToPath(import.meta.url))); // src/launch.ts → src → repo root
  return join(convoyRoot, "..", "smalltalk");
}

/** Resolve + validate the hook scripts + the st binary the hooks invoke. Throws loud if missing. */
function hookRefs(): { stBin: string; sessionStart: string; preCompact: string; stopFailure: string } {
  const root = smalltalkDir();
  const hooks = join(root, "examples", "claude-code", "hooks");
  const stBin = join(root, "bin", "st");
  const refs = {
    stBin,
    sessionStart: join(hooks, "session-start.sh"),
    preCompact: join(hooks, "pre-compact.sh"),
    stopFailure: join(hooks, "stop-failure.sh"),
  };
  if (!existsSync(refs.sessionStart)) {
    throw new Error(`smalltalk hook scripts not found at ${hooks} — set SMALLTALK_DIR to the smalltalk repo`);
  }
  return refs;
}

/** The agent's pinned Claude session id. Existing `.claude-session-id` → resume its (rich) jsonl.
 *  New → mint a UUID, write it, and SEED the jsonl with a non-interactive `claude --print`
 *  (a PROMPT arg + closed stdin, so it does NOT hang like st launch's promptless bootstrap). Either
 *  way the launch command uses `--resume <sid>`, so first-run and every respawn resume the same id. */
export async function ensureSessionId(dir: string): Promise<string> {
  const path = join(dir, ".claude-session-id");
  if (existsSync(path)) {
    const sid = readFileSync(path, "utf8").trim();
    if (sid) return sid; // migrating/returning agent — its jsonl already exists
  }
  const sid = randomUUID();
  writeFileSync(path, sid);
  // Seed the jsonl so `--resume <sid>` resolves on first run. `--print` + a prompt + closed stdin =
  // non-interactive, no hang. Best-effort: if the seed fails, `--resume` still creates on first run.
  await run("claude", ["--print", "--session-id", sid, "reply with exactly: ready"], { cwd: dir, input: "" });
  return sid;
}

/** The agent's main claude session command: the unattended auto-poker that dismisses claude's
 *  first-launch TUI gates (workspace-trust / dev-channels / resume dialog), then `exec claude`. */
export function claudeCommand(displayName: string, permissionMode: string, sid: string): string {
  const poke = Array.from({ length: 4 }, () => `sleep 4 && pty send ${displayName} --seq key:return`).join("; ");
  return `(${poke}) & exec claude --permission-mode ${permissionMode} --resume ${sid}`;
}

/** The ding sidecar command — the inbox notifier. `st ding` stays a smalltalk runtime binary. */
export function dingCommand(agent: string, displayName: string): string {
  return `st ding ${displayName} --identity ${agent}`;
}

/** Serialize the per-agent pty.toml (pty's manifest format — NOT a convoy.toml). */
function writePtyToml(dir: string, spec: AgentSpec, sid: string): void {
  const agent = spec.identity;
  const root = spec.networkRoot;
  const displayName = `${agent}-${HARNESS_SESSION}`;
  const permanent = specPermanent(spec);
  const stTag = root ? { "st.network": root } : {};
  const env: Record<string, string> = { ST_AGENT: agent };
  if (root) {
    env["ST_ROOT"] = root;
    env["PTY_ROOT"] = `${root}/pty`;
  }
  const doc: Record<string, unknown> = {
    prefix: agent,
    sessions: {
      [HARNESS_SESSION]: {
        command: claudeCommand(displayName, specPermissionMode(spec), sid),
        tags: { role: "agent", ...(permanent ? { strategy: "permanent" } : {}), ...stTag },
        env,
      },
      ...(spec.transport === "ding"
        ? {
            ding: {
              command: dingCommand(agent, displayName),
              tags: { role: "ding", ...(permanent ? { strategy: "permanent" } : {}), ...stTag },
              env,
            },
          }
        : {}),
    },
  };
  writeFileSync(join(dir, "pty.toml"), tomlStringify(doc));
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
}

/** Install the persona (copy the resolved base) + the ding-bus instructions, and wire CLAUDE.md
 *  `@`-imports for both. Never clobber a pre-existing CLAUDE.md — only append missing import lines. */
function writeContextFiles(dir: string, spec: AgentSpec): void {
  const imports: string[] = [];

  const persona = resolvedPersonaPath(spec);
  if (persona && existsSync(persona)) {
    writeFileSync(join(dir, "PERSONA.md"), readFileSync(persona, "utf8"));
    imports.push("@PERSONA.md");
  }
  if (spec.transport === "ding") {
    writeFileSync(join(dir, "DING-BUS.md"), DING_BUS_MD);
    imports.push("@DING-BUS.md");
  }

  const claudeMd = join(dir, "CLAUDE.md");
  const existing = existsSync(claudeMd) ? readFileSync(claudeMd, "utf8") : "";
  const missing = imports.filter((i) => !existing.includes(i));
  if (missing.length > 0) {
    const sep = existing && !existing.endsWith("\n") ? "\n" : "";
    writeFileSync(claudeMd, `${existing}${sep}${missing.join("\n")}\n`);
  }
}

/**
 * Native launch: write all wiring + spawn the agent's sessions. Replaces the `st launch --fresh`
 * shell + spawnFromPtyFile stopgap. Returns the spawned pty session names.
 */
export async function nativeLaunch(spec: AgentSpec): Promise<{ spawned: string[]; failed: string[] }> {
  const dir = spec.workingDir ?? process.cwd();
  mkdirSync(dir, { recursive: true });

  // Footgun-proof: clone role personas if missing (no override).
  if (spec.personaOverride === null) {
    try {
      await ensureInstalled();
    } catch {
      // non-fatal: writeContextFiles just skips the persona import if it can't resolve
    }
  }

  const sid = await ensureSessionId(dir);
  writeContextFiles(dir, spec);
  writeHooks(dir);
  writePtyToml(dir, spec, sid);
  return spawnFromPtyFile(dir, spec.networkRoot);
}

// The ding-mode bus instructions installed into each ding agent's dir. Vendored from smalltalk's
// st-launch template (captured 2026-07-07), with the "spawn children" section updated: children are
// now added via `convoy add` (st launch is gone).
const DING_BUS_MD = `# Ding-mode bus instructions

You are connected to smalltalk via ding-mode (no MCP). Bus ops go through the \`st\` CLI. **You will
NOT receive \`<channel>\` blocks — those are MCP-only.** Inbound messages arrive as \`[DING]\` pokes in
your terminal; always confirm the actual message via \`st message ls\` + \`st message read\` before acting.

## Boot ritual (on cold start or /clear)

1. \`st status $ST_AGENT --set available\` — set your status so peers see you as active.
2. Drain your inbox backlog: \`st message ls\` to enumerate filenames, then for each: \`st message read
   <filename>\`, \`st message reply <filename> -m "<your reply>"\` if a response is warranted, and
   \`st message archive <filename>\` to clear. Don't leave inbox items unaddressed.
3. \`st agents --json --enrich\` to see who's around and whether any peers are waiting on you.

## Resume safety — do NOT double-act (important for hosted/respawned agents)

The host (\`convoy up\`) respawns you with \`--resume <sid>\`, so on a restart you come back with your
PRIOR context. But the boot re-drain (step 2) re-surfaces every inbox item you had not archived yet. If a
drained item is one your resumed context shows you ALREADY acted on — e.g. a delegation "kick" you
already delegated — **archive it WITHOUT re-acting.** Re-reading and re-delegating an already-processed
kick is a double-delegation bug.

Rule: **archive a message the moment you act on it** (not at the end of the task), so a mid-task restart
never leaves an acted-on item to be reprocessed. On resume, for each un-archived item ask "did I already
handle this?" first — only act on genuinely new ones.

## Inbound message handling ([DING] pokes)

New peer messages surface as \`[DING] new smalltalk message: <subject> (from <sender>)\` lines. For each:
\`st message ls\` to find the filename, \`st message read <filename>\`, \`st message reply <filename> -m
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
