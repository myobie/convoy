// The AGENT FILE — an agent's declarative intent (a Nomad-style job spec), the source of truth for the
// declarative-convoy arc. It lives in the SYNCED catalog at `<net>/catalog/<identity>.toml` and is the
// single input three verbs compile: `convoy render` (→ the worktree overlay, this PR), `convoy add` (which
// WRITES the file instead of launching — piece 2), and `convoy up` (which reconciles the catalog — piece 3).
// It is a HIGHER-LEVEL intent than `.convoy/pty.toml` (the launch artifact): `host`/`workspace` are
// first-class here, and render compiles it DOWN to the overlay. Deliberately NOT the reverse-engineered
// pty.toml (that would be a backwards-compat shim — rejected per "aim for the moon, clean cut").

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stringify as tomlStringify } from "smol-toml";
import { parseRole, type Role } from "./role.ts";
import { isValidModel, type AgentSpec, type Harness, type Transport } from "./agent-spec.ts";
import { identityErrors, type IdentityContext } from "./identity.ts";
import { asArray, decodeSpecText, formatOfPath, type SpecDoc, type SpecFormat } from "./spec-format.ts";

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
  /** Per-agent model id (`claude --model <id>` / `codex --model <id>`). Omit → the harness default (today's
   *  behavior). Free-form (model ids churn) but charset-validated on parse — it lands in the launch command. */
  model?: string;
  /** ding | mcp. Omit → ding. */
  transport?: Transport;
  /** Optional persona override (a path). Omit → the role's default persona. */
  persona?: string;
  /** Optional supervision strategy — "permanent" (respawned by `convoy up`, piece 3). Omit → derive from role. */
  strategy?: "permanent";
  /** Lifecycle marker: `retired = true` DECOMMISSIONS the agent. Because the catalog is synced by `fabric sync`
   *  under the UNION / no-delete "catalog" policy (a local `rm` just re-propagates from a peer), removal is an
   *  EDIT, not a file delete — `convoy remove` sets retired=true and the sync carries it (newer-wins) everywhere;
   *  `convoy up` reconcile then tears the agent down + does NOT launch it. A SEPARATE axis from `strategy`
   *  (respawn behavior) so "a retired permanent" is expressible + reconcile reads two orthogonal signals.
   *  Forward-compat here (parsed + serialized); honored by reconcile. The catalog's cross-machine removal
   *  semantics ARE fabric's "catalog" policy (no-delete/no-sweep/no-tombstones) — see src/fabric-sync.ts. */
  retired?: boolean;
  /** Forward-compat: crash-ding tier. v1 derives it from role (chief-of-staff → cos); carried for piece 2/3. */
  tier?: string;
  /** Extra harness env, merged into every DERIVED pty session's env (derived keys win, so `env` cannot
   *  break `ST_AGENT`/`ST_ROOT` wiring). This is where CREDENTIAL SELECTION rides: `CLAUDE_CONFIG_DIR` /
   *  `CODEX_HOME`, written `$HOME`-relative so one spec is machine-agnostic. There is deliberately no
   *  `account` field — an account IS a config dir, and naming it twice invites the two to disagree. */
  env?: Record<string, string>;

  /** The agent this one reports to. Required by the spec except at `role = chief-of-staff` (spec: `root`).
   *  Carried and validated for shape; reconcile does not yet build the supervision tree from it. */
  supervisor?: string;
  /** The pty session-id prefix (`<prefix>.<agentShort>`). Omit → the host. */
  prefix?: string;
  /** The command run IN PLACE OF the bare harness name when convoy derives the launch command.
   *  Deployments wrap their harness — credential selection, persona projection, policy gates, telemetry —
   *  and a convoy-managed session that execs `claude` directly runs OUTSIDE the boundary every other
   *  session in that deployment runs inside. It also sidesteps the closed `Harness` union: a deployment
   *  running a third harness sets `bin` and keeps `harness` as the nearest CLI-compatible flavor. */
  bin?: string;
  /** Explicit pty tasks. "The agent is the job, and its ptys are the tasks": when absent, convoy DERIVES
   *  the tasks from the agent-level intent (the correct-by-construction path, AC-1). When present, these
   *  blocks are carried verbatim — the escape hatch for a session convoy has no opinion about. */
  pty?: Record<string, PtyBlock>;
  /** Extra files to materialize into the workspace at render time. */
  render?: RenderBlock;
}

/** One pty task (spec: the "PTY (Task) Level Fields"). */
export interface PtyBlock {
  /** On-disk session id. Omit → convoy derives it from the prefix + identity. */
  id?: string;
  command?: string;
  cwd?: string;
  tags?: Record<string, string>;
  env?: Record<string, string>;
  /** Exempt this session from garbage collection. */
  keep?: boolean;
}

/** `render` — extra files materialized into the workspace, so a deployment can ship skills/hooks
 *  alongside an agent without patching convoy. Sources are relative to the SPEC FILE, destinations to
 *  the workspace. */
export interface RenderBlock {
  file?: { dest: string; from: string; mode?: string }[];
  dir?: { dest: string; from: string }[];
}

/** The catalog dir for a network — `<net>/catalog/`. SYNCED across machines by `fabric sync` (convoy declares
 *  it — see src/fabric-sync.ts), distinct from the smalltalk bus at `<net>/smalltalk/` (fabric syncs the
 *  catalog; smalltalk syncs the bus) and the machine-local `<net>/pty/`; it's the cross-machine scheduler in
 *  the declarative model. */
export function catalogDir(networkDir: string): string {
  return join(networkDir, "catalog");
}

/** The agent file path for an identity in a catalog dir — `<catalog>/<identity>.toml`. */
export function agentFilePath(catalog: string, identity: string): string {
  return join(catalog, `${identity}.toml`);
}

/** Does this document CLAIM to be an agent spec? The spec says discovery processes "files containing
 *  `identity` and `role` fields", but requiring both to even be RECOGNISED means a spec that misspells or
 *  omits one is silently not an agent — the file sits in the catalog looking declared while nothing runs,
 *  with no error anywhere. So recognition is EITHER field (a claim) and completeness is a validation
 *  error (see parseAgentFile). A file with neither field is genuinely not a spec and is skipped. */
export function looksLikeAgentSpec(doc: SpecDoc): boolean {
  return typeof doc["identity"] === "string" || typeof doc["role"] === "string";
}

/** Is this a COMPLETE agent spec — both required fields present? */
export function isAgentSpecDoc(doc: SpecDoc): boolean {
  return typeof doc["identity"] === "string" && typeof doc["role"] === "string";
}

/** Parse + VALIDATE agent spec text into an AgentFile. `format` selects only the DECODER; every field
 *  rule below runs identically for KDL, TOML, and JSON, which is what makes the three interchangeable.
 *  Throws on a missing/invalid required field (identity, role) or a bad enum. Pure.
 *
 *  `idContext` enables the DECLARE-TIME identity check. It is optional because parsing must still work
 *  without a network in hand (`--dry-run`, tests), but `convoy add` and discovery both supply it. */
export function parseAgentFile(text: string, format: SpecFormat = "toml", idContext?: IdentityContext): AgentFile {
  const doc = decodeSpecText(text, format);
  const str = (k: string): string | undefined => (typeof doc[k] === "string" ? (doc[k] as string) : undefined);

  const identity = str("identity");
  if (!identity) throw new Error("missing required `identity`");
  // Validate the identity HERE, in the one place every declaration path funnels through, rather than in
  // each caller — an invalid name that reaches the synced catalog has already propagated to every peer.
  const idErrors = identityErrors(identity, idContext ?? {});
  if (idErrors.length > 0) throw new Error(idErrors.join("; "));
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
  const modelRaw = str("model");
  if (modelRaw !== undefined && !isValidModel(modelRaw)) throw new Error(`invalid \`model\` "${modelRaw}" — use letters, digits, and . _ : / - (start alphanumeric), e.g. claude-fable-5`);

  const af: AgentFile = { identity, role };
  const host = str("host");
  // LOWERCASE the host on read: `convoy up`'s host-filter compares against `shortHostname()` (lowercased), and
  // the bus id / bus folder are `<host>.<identity>` (lowercased). A hand-authored capitalized host (e.g. from
  // `hostname -s` → "Silber") would otherwise SILENTLY never match this machine → the agent never launches, no
  // error. Normalizing here keeps host-filter + bus-id + bus-folder consistent for hand-authored files too.
  if (host) af.host = host.toLowerCase();
  const workspace = str("workspace");
  if (workspace) af.workspace = workspace;
  if (harnessRaw) af.harness = harnessRaw as Harness;
  if (modelRaw) af.model = modelRaw;
  if (transportRaw) af.transport = transportRaw as Transport;
  const persona = str("persona");
  if (persona) af.persona = persona;
  if (strategyRaw) af.strategy = "permanent";
  const tier = str("tier");
  if (tier) af.tier = tier;
  if (doc["retired"] === true) af.retired = true;
  if (doc["env"] && typeof doc["env"] === "object") af.env = doc["env"] as Record<string, string>;

  const supervisor = str("supervisor");
  if (supervisor) {
    // A supervisor is an identity too — a typo'd one silently orphans the agent from its escalation path.
    const supErrors = identityErrors(supervisor);
    if (supErrors.length > 0) throw new Error(`invalid \`supervisor\`: ${supErrors.join("; ")}`);
    af.supervisor = supervisor;
  } else if (role !== "chief-of-staff") {
    // The spec requires `supervisor` except at the root. Convoy WARNS rather than throws (see
    // catalog.ts): existing catalogs predate the field, and refusing to parse them would strand every
    // already-declared agent at the exact moment this lands.
  }
  const prefix = str("prefix");
  if (prefix) af.prefix = prefix.toLowerCase();
  const bin = str("bin");
  if (bin !== undefined) {
    if (!isValidBin(bin)) throw new Error(`invalid \`bin\` "${bin}" — it is interpolated into the launch command, so it must be a plain path or command name (letters, digits, and . _ / - ), with no spaces, quotes, or shell metacharacters`);
    af.bin = bin;
  }

  // The spec's JSON example says `ptys` where its TOML and KDL examples say `pty`. Both are accepted
  // rather than guessing which is normative; see the spec-divergence note in .decisions/0007.
  const ptyRaw = doc["pty"] ?? doc["ptys"];
  if (ptyRaw && typeof ptyRaw === "object" && !Array.isArray(ptyRaw)) {
    const blocks: Record<string, PtyBlock> = {};
    for (const [key, v] of Object.entries(ptyRaw as Record<string, unknown>)) {
      if (!v || typeof v !== "object" || Array.isArray(v)) continue;
      const b = v as Record<string, unknown>;
      const block: PtyBlock = {};
      if (typeof b["id"] === "string") block.id = b["id"];
      if (typeof b["command"] === "string") block.command = b["command"];
      if (typeof b["cwd"] === "string") block.cwd = b["cwd"];
      if (b["tags"] && typeof b["tags"] === "object") block.tags = b["tags"] as Record<string, string>;
      if (b["env"] && typeof b["env"] === "object") block.env = b["env"] as Record<string, string>;
      if (b["keep"] === true) block.keep = true;
      blocks[key] = block;
    }
    if (Object.keys(blocks).length > 0) af.pty = blocks;
  }

  const renderRaw = doc["render"];
  if (renderRaw && typeof renderRaw === "object") {
    const r = renderRaw as Record<string, unknown>;
    const files = asArray(r["file"])
      .filter((f) => typeof f["dest"] === "string" && typeof f["from"] === "string")
      .map((f) => ({ dest: f["dest"] as string, from: f["from"] as string, ...(typeof f["mode"] === "string" ? { mode: f["mode"] as string } : {}) }));
    const dirs = asArray(r["dir"])
      .filter((d) => typeof d["dest"] === "string" && typeof d["from"] === "string")
      .map((d) => ({ dest: d["dest"] as string, from: d["from"] as string }));
    const block: RenderBlock = {};
    if (files.length > 0) block.file = files;
    if (dirs.length > 0) block.dir = dirs;
    if (files.length > 0 || dirs.length > 0) af.render = block;
  }
  return af;
}

/** A shell-safe `bin`: it lands verbatim in the `sh -c` launch command, so it must not be able to break
 *  out of it. Deliberately narrower than "any string" and wider than a bare name (a wrapper usually lives
 *  at an absolute path). Arguments belong in the harness's own flags, not smuggled through `bin`. */
export function isValidBin(bin: string): boolean {
  return /^[A-Za-z0-9._/-]+$/.test(bin) && bin.length > 0;
}

/** Serialize an AgentFile to TOML text. Only SET fields are emitted, so the file stays minimal +
 *  human-diffable — this is the declarative artifact `convoy add` authors (piece 2). Order matches the
 *  sample for readability. Pure (used for `--dry-run` preview + the writer). */
export function agentFileToToml(af: AgentFile): string {
  const doc: Record<string, unknown> = { identity: af.identity, role: af.role };
  if (af.supervisor) doc["supervisor"] = af.supervisor;
  if (af.host) doc["host"] = af.host;
  if (af.workspace) doc["workspace"] = af.workspace;
  if (af.harness) doc["harness"] = af.harness;
  if (af.bin) doc["bin"] = af.bin;
  if (af.prefix) doc["prefix"] = af.prefix;
  if (af.model) doc["model"] = af.model;
  if (af.transport) doc["transport"] = af.transport;
  if (af.persona) doc["persona"] = af.persona;
  if (af.strategy) doc["strategy"] = af.strategy;
  if (af.tier) doc["tier"] = af.tier;
  if (af.retired) doc["retired"] = true;
  if (af.env && Object.keys(af.env).length > 0) doc["env"] = af.env;
  if (af.render) doc["render"] = af.render;
  // `pty` last: TOML tables must follow every top-level scalar, or the scalars land inside the table.
  if (af.pty && Object.keys(af.pty).length > 0) doc["pty"] = af.pty;
  return tomlStringify(doc);
}

/** Write an AgentFile as TOML to `path` (creating the catalog dir). */
export function writeAgentFile(path: string, af: AgentFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, agentFileToToml(af));
}

/** Read + parse the agent file at `path`, choosing the decoder from its EXTENSION. Throws (with the path)
 *  on read/parse/validation failure. */
export function readAgentFile(path: string, idContext?: IdentityContext): AgentFile {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`cannot read agent file ${path}`);
  }
  const format = formatOfPath(path);
  if (format === null) throw new Error(`not an agent spec file: ${path} (expected .kdl, .toml, or .json)`);
  try {
    return parseAgentFile(text, format, idContext);
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
    prefix: af.prefix ?? af.host ?? null,
    // CLAUDE_CONFIG_DIR is CREDENTIAL SELECTION, and credentials ride in `env` — there is no separate
    // `account` field to fall out of sync with it. Read it back out of `env` so the derived pty.toml and
    // the spec agree by construction.
    configDir: af.env?.["CLAUDE_CONFIG_DIR"] ?? null,
    model: af.model ?? null,
    bin: af.bin ?? null,
    env: af.env ?? null,
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
# model = "claude-fable-5"             # optional — per-agent model (claude/codex --model); omit → harness default
# persona = "/abs/path/to/persona.md"  # optional — omit to use the role's default persona
# strategy = "permanent"               # optional — respawned by convoy up (piece 3); omit → derive from role
`;
