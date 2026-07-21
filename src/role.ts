// A role is high-level intent → the persona base, the permission-mode posture, and always-on-ness.
// Ported 1:1 from Sources/ConvoyKit/Role.swift. This table is the single source of truth for AC-1.

export type Role = "chief-of-staff" | "supervisor" | "worker" | "technical-manager";

export type PermissionMode = "bypassPermissions" | "auto" | "acceptEdits" | "plan" | "default";

export const ROLES: readonly Role[] = ["chief-of-staff", "supervisor", "worker", "technical-manager"];

/** Friendly aliases so `convoy add cos …` / `convoy add tm …` just work. A table rather than a `switch`
 *  so the accepted spellings are readable DATA: `parseRole` and the `convoy add <role>` completions both
 *  read this one list instead of retyping it (see src/command-table.ts). */
export const ROLE_ALIASES: Readonly<Record<string, Role>> = {
  chiefofstaff: "chief-of-staff",
  cos: "chief-of-staff",
  spawner: "chief-of-staff",
  // The agent spec names this role `root` — "the network root (formerly chief-of-staff)". Convoy's
  // internal name predates that and is threaded through personas, permission tiers, and the crash-ding
  // tier tag, so the spec's name is accepted as an alias rather than renamed underneath all of it.
  // Without this, a spec written to the published field table is rejected outright.
  root: "chief-of-staff",
  sup: "supervisor",
  wk: "worker",
  technicalmanager: "technical-manager",
  tm: "technical-manager",
  manager: "technical-manager",
};

/** Every spelling `convoy add <role>` accepts: the canonical roles plus the aliases above. */
export const ROLE_SPELLINGS: readonly string[] = [...ROLES, ...Object.keys(ROLE_ALIASES)];

export function parseRole(raw: string): Role | null {
  const r = raw.toLowerCase();
  if ((ROLES as readonly string[]).includes(r)) return r as Role;
  return ROLE_ALIASES[r] ?? null;
}

/** Whether this role spawns/manages other agents (elevated permissions). Workers don't. */
export function isSpawner(r: Role): boolean {
  return r !== "worker";
}

/** DERIVED — never hand-set. Spawner-class roles run `bypassPermissions`; workers run `auto`. */
export function permissionMode(r: Role): PermissionMode {
  return isSpawner(r) ? "bypassPermissions" : "auto";
}

/** DERIVED — only the CoS is always-on by role. Every other long-lived agent needs `--permanent`. */
export function permanentByRole(r: Role): boolean {
  return r === "chief-of-staff";
}

export function personaBaseFilename(r: Role): string {
  return `${r}.md`;
}
