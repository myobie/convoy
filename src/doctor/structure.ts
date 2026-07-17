// `convoy doctor` — the STRUCTURE-CORRECT half. Verifies a network's on-disk shape matches the redesign
// layout (named net; smalltalk/ + pty/ + worktrees/; host-prefixed bus folders; each workspace's .convoy/
// overlay git-excluded + a pristine root; pty.toml carries no --resume). Pure reads + a best-effort
// `git status` per workspace — never mutates. Safe on a FRESH network: the per-agent checks are vacuously
// green when there are no agents yet. Each check names what it proves + a concrete fix on failure.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONVOY_DIR, networkLayout } from "../paths.ts";
import { networkConfigPath, readNetworkConfig } from "../network-config.ts";

export interface StructureCheck {
  /** Short name of the check. */
  name: string;
  /** What a PASS proves (shown so the user understands what doctor is verifying). */
  proves: string;
  ok: boolean;
  detail: string;
  /** The exact next step on failure. */
  fix?: string;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** `git status --porcelain` for `dir` → "" when clean, the dirty lines when not, null when it isn't a git
 *  repo / git is missing (best-effort — a non-repo workspace isn't a structure failure). */
function gitPorcelain(dir: string): string | null {
  try {
    return execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

/** Verify the network's on-disk structure. Returns one StructureCheck per assertion, in narration order. */
export function structureChecks(network: string): StructureCheck[] {
  const checks: StructureCheck[] = [];
  const layout = networkLayout(network);
  const cfg = readNetworkConfig(network);

  checks.push({
    name: "named network",
    proves: "this network was created by `convoy init` and has a recorded config",
    ok: cfg !== null,
    detail: cfg ? `network "${cfg.name}"${cfg.megarepo ? ` — megarepo ${cfg.megarepo}` : ""}` : `no config at ${networkConfigPath(network)}`,
    fix: cfg ? undefined : "run `convoy init` on this network to create + record it",
  });

  for (const [label, path] of [
    ["smalltalk/", layout.stRoot],
    ["pty/", layout.ptyRoot],
    ["worktrees/", layout.worktrees],
  ] as const) {
    const ok = isDir(path);
    checks.push({
      name: label,
      proves: `the ${label} directory exists (bus / runtime / workspaces)`,
      ok,
      detail: ok ? `${path} present` : `MISSING: ${path}`,
      fix: ok ? undefined : "run `convoy init` to create the network structure",
    });
  }

  // Agents on the bus (smalltalk/<host>.<identity>/). Fresh net → none → per-agent checks pass vacuously.
  let agents: string[] = [];
  try {
    agents = readdirSync(layout.stRoot).filter((n) => !n.startsWith(".") && isDir(join(layout.stRoot, n)));
  } catch {
    // no smalltalk/ dir → already reported missing above
  }

  const notPrefixed = agents.filter((a) => !a.includes("."));
  checks.push({
    name: "host-prefixed bus folders",
    proves: "each agent's bus folder is <host>.<identity> (so machines sync as a clean union)",
    ok: notPrefixed.length === 0,
    detail: agents.length === 0 ? "no agents yet (fresh network)" : `${agents.length - notPrefixed.length}/${agents.length} host-prefixed${notPrefixed.length ? ` — not: ${notPrefixed.join(", ")}` : ""}`,
    fix: notPrefixed.length ? "re-add the non-prefixed agents — convoy now names bus folders <host>.<identity>" : undefined,
  });

  // Per-WORKSPACE checks: each worktree under worktrees/ (a real dir or a symlink to the agent repo) must
  // have the .convoy/ overlay and a PRISTINE git status (the overlay git-excluded), and its pty.toml must
  // carry NO --resume (agents cold-boot). Fresh net → no worktrees → vacuous pass.
  let workspaces: string[] = [];
  try {
    workspaces = readdirSync(layout.worktrees).filter((n) => !n.startsWith(".")).map((n) => join(layout.worktrees, n));
  } catch {
    // no worktrees dir → reported above
  }

  const dirty: string[] = [];
  const resumers: string[] = [];
  for (const ws of workspaces) {
    const porcelain = gitPorcelain(ws);
    if (porcelain !== null && porcelain.trim() !== "") dirty.push(ws);
    try {
      const toml = readFileSync(join(ws, CONVOY_DIR, "pty.toml"), "utf8");
      if (/--resume/.test(toml)) resumers.push(ws);
    } catch {
      // no .convoy/pty.toml in this workspace — not a --resume failure
    }
  }

  checks.push({
    name: "pristine workspaces",
    proves: "convoy's .convoy/ overlay is git-excluded — a composed repo stays clean",
    ok: dirty.length === 0,
    detail: workspaces.length === 0 ? "no workspaces yet (fresh network)" : dirty.length === 0 ? `${workspaces.length} workspace(s), all git-clean` : `DIRTY: ${dirty.join(", ")}`,
    fix: dirty.length ? "convoy should git-exclude its overlay; a dirty workspace means an unexpected untracked file — inspect `git -C <ws> status`" : undefined,
  });

  checks.push({
    name: "cold-boot (no --resume)",
    proves: "pty.toml is a launch spec, not a conversation pin — agents cold-boot + externalize state",
    ok: resumers.length === 0,
    detail: workspaces.length === 0 ? "no agents yet (fresh network)" : resumers.length === 0 ? "no pty.toml carries --resume" : `--resume found in: ${resumers.join(", ")}`,
    fix: resumers.length ? "remove --resume from those pty.tomls (state carries via the externalization hooks, not a conversation id)" : undefined,
  });

  return checks;
}

/** True when `existsSync(CONVOY_DIR)` — a tiny helper the caller uses; kept here so the module owns the
 *  overlay-name reference alongside its checks. */
export function hasOverlay(workspace: string): boolean {
  return existsSync(join(workspace, CONVOY_DIR));
}
