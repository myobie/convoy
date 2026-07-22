// Parity + generator-output checks for `convoy completions`.
//
// The contract src/command-table.ts exists to hold:
//   - every subcommand cli.ts DISPATCHES has a table entry (or is on the documented exclusion list),
//     so a new subcommand cannot ship without completions;
//   - every flag `convoy --help` DOCUMENTS is in the table, so the completions cannot fall behind the
//     help text. This is the flag-level half, and it works because dispatch derives its accepted-flag
//     allow-lists from the same table (`flagAllowList`) — table, dispatch, and completions are one
//     thing, not three lists that happen to agree today;
//   - the generated scripts are syntactically valid for their shell.

import { describe, expect, it } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS, flagAllowList } from "./command-table.ts";
import { bashScript, fishScript, SHELLS, zshScript } from "./completions.ts";
import { HARNESSES, TRANSPORTS } from "./agent-spec.ts";
import { ROLES } from "./role.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bin = join(root, "bin", "convoy");

/** `app` still dispatches but is deliberately hidden from `convoy --help` and the README until the
 *  macOS app is dailyable (see cmdApp). The completions match the public surface, not the dispatch. */
const HIDDEN_COMMANDS = new Set(["app"]);

function runConvoy(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [bin, ...args], { encoding: "utf8" });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

/** Best-effort `which`: the resolved path, or undefined when the shell isn't installed here. */
function which(cmd: string): string | undefined {
  try {
    return execSync(`command -v ${cmd}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || undefined;
  } catch {
    return undefined;
  }
}

describe("command table covers the dispatch surface", () => {
  it("has an entry for every subcommand cli.ts dispatches", () => {
    const src = readFileSync(join(root, "src", "cli.ts"), "utf8");
    const dispatched = [...src.matchAll(/^\s*case "([a-z][a-z-]*)":/gm)].map((m) => m[1]!);
    const known = new Set(COMMANDS.map((c) => c.name));
    const missing = dispatched.filter((c) => !known.has(c) && !HIDDEN_COMMANDS.has(c));
    expect(missing, `dispatched subcommands missing from src/command-table.ts: ${missing.join(", ")}`).toEqual([]);
  });

  it("does not offer the deliberately hidden commands", () => {
    for (const hidden of HIDDEN_COMMANDS) {
      expect(COMMANDS.some((c) => c.name === hidden)).toBe(false);
    }
  });
});

describe("command table covers the documented flags", () => {
  // `convoy --help` is the user-facing contract; the table must be a superset of what it advertises.
  const help = runConvoy(["--help"]).stdout;

  it("prints a help listing to parse", () => {
    expect(help).toMatch(/SUBCOMMANDS:/);
  });

  for (const c of COMMANDS) {
    it(`${c.name}: every flag in its help line is in the table`, () => {
      // The subcommand's own help line — "  <name> ... " up to the next line.
      const line = help.split("\n").find((l) => new RegExp(`^ {2}${c.name}\\b`).test(l));
      if (line === undefined) return; // not advertised in help (e.g. it takes no line of its own)
      // convoy's help lists a command's flags in trailing `[...]` groups, and occasionally in the
      // label itself (`cos --repo <d>`). Read only those — the prose in between mentions flags that
      // belong to OTHER tools (e.g. reload "healing the ding to carry --root").
      const bracketed = [...line.matchAll(/\[[^\]]*\]/g)].map((m) => m[0]).join(" ");
      const label = line.slice(0, line.indexOf(" ", 2 + c.name.length + 1) + 1);
      const documented = [...new Set([...`${label} ${bracketed}`.matchAll(/--[a-z][a-z-]*/g)].map((m) => m[0]))];
      const [bool, value] = flagAllowList(c.name);
      const accepted = new Set([...bool, ...value, "--help"]);
      const missing = documented.filter((f) => !accepted.has(f));
      expect(missing, `\`convoy ${c.name}\` documents ${missing.join(", ")} but the table does not declare it`).toEqual([]);
    });
  }
});

describe("closed enums come from their source-of-truth modules", () => {
  it("offers every role spelling for `convoy add <role>`", () => {
    const add = COMMANDS.find((c) => c.name === "add")!;
    for (const role of ROLES) expect(add.positional?.values).toContain(role);
    expect(add.positional?.values).toContain("cos"); // an alias, from role.ts's ROLE_ALIASES
  });

  it("offers every harness and transport", () => {
    const fish = fishScript();
    for (const h of HARNESSES) expect(fish).toContain(h);
    for (const t of TRANSPORTS) expect(fish).toContain(t);
  });
});

describe("path completion is offered where a value is a path", () => {
  it("fish uses -F (real files), never -x, for path flags", () => {
    const fish = fishScript();
    for (const flag of ["--dir", "--repo", "--persona", "--config-dir", "--bin", "--megarepo"]) {
      const lines = fish.split("\n").filter((l) => l.includes(` -l ${flag.slice(2)} `));
      expect(lines.length, `no completion emitted for ${flag}`).toBeGreaterThan(0);
      for (const l of lines) {
        expect(l, `${flag} should offer file completion: ${l}`).toContain("-r -F");
        expect(l, `${flag} should not be -x (that suppresses files): ${l}`).not.toContain(" -x ");
      }
    }
  });

  it("fish offers files for the pretrust <dir> positional", () => {
    expect(fishScript()).toContain("complete -c convoy -n '__convoy_using_command pretrust' -F");
  });
});

describe("flags are scoped to the subcommand that honors them", () => {
  // The defect this replaces: a hand-maintained file offered --network and --json globally, while
  // `convoy up --network` / `convoy doctor --json` exit 2.
  it("does not offer --network to init/up/down/pretrust/install-cli", () => {
    for (const name of ["init", "up", "down", "pretrust", "install-cli"]) {
      const [bool, value] = flagAllowList(name);
      expect([...bool, ...value], `${name} must not accept --network`).not.toContain("--network");
    }
  });

  it("offers --json only to ls/init/up/down/restart and the batch verbs eval/job", () => {
    const withJson = COMMANDS.filter((c) => (c.flags ?? []).some((f) => f.name === "json")).map((c) => c.name);
    expect(withJson.sort()).toEqual(["down", "eval", "init", "job", "ls", "restart", "up"]);
  });

  it("matches the CLI: a scoped flag is rejected where it does not apply", () => {
    expect(runConvoy(["doctor", "--json"]).status).toBe(2);
    expect(runConvoy(["install-cli", "--network", "x"]).status).toBe(2);
  });
});

describe("convoy completions <shell>", () => {
  it("prints a script for every supported shell", () => {
    for (const shell of SHELLS) {
      const r = runConvoy(["completions", shell]);
      expect(r.status, `convoy completions ${shell} failed: ${r.stderr}`).toBe(0);
      expect(r.stdout.length).toBeGreaterThan(200);
      expect(r.stdout).toMatch(/\n$/);
    }
  });

  it("exits 2 with usage for an unknown or missing shell", () => {
    const unknown = runConvoy(["completions", "tcsh"]);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toMatch(/unknown shell/i);
    expect(runConvoy(["completions"]).status).toBe(2);
  });

  it("fish output binds to `convoy` and is syntactically valid", () => {
    const script = fishScript();
    expect(script).toMatch(/^complete -c convoy /m);
    const fish = which("fish");
    if (!fish) return; // not installed here
    const r = spawnSync(fish, ["-n", "-c", script], { encoding: "utf8" });
    expect(r.status, `fish -n failed:\n${r.stderr}`).toBe(0);
  });

  it("bash output is syntactically valid", () => {
    const bash = which("bash");
    if (!bash) return;
    const r = spawnSync(bash, ["-n", "-c", bashScript()], { encoding: "utf8" });
    expect(r.status, `bash -n failed:\n${r.stderr}`).toBe(0);
  });

  it("zsh output is syntactically valid", () => {
    const zsh = which("zsh");
    if (!zsh) return;
    const r = spawnSync(zsh, ["-n", "-c", zshScript()], { encoding: "utf8" });
    expect(r.status, `zsh -n failed:\n${r.stderr}`).toBe(0);
  });
});
