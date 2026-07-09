// convoy CLI — hand-rolled argv dispatch (like pty's src/cli.ts). `ls` is the default subcommand.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { down, up, type DownOptions, type UpOptions } from "./up.ts";
import { cmdAdd, cmdApp, cmdCos, cmdDoctor, cmdInit, cmdLs, cmdPersonas, cmdReload, cmdRemove, hasFlag, optValue, positionals } from "./commands.ts";
import { run } from "./exec.ts";

/** `<semver>` or `<semver>+<short-sha>` when a git sha is available. */
export function formatVersion(semver: string, shortSha: string | null): string {
  return shortSha ? `${semver}+${shortSha}` : semver;
}

/** The reported version: semver from package.json + the git short-sha of this checkout (from
 *  `git rev-parse --short HEAD` at runtime), gracefully omitting the sha when it isn't a git checkout
 *  (an installed package) or git isn't available. */
async function versionString(): Promise<string> {
  const root = dirname(dirname(fileURLToPath(import.meta.url))); // src/cli.ts → src → repo root
  let semver = "0.0.0";
  try {
    semver = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string | undefined) ?? semver;
  } catch {
    // package.json unreadable — keep the fallback
  }
  let sha: string | null = null;
  try {
    const r = await run("git", ["rev-parse", "--short", "HEAD"], { cwd: root });
    sha = r.ok ? r.stdout.trim() || null : null;
  } catch {
    // git missing or not a repo — omit the sha
  }
  return formatVersion(semver, sha);
}

export async function main(argv: string[]): Promise<void> {
  const cmd = argv[0];
  const rest = argv.slice(1);

  // --help footgun: `convoy add --help` (etc.) must show help, never fall through to running the
  // command (which would error on the missing required args). Handle it for every subcommand.
  if (cmd !== undefined && cmd !== "--version" && (rest.includes("--help") || rest.includes("-h"))) {
    printHelp();
    process.exit(0);
  }

  let code: number;
  switch (cmd) {
    case "ls":
    case undefined: // ls is the default subcommand
      code = await cmdLs(cmd === undefined ? argv : rest);
      break;
    case "doctor": code = await cmdDoctor(rest); break;
    case "init": code = await cmdInit(rest); break;
    case "add": code = await cmdAdd(rest); break;
    case "remove": code = await cmdRemove(rest); break;
    case "reload": code = await cmdReload(rest); break;
    case "cos": code = await cmdCos(rest); break;
    case "up": code = await cmdUp(rest); break;
    case "down": code = await cmdDown(rest); break;
    case "personas": code = await cmdPersonas(rest); break;
    case "app": code = await cmdApp(rest); break;
    case "-h":
    case "--help":
      printHelp();
      code = 0;
      break;
    case "--version":
      process.stdout.write(`${await versionString()}\n`);
      code = 0;
      break;
    default:
      process.stderr.write(`convoy: unknown command "${cmd}". Try \`convoy --help\`.\n`);
      code = 2;
  }
  process.exit(code);
}

async function cmdUp(args: string[]): Promise<number> {
  const opts: UpOptions = {};
  const num = (v: string | null): number | undefined => (v === null ? undefined : Number(v));
  opts.json = hasFlag(args, "--json");
  opts.once = hasFlag(args, "--once");
  opts.keepSessions = hasFlag(args, "--keep-sessions");
  opts.reconcileInterval = num(optValue(args, "--reconcile-interval"));
  opts.fastFailWindow = num(optValue(args, "--fast-fail-window"));
  opts.fastFailLimit = num(optValue(args, "--fast-fail-limit"));
  opts.network = positionals(args)[0];
  return up(opts);
}

async function cmdDown(args: string[]): Promise<number> {
  const opts: DownOptions = {};
  opts.json = hasFlag(args, "--json");
  opts.dryRun = hasFlag(args, "--dry-run");
  opts.force = hasFlag(args, "--force");
  opts.network = positionals(args)[0];
  return down(opts);
}

function printHelp(): void {
  process.stdout.write(
    "convoy — stand up and run your crew of agents (TypeScript).\n\n" +
      "SUBCOMMANDS:\n" +
      "  ls (default)   list the convoy's members\n" +
      "  doctor         check that convoy can run here (tools, bus)\n" +
      "  init [dir]     create + wire a network (auto-clones personas)\n" +
      "  add <role>     add an agent (correct-by-construction) [--identity --network --dir --mcp --permanent --prefix --dry-run]\n" +
      "  cos --repo <d> bootstrap a Chief of Staff\n" +
      "  up <network>   host a network in the foreground (TCC anchor + supervisor + flapping-cap)\n" +
      "  down [network] tear down the network — the ONLY path that kills sessions [--dry-run --force --json]\n" +
      "  remove <id>    remove an agent\n" +
      "  personas <status|install>\n" +
      "  app <status>\n",
  );
}
