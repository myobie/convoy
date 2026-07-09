// The base personas convoy installs (the public compoundingtech/personas repo). Ported from Personas.swift:
// if the repo isn't present, clone it rather than fail to resolve a role's persona (footgun-proof).

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { run } from "./exec.ts";
import { personaBaseFilename, type Role } from "./role.ts";

export const PERSONAS_REPO = "https://github.com/compoundingtech/personas.git";

/** Where role-base personas live: `$CONVOY_PERSONAS_DIR`, else the conventional repo path. */
export function personasDir(): string {
  const env = process.env["CONVOY_PERSONAS_DIR"];
  if (env) return env;
  return join(process.env["HOME"] ?? homedir(), "src/github.com/compoundingtech/personas");
}

/** The base persona file for a role, if present on disk. */
export function baseFile(role: Role): string | null {
  const candidate = join(personasDir(), personaBaseFilename(role));
  return existsSync(candidate) ? candidate : null;
}

/** Installed = the dir carries the role bases (chief-of-staff.md as sentinel). */
export function personasInstalled(): boolean {
  return existsSync(join(personasDir(), "chief-of-staff.md"));
}

export type EnsureResult = { kind: "already-present" } | { kind: "cloned"; path: string };

/** Ensure the personas repo is present, cloning if missing. Idempotent; throws (fail loud) if the
 *  target exists but isn't a personas checkout, or the clone fails. */
export async function ensureInstalled(log: (s: string) => void = () => {}): Promise<EnsureResult> {
  if (personasInstalled()) return { kind: "already-present" };

  const target = personasDir();
  if (existsSync(target)) {
    if (readdirSync(target).length > 0) {
      throw new Error(
        `${target} exists but has no personas — remove it or set CONVOY_PERSONAS_DIR to a personas checkout`,
      );
    }
  } else {
    mkdirSync(dirname(target), { recursive: true });
  }

  log(`cloning personas → ${target}`);
  const r = await run("git", ["clone", "--depth", "1", PERSONAS_REPO, target]);
  if (!r.ok) throw new Error(`failed to clone personas (${PERSONAS_REPO}): ${r.stderr.trim()}`);
  return { kind: "cloned", path: target };
}
