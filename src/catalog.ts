// CATALOG DISCOVERY — the catalog is a TREE that convoy slurps, not a directory of `<identity>.toml`.
//
// The spec's recommended layout is `catalog/{host}/{identity}/agent.{kdl,toml,json}`, but the rule is
// deliberately weaker than the layout: discovery scans `catalog/**/*.{kdl,toml,json}` recursively and
// keeps whatever turns out to be an agent spec. Two consequences are the point:
//
//   - IDENTITY COMES FROM CONTENT. The filename is not the identity. A flat `catalog/fabric.toml`, a
//     spec'd `catalog/silber/fabric/agent.kdl`, and a `catalog/anything.json` that happens to declare
//     `identity = "fabric"` are the same agent. Renaming a file does not rename an agent.
//   - PATH SEGMENTS ONLY SUPPLY DEFAULTS. A directory named for a host fills in `host` when the file
//     omits it. When both are present and DISAGREE, the content wins and discovery warns — because the
//     alternative (erroring) would strand an agent over a directory name, and the alternative (silently
//     preferring the path) would make a spec mean different things in different folders.
//
// Non-spec files in the catalog are skipped silently; malformed spec files are collected as errors and
// skipped, so one bad edit never wedges a whole reconcile.

import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { catalogDir, looksLikeAgentSpec, parseAgentFile, type AgentFile } from "./agent-file.ts";
import { decodeSpecText, formatOfPath } from "./spec-format.ts";
import { readFileSync } from "node:fs";
import { ROLES } from "./role.ts";
import { networkLayout } from "./paths.ts";
import { shortHostname } from "./agent-spec.ts";
import type { IdentityContext } from "./identity.ts";

/** One catalog entry — the parsed spec, where it came from, and anything discovery wants to say about it. */
export interface CatalogEntry {
  af: AgentFile;
  path: string;
}

export interface CatalogWarning {
  path: string;
  warning: string;
}

export interface CatalogError {
  path: string;
  error: string;
}

export interface Catalog {
  entries: CatalogEntry[];
  errors: CatalogError[];
  warnings: CatalogWarning[];
}

/** Every file under `dir`, recursively, sorted for determinism. Hidden entries are skipped at every
 *  level (`.git`, editor droppings, and the `.proposed`-style conventions people put in synced trees). */
function walkFiles(dir: string, depth = 0): string[] {
  if (depth > 8) return []; // a synced tree should never be this deep; refuse to chase a symlink loop
  let dirents;
  try {
    dirents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const d of [...dirents].sort((a, b) => a.name.localeCompare(b.name))) {
    if (d.name.startsWith(".")) continue;
    const p = join(dir, d.name);
    if (d.isDirectory()) out.push(...walkFiles(p, depth + 1));
    else if (d.isFile()) out.push(p);
  }
  return out;
}

/** Defaults a spec file's PATH supplies: a directory named for a host, and a directory named for the
 *  identity. Derived from the spec's recommended `catalog/{host}/{identity}/agent.ext` layout, read
 *  positionally from the right so a deeper tree still resolves the two segments nearest the file. */
export function pathDefaults(catalogRoot: string, path: string): { host?: string; identity?: string } {
  const segments = relative(catalogRoot, path).split(sep);
  segments.pop(); // the filename itself never supplies a default — identity comes from content
  const identity = segments.pop();
  const host = segments.pop();
  const out: { host?: string; identity?: string } = {};
  // A bare `catalog/<identity>.toml` has no directory segments at all; both stay undefined.
  if (identity !== undefined && identity !== "") out.identity = identity;
  if (host !== undefined && host !== "") out.host = host;
  return out;
}

/** Read every agent spec under `<net>/catalog/`, recursively, in any supported format. */
export function readCatalog(networkDir: string, opts?: { idContext?: IdentityContext }): Catalog {
  const root = catalogDir(networkDir);
  const entries: CatalogEntry[] = [];
  const errors: CatalogError[] = [];
  const warnings: CatalogWarning[] = [];

  // The length bound depends on where this network's sockets land, so discovery supplies it rather than
  // letting each spec be validated against a different (or absent) budget.
  const layout = networkLayout(networkDir);
  const seen = new Map<string, string>();

  for (const path of walkFiles(root)) {
    const format = formatOfPath(path);
    if (format === null) continue; // not a spec file — a README in the catalog is not an error

    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      errors.push({ path, error: e instanceof Error ? e.message : String(e) });
      continue;
    }

    // Decode first and check for the two required fields BEFORE parsing, so a non-spec JSON/TOML file
    // living in the catalog is skipped rather than reported as a malformed agent.
    let doc;
    try {
      doc = decodeSpecText(text, format);
    } catch (e) {
      errors.push({ path, error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (!looksLikeAgentSpec(doc)) continue;

    const defaults = pathDefaults(root, path);
    const idCtx: IdentityContext = {
      ptyRoot: layout.ptyRoot,
      prefix: (typeof doc["prefix"] === "string" ? doc["prefix"] : typeof doc["host"] === "string" ? doc["host"] : defaults.host) ?? shortHostname(),
      ...(opts?.idContext ?? {}),
    };

    let af: AgentFile;
    try {
      af = parseAgentFile(text, format, idCtx);
    } catch (e) {
      errors.push({ path, error: e instanceof Error ? e.message : String(e) });
      continue;
    }

    // Path vs content: content wins, the disagreement is reported.
    if (defaults.identity !== undefined && defaults.identity !== af.identity && !isRoleDir(defaults.identity)) {
      warnings.push({
        path,
        warning: `path says identity "${defaults.identity}" but the file declares "${af.identity}" — using "${af.identity}" (identity comes from content; the path only supplies defaults)`,
      });
    }
    if (defaults.host !== undefined && !isRoleDir(defaults.host) && af.host !== undefined && defaults.host.toLowerCase() !== af.host) {
      warnings.push({
        path,
        warning: `path says host "${defaults.host}" but the file declares "${af.host}" — using "${af.host}"`,
      });
    }
    // The path default only APPLIES when the file is silent.
    if (af.host === undefined && defaults.host !== undefined && !isRoleDir(defaults.host) && defaults.identity !== undefined) {
      af.host = defaults.host.toLowerCase();
    }

    const prior = seen.get(af.identity);
    if (prior !== undefined) {
      errors.push({ path, error: `duplicate identity "${af.identity}" — already declared by ${prior}` });
      continue;
    }
    seen.set(af.identity, path);

    if (af.supervisor === undefined && af.role !== "chief-of-staff") {
      warnings.push({ path, warning: `agent "${af.identity}" declares no \`supervisor\` — it has no escalation path` });
    }

    entries.push({ af, path });
  }
  return { entries, errors, warnings };
}

/** A directory named for a ROLE is a grouping convention (`catalog/workers/…`), not an identity claim,
 *  so it must not produce a path-vs-content warning on every file underneath it. */
function isRoleDir(name: string): boolean {
  const n = name.toLowerCase();
  const roles = ROLES as readonly string[];
  return roles.includes(n) || roles.includes(n.replace(/s$/, "")); // `workers/` groups `worker`s
}

/** Where `convoy add` WRITES a new spec. Convoy authors the spec's recommended layout
 *  (`catalog/<host>/<identity>/agent.toml`) even though it reads anything, so a catalog convoy created
 *  is one a reader can navigate. TOML stays the authored format — it is what every existing catalog and
 *  every doc uses; KDL and JSON are read, not written. */
export function newAgentSpecPath(networkDir: string, host: string, identity: string): string {
  return join(catalogDir(networkDir), host, identity, "agent.toml");
}
