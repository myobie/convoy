// `convoy rename <old> <new>` — move an agent's NAME without orphaning what it externalized.
//
// Rename is load-bearing rather than convenient. Once identity is a declared, meaningful name that
// durable context hangs off, choosing one has a cost — and that cost is only acceptable if a wrong
// choice is cheaply correctable. Without a rename that preserves continuity, the only way to fix a name
// is to abandon everything the agent wrote under the old one, which in practice means nobody renames and
// bad names calcify.
//
// So rename moves BOTH sides:
//   - the catalog entry  (desired state — what should run)
//   - the whole bus folder (durable state — context/, context/decisions/, archive/, inbox/, status)
//
// Moving the bus folder wholesale is what makes in-flight mail survive: messages sitting in `inbox/` at
// rename time travel with the folder and are delivered under the new name. They need no special handling
// precisely BECAUSE the move is a move and not a re-creation.
//
// THE TOMBSTONE, HONESTLY. Convoy leaves a marker at the old identity so a stale reference resolves to
// something rather than nothing. It is read by CONVOY — `ls`, uniqueness at declare time, and rename's
// own idempotency. It is NOT read by smalltalk: smalltalk has no redirect/alias mechanism at all, and
// its send path validates the name and then unconditionally `mkdir -p`s the inbox. So a peer that still
// holds the OLD name and sends to it after the rename does not fail and does not redirect — it
// manufactures a fresh folder that nobody reads. Convoy cannot close that from its side; the tombstone
// makes the situation DIAGNOSABLE (and `convoy ls` surfaces it) rather than invisible. Closing it
// properly needs redirect resolution in smalltalk.
//
// The tombstone is deliberately a bare marker file with NO `inbox/`, `archive/`, or `status` beside it,
// because `st agents` lists a folder only when one of those exists. A tombstone that carried them would
// resurrect the old name in every agent listing on the network.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readCatalog } from "./catalog.ts";
import { agentFileToToml, catalogDir, readAgentFile, writeAgentFile } from "./agent-file.ts";
import { identityErrors } from "./identity.ts";
import { networkLayout, stRootOf } from "./paths.ts";
import { shortHostname } from "./agent-spec.ts";

/** The marker convoy leaves at a renamed-away bus folder. Named with a leading dot so smalltalk's folder
 *  scan (which skips dotfiles) cannot mistake it for agent content. */
export const TOMBSTONE_FILE = ".convoy-renamed-to";

export interface RenamePlan {
  from: string;
  to: string;
  /** Catalog file being rewritten, or null when the agent is declared only implicitly. */
  catalogFrom: string | null;
  catalogTo: string | null;
  /** Bus folders (`<host>.<identity>`), or null when the agent has no bus presence yet. */
  busFrom: string | null;
  busTo: string | null;
  /** Human-readable notes: what will move, and what rename cannot guarantee. */
  notes: string[];
}

export interface RenameResult {
  plan: RenamePlan;
  errors: string[];
  /** True when the work was already done (re-running a partially-failed rename is safe). */
  alreadyDone: boolean;
}

/** Read the tombstone at a bus folder, or null when it isn't one. */
export function tombstoneTarget(busDir: string): string | null {
  try {
    const t = readFileSync(join(busDir, TOMBSTONE_FILE), "utf8").trim();
    return t || null;
  } catch {
    return null;
  }
}

/** Follow tombstones from an identity to the name it now lives under. Bounded so a tombstone cycle (two
 *  renames that crossed) terminates instead of hanging a reconcile. */
export function resolveIdentity(networkDir: string, identity: string, host?: string): string {
  const stRoot = stRootOf(networkDir);
  const h = host ?? shortHostname();
  let current = identity;
  for (let i = 0; i < 8; i++) {
    const next = tombstoneTarget(join(stRoot, `${h}.${current}`));
    if (next === null || next === current) return current;
    current = next;
  }
  return current;
}

/** Compute what a rename would do, without doing it. */
export function planRename(networkDir: string, from: string, to: string, opts?: { host?: string }): RenameResult {
  const errors: string[] = [];
  const notes: string[] = [];
  const layout = networkLayout(networkDir);
  const catalog = catalogDir(networkDir);
  const { entries } = readCatalog(networkDir);

  const entry = entries.find((e) => e.af.identity === from);
  const host = (opts?.host ?? entry?.af.host ?? shortHostname()).toLowerCase();

  // The NEW name must be declarable on this network — same grammar, same socket budget, same uniqueness.
  const idErrors = identityErrors(to, {
    ptyRoot: layout.ptyRoot,
    prefix: host,
    existing: entries.map((e) => e.af.identity).filter((d) => d !== from),
  });
  errors.push(...idErrors);
  if (from === to) errors.push(`"${from}" and "${to}" are the same identity`);

  const stRoot = stRootOf(networkDir);
  // The bus folder is the HOST-PREFIXED id, not the bare identity — renaming the bare name would move
  // nothing and report success.
  const busFrom = join(stRoot, `${host}.${from}`);
  const busTo = join(stRoot, `${host}.${to}`);
  const hasBusFrom = existsSync(busFrom) && tombstoneTarget(busFrom) === null;
  const hasBusTo = existsSync(busTo);

  const catalogFrom = entry?.path ?? null;
  // Convoy serializes TOML only, so a KDL/JSON spec is rewritten in place only if it is TOML.
  const catalogTo = catalogFrom !== null && catalogFrom.endsWith(".toml") ? join(catalog, `${to}.toml`) : catalogFrom;

  if (entry === undefined) {
    errors.push(`no agent "${from}" is declared on this network (\`convoy ls\` shows what is)`);
  } else if (catalogFrom !== null && !catalogFrom.endsWith(".toml")) {
    errors.push(`agent "${from}" is declared in ${catalogFrom}, which convoy reads but does not write — edit its \`identity\` by hand, then re-run to move the bus folder`);
  }

  if (hasBusTo && !hasBusFrom) {
    notes.push(`bus folder ${host}.${to} already exists and ${host}.${from} does not — treating the bus move as already done`);
  } else if (hasBusTo && hasBusFrom) {
    errors.push(`both bus folders exist (${host}.${from} and ${host}.${to}) — refusing to merge two agents' durable state; move or remove one by hand`);
  }
  if (hasBusFrom) notes.push(`move bus folder ${host}.${from} → ${host}.${to} (context/, context/decisions/, archive/, inbox/, status travel with it)`);
  else if (!hasBusTo) notes.push(`no bus folder for ${host}.${from} yet — nothing durable to move`);

  notes.push(
    `a tombstone stays at ${host}.${from} so convoy resolves stale references; note that smalltalk has no ` +
      `redirect, so a peer still holding "${from}" that sends AFTER this rename creates an unread folder rather than failing`,
  );

  const plan: RenamePlan = { from, to, catalogFrom, catalogTo, busFrom: hasBusFrom ? busFrom : null, busTo: hasBusFrom || hasBusTo ? busTo : null, notes };
  return { plan, errors, alreadyDone: !hasBusFrom && hasBusTo };
}

/** Execute a rename. Ordered so a mid-failure re-run converges: the BUS folder moves first (the
 *  irreplaceable half — durable context), then the catalog (regenerable desired state). A crash between
 *  them leaves a moved folder and a stale catalog entry, which the next run completes; the reverse order
 *  would leave the catalog pointing at a name whose durable state is still under the old one. */
export function executeRename(networkDir: string, from: string, to: string, opts?: { host?: string }): RenameResult {
  const result = planRename(networkDir, from, to, opts);
  if (result.errors.length > 0) return result;
  const { plan } = result;

  if (plan.busFrom !== null && plan.busTo !== null) {
    renameSync(plan.busFrom, plan.busTo);
    // The tombstone is created AFTER the move, so a crash mid-rename never leaves a tombstone pointing at
    // a folder that does not exist yet.
    mkdirSync(plan.busFrom, { recursive: true });
    writeFileSync(join(plan.busFrom, TOMBSTONE_FILE), `${to}\n`);
  }

  if (plan.catalogFrom !== null && plan.catalogTo !== null) {
    const af = readAgentFile(plan.catalogFrom);
    writeAgentFile(plan.catalogTo, { ...af, identity: to });
    if (plan.catalogTo !== plan.catalogFrom) rmSync(plan.catalogFrom, { force: true });
  }
  return result;
}

/** The preview `convoy rename --dry-run` prints. */
export function renamePreview(networkDir: string, from: string, to: string, opts?: { host?: string }): string {
  const { plan, errors } = planRename(networkDir, from, to, opts);
  const lines = [`convoy rename — DRY RUN: ${from} → ${to}`];
  for (const n of plan.notes) lines.push(`  · ${n}`);
  if (plan.catalogFrom !== null) lines.push(`  · catalog ${plan.catalogFrom} → ${plan.catalogTo}`);
  for (const e of errors) lines.push(`  ✗ ${e}`);
  if (errors.length === 0) {
    lines.push("");
    lines.push(`  A running session keeps its OLD bus id until it is restarted — \`convoy down\` + \`convoy up\`, or`);
    lines.push(`  \`convoy reload ${to}\`, to re-materialize it under the new name.`);
    const af = readCatalog(networkDir).entries.find((e) => e.af.identity === from)?.af;
    if (af) lines.push(`\n${agentFileToToml({ ...af, identity: to })}`);
  }
  return lines.join("\n");
}
