// High-level intent for one agent → ALL wiring derived + validated before launch (AC-1). Ported from
// Sources/ConvoyKit/AgentSpec.swift. No hand-authored pty.toml, no hand-set ENV, no hand-chosen mode.

import { existsSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { baseFile } from "./personas.ts";
import { permanentByRole, type PermissionMode, type Role } from "./role.ts";

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
  /** `--prefix` for the pinned session id (`<prefix>.<agentShort>`); null = default to the short hostname. */
  prefix: string | null;
}

/** INTERIM POSTURE: every agent launches `bypassPermissions`. Unattended agents (esp. workers) stall
 *  on permission prompts — they can't git push, drain the bus, etc. — so the whole network runs bypass.
 *  This deliberately overrides the role→mode design table (`role.ts permissionMode`, which the
 *  ACCEPTANCE table still describes as spawner=bypass / worker=auto); revisit when the permission/hooks
 *  work (#10) lands. Both the generated launch command AND the derived display read from here, so they
 *  never diverge. */
export function specPermissionMode(_s: AgentSpec): PermissionMode {
  return "bypassPermissions";
}
/** Short hostname (no domain), LOWERCASED — the default session-id prefix per Nathan's naming decision.
 *  Lowercased so it matches pty's id charset + the validated live ids (`silber`, not `Silber.local`). */
export function shortHostname(): string {
  const h = hostname();
  return (h.split(".")[0] || h).toLowerCase();
}
/** The session-id prefix: `--prefix` override, else the short hostname (e.g. `silber`). */
export function specPrefix(s: AgentSpec): string {
  return s.prefix ?? shortHostname();
}
/** The agent's short name — the bus identity minus the harness suffix (`convoy-claude` → `convoy`). */
export function agentShort(identity: string): string {
  return identity.replace(/-(claude|codex)$/i, "");
}
/** The pinned pty session id for the claude session: `<prefix>.<agentShort>` (e.g. `silber.convoy`).
 *  The ding session appends `.ding`. Stable across respawns so ding + name refs never drift. */
export function sessionId(s: AgentSpec): string {
  return `${specPrefix(s)}.${agentShort(s.identity)}`;
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
    ["session-id", sessionId(s)],
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

// (Removed `stLaunchArgs` + `launchEnv` — convoy no longer shells `st launch`. Launch is fully native;
//  the write-logic + spawn live in src/launch.ts. `st launch` is being deleted from smalltalk.)
