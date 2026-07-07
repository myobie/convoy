// High-level intent for one agent → ALL wiring derived + validated before launch (AC-1). Ported from
// Sources/ConvoyKit/AgentSpec.swift. No hand-authored pty.toml, no hand-set ENV, no hand-chosen mode.

import { existsSync, statSync } from "node:fs";
import { baseFile } from "./personas.ts";
import { permanentByRole, permissionMode, type PermissionMode, type Role } from "./role.ts";

export type Transport = "mcp" | "ding";
export type Harness = "claude" | "codex";

export interface AgentSpec {
  harness: Harness;
  role: Role;
  identity: string;
  transport: Transport;
  networkRoot: string | null;
  personaOverride: string | null;
  workingDir: string | null;
  /** `--permanent` override; null = derive from role (only the CoS is permanent). */
  permanentOverride: boolean | null;
}

export function specPermissionMode(s: AgentSpec): PermissionMode {
  return permissionMode(s.role);
}
export function specPermanent(s: AgentSpec): boolean {
  return s.permanentOverride ?? permanentByRole(s.role);
}
/** Explicit override wins; else the role's base persona (null if not found → warning, not error). */
export function resolvedPersonaPath(s: AgentSpec): string | null {
  return s.personaOverride ?? baseFile(s.role);
}

/** Valid identity shape: lowercase alnum plus `. _ -`, starting alnum. */
export function isValidIdentity(id: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/.test(id);
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export interface Preflight {
  errors: string[];
  warnings: string[];
  derived: [string, string][];
  readonly ok: boolean;
}

/** Validate intent + compute the derived wiring. Never launches. `existing` = live member identities. */
export function preflight(s: AgentSpec, existing: string[]): Preflight {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isValidIdentity(s.identity)) {
    errors.push(`invalid identity "${s.identity}": use lowercase letters, digits, and . _ - (start alphanumeric)`);
  }
  if (existing.includes(s.identity)) {
    errors.push(`identity "${s.identity}" already exists on this network — pick another or \`convoy remove ${s.identity}\` first`);
  }
  if (s.networkRoot !== null) {
    if (!existsSync(s.networkRoot)) {
      errors.push(`network root does not exist: ${s.networkRoot} (run \`convoy init ${s.networkRoot}\` first)`);
    } else if (!isDir(s.networkRoot)) {
      errors.push(`network root is not a directory: ${s.networkRoot}`);
    }
  }
  if (s.personaOverride !== null) {
    if (!existsSync(s.personaOverride)) errors.push(`persona file not found: ${s.personaOverride}`);
  } else if (resolvedPersonaPath(s) === null) {
    warnings.push(`no base persona found for role "${s.role}" — launching without a persona (set CONVOY_PERSONAS_DIR or pass --persona)`);
  }
  if (s.workingDir !== null && !isDir(s.workingDir)) {
    errors.push(`working directory does not exist: ${s.workingDir}`);
  }
  if (s.harness === "codex" && s.transport === "mcp") {
    warnings.push("codex has no MCP transport — it always runs ding-mode; ignoring --transport mcp");
  }

  const effectiveTransport: Transport = s.harness === "codex" ? "ding" : s.transport;
  const derived: [string, string][] = [
    ["harness", s.harness],
    ["identity", s.identity],
    ["role", s.role],
    ["transport", effectiveTransport],
    ["permission-mode", specPermissionMode(s)],
    ["permanent", specPermanent(s) ? "yes" : "no"],
    ["persona", resolvedPersonaPath(s) ?? "(none)"],
    ["network", s.networkRoot ?? "(default)"],
    ["directory", s.workingDir ?? "(current)"],
  ];

  return { errors, warnings, derived, get ok() { return this.errors.length === 0; } };
}

/** The exact `st launch` argv this intent derives to (convoy reimplements none of the file-writing). */
export function stLaunchArgs(s: AgentSpec, dryRun: boolean): string[] {
  const args = ["launch", s.harness, "--identity", s.identity, "--permission-mode", specPermissionMode(s)];
  if (s.transport === "ding") args.push("--ding");
  if (specPermanent(s)) args.push("--permanent");
  const persona = resolvedPersonaPath(s);
  if (persona) args.push("--persona", persona);
  if (dryRun) args.push("--dry-run");
  return args;
}

/** Env overlay pinning the target network for the `st launch` call. */
export function launchEnv(s: AgentSpec): NodeJS.ProcessEnv | undefined {
  if (s.networkRoot === null) return undefined;
  return { ...process.env, ST_ROOT: s.networkRoot, PTY_ROOT: `${s.networkRoot}/pty` };
}
