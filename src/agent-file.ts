// The AGENT FILE — an agent's declarative intent (a Nomad-style job spec), the source of truth for the
// declarative-convoy arc. It lives in the SYNCED catalog at `<net>/catalog/<identity>.toml` and is the
// single input three verbs compile: `convoy render` (→ the worktree overlay, this PR), `convoy add` (which
// WRITES the file instead of launching — piece 2), and `convoy up` (which reconciles the catalog — piece 3).
// It is a HIGHER-LEVEL intent than `.convoy/pty.toml` (the launch artifact): `host`/`workspace` are
// first-class here, and render compiles it DOWN to the overlay. Deliberately NOT the reverse-engineered
// pty.toml (that would be a backwards-compat shim — rejected per "aim for the moon, clean cut").

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as tomlParse, stringify as tomlStringify } from "smol-toml";
import { parseRole, type Role } from "./role.ts";
import type { AgentSpec, Harness, Transport } from "./agent-spec.ts";

/** The declarative intent for one agent. A clean SUBSET of what render+add+up will need — extend, don't
 *  reshape (piece 2 = `convoy add` authors these; piece 3 = `convoy up` host-filters + launches). */
export interface AgentFile {
  /** The agent's logical id (matches the catalog filename stem). Required. */
  identity: string;
  /** chief-of-staff | supervisor | worker | technical-manager. Required (drives persona, tier, permanence). */
  role: Role;
  /** Which MACHINE runs it — the `<host>` in the host-prefixed bus id `<host>.<identity>`. Omit → this
   *  machine's short hostname. This is the field `convoy up` host-filters on (piece 3). */
  host?: string;
  /** The repo/worktree the agent runs in — where render materializes the overlay. `--dir` overrides it. */
  workspace?: string;
  /** claude | codex. Omit → claude. */
  harness?: Harness;
  /** ding | mcp. Omit → ding. */
  transport?: Transport;
  /** Optional persona override (a path). Omit → the role's default persona. */
  persona?: string;
  /** Optional supervision strategy — "permanent" (respawned by `convoy up`, piece 3). Omit → derive from role. */
  strategy?: "permanent";
  /** Forward-compat: crash-ding tier. v1 derives it from role (chief-of-staff → cos); carried for piece 2/3. */
  tier?: string;
  /** Forward-compat: extra harness env. Carried in the schema; v1 render does NOT yet inject it into pty.toml. */
  env?: Record<string, string>;
}

/** The catalog dir for a network — `<net>/catalog/`. SYNCED across machines (like `<net>/smalltalk/`,
 *  parallel to the machine-local `<net>/pty/`); it's the cross-machine scheduler in the declarative model. */
export function catalogDir(networkDir: string): string {
  return join(networkDir, "catalog");
}

/** The agent file path for an identity in a catalog dir — `<catalog>/<identity>.toml`. */
export function agentFilePath(catalog: string, identity: string): string {
  return join(catalog, `${identity}.toml`);
}

/** Parse + VALIDATE an agent file's TOML text into an AgentFile. Throws on a missing/invalid required field
 *  (identity, role) or a bad enum (harness/transport/strategy) — render surfaces the message. Pure. */
export function parseAgentFile(text: string): AgentFile {
  const doc = tomlParse(text) as Record<string, unknown>;
  const str = (k: string): string | undefined => (typeof doc[k] === "string" ? (doc[k] as string) : undefined);

  const identity = str("identity");
  if (!identity) throw new Error("missing required `identity`");
  const roleRaw = str("role");
  if (!roleRaw) throw new Error("missing required `role`");
  const role = parseRole(roleRaw);
  if (!role) throw new Error(`invalid \`role\` "${roleRaw}" (want: chief-of-staff | supervisor | worker | technical-manager)`);

  const harnessRaw = str("harness");
  if (harnessRaw !== undefined && harnessRaw !== "claude" && harnessRaw !== "codex") throw new Error(`invalid \`harness\` "${harnessRaw}" (want: claude | codex)`);
  const transportRaw = str("transport");
  if (transportRaw !== undefined && transportRaw !== "ding" && transportRaw !== "mcp") throw new Error(`invalid \`transport\` "${transportRaw}" (want: ding | mcp)`);
  const strategyRaw = str("strategy");
  if (strategyRaw !== undefined && strategyRaw !== "permanent") throw new Error(`invalid \`strategy\` "${strategyRaw}" (want: permanent, or omit)`);

  const af: AgentFile = { identity, role };
  const host = str("host");
  if (host) af.host = host;
  const workspace = str("workspace");
  if (workspace) af.workspace = workspace;
  if (harnessRaw) af.harness = harnessRaw as Harness;
  if (transportRaw) af.transport = transportRaw as Transport;
  const persona = str("persona");
  if (persona) af.persona = persona;
  if (strategyRaw) af.strategy = "permanent";
  const tier = str("tier");
  if (tier) af.tier = tier;
  if (doc["env"] && typeof doc["env"] === "object") af.env = doc["env"] as Record<string, string>;
  return af;
}

/** Serialize an AgentFile to TOML text. Only SET fields are emitted, so the file stays minimal +
 *  human-diffable — this is the declarative artifact `convoy add` authors (piece 2). Order matches the
 *  sample for readability. Pure (used for `--dry-run` preview + the writer). */
export function agentFileToToml(af: AgentFile): string {
  const doc: Record<string, unknown> = { identity: af.identity, role: af.role };
  if (af.host) doc["host"] = af.host;
  if (af.workspace) doc["workspace"] = af.workspace;
  if (af.harness) doc["harness"] = af.harness;
  if (af.transport) doc["transport"] = af.transport;
  if (af.persona) doc["persona"] = af.persona;
  if (af.strategy) doc["strategy"] = af.strategy;
  if (af.tier) doc["tier"] = af.tier;
  if (af.env && Object.keys(af.env).length > 0) doc["env"] = af.env;
  return tomlStringify(doc);
}

/** Write an AgentFile as TOML to `path` (creating the catalog dir). */
export function writeAgentFile(path: string, af: AgentFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, agentFileToToml(af));
}

/** Read + parse the agent file at `path`. Throws (with the path) on read/parse/validation failure. */
export function readAgentFile(path: string): AgentFile {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`cannot read agent file ${path}`);
  }
  try {
    return parseAgentFile(text);
  } catch (e) {
    throw new Error(`invalid agent file ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Compile an AgentFile (+ its network + an optional workspace override) DOWN to the AgentSpec that the
 *  overlay writers consume. This is render's core mapping. Defaults: harness=claude, transport=ding; host →
 *  the host-prefix (null → this machine's short hostname); strategy=permanent → permanentOverride. `tier`
 *  is derived from role by the writers (v1), and `env` is not yet materialized — both carried forward-compat. */
export function agentFileToSpec(af: AgentFile, opts: { networkRoot: string | null; workspace?: string | undefined }): AgentSpec {
  return {
    harness: af.harness ?? "claude",
    role: af.role,
    identity: af.identity,
    transport: af.transport ?? "ding",
    networkRoot: opts.networkRoot,
    personaOverride: af.persona ?? null,
    workingDir: opts.workspace ?? af.workspace ?? null,
    permanentOverride: af.strategy === "permanent" ? true : null,
    prefix: af.host ?? null,
    configDir: null,
  };
}

/** A commented SAMPLE agent file — shown in `convoy render --help` + written to a new catalog so a user can
 *  hand-author one before `convoy add` generates them (piece 2). The minimal fields render+up need. */
export const SAMPLE_AGENT_TOML = `# An agent file — declarative intent. Lives at <net>/catalog/<identity>.toml (SYNCED across machines).
# convoy render <identity> compiles this into the worktree overlay; convoy add will author it (piece 2);
# convoy up reconciles the catalog + launches this host's agents (piece 3).

identity  = "my-agent"          # required — the logical id (matches the filename stem)
role      = "worker"            # required — chief-of-staff | supervisor | worker | technical-manager
host      = "my-hostname"       # which machine runs it (the <host> in <host>.<identity>); omit → this machine
workspace = "/abs/path/to/repo" # the repo/worktree to run in (where render materializes the overlay)
harness   = "claude"            # claude | codex   (default: claude)
transport = "ding"              # ding | mcp       (default: ding)
# persona = "/abs/path/to/persona.md"  # optional — omit to use the role's default persona
# strategy = "permanent"               # optional — respawned by convoy up (piece 3); omit → derive from role
`;
