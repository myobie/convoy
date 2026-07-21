// The convoy command surface as DATA — one declarative tree, two consumers, so they cannot drift:
//
//   1. argv dispatch. Every command that REJECTS unrecognized flags (`unknownFlag`, rc=2) derives its
//      allow-list from here via `flagAllowList`, instead of repeating two string literals at the call
//      site. That is what makes this table load-bearing rather than documentation: a flag that is not
//      in the table is not accepted by the CLI either.
//   2. `convoy completions <shell>` (src/completions.ts) generates fish/bash/zsh from the same tree.
//
// The closed enums (roles, harnesses, transports) are IMPORTED from their source-of-truth modules, so
// adding a role or a harness flows into the completions with no edit here.
//
// `app` is deliberately absent: it still dispatches (see cli.ts) but is hidden from `convoy --help` and
// the README until the macOS app is dailyable, and the completions match that public surface.

import { HARNESSES, TRANSPORTS } from "./agent-spec.ts";
import { ROLE_SPELLINGS } from "./role.ts";
import { DING_SERVICES } from "./network-config.ts";

/** A `--flag`. `kind` decides whether it consumes the next token — the same distinction `unknownFlag`
 *  makes. `values` is a closed set of completions for the argument; `takesPath` means the argument is a
 *  filesystem path (offer file completion, never a word list). */
export interface FlagSpec {
  readonly name: string;
  readonly desc: string;
  readonly kind: "bool" | "value";
  readonly values?: readonly string[];
  readonly takesPath?: boolean;
}

/** What a command's positional argument accepts. `dynamic` is resolved at completion time by the
 *  generated script (there is no static list of networks or agent identities). */
export interface PositionalSpec {
  readonly desc: string;
  /** `networks` = the dirs under convoy's home; `identities` = the catalog agent files of the network. */
  readonly dynamic?: "networks" | "identities";
  /** A closed set of values (e.g. `personas status|install`). */
  readonly values?: readonly string[];
  /** The positional is a filesystem path (e.g. `pretrust <dir>...`). */
  readonly takesPath?: boolean;
}

export interface CommandSpec {
  readonly name: string;
  readonly desc: string;
  readonly flags?: readonly FlagSpec[];
  readonly positional?: PositionalSpec;
  /** False for the commands that do NOT currently reject unrecognized flags (`reload`, `personas`).
   *  Their entries here are completion-only; teaching them to reject would be a behavior change and is
   *  out of scope for the completions work. */
  readonly rejectsUnknown?: boolean;
}

const JSON_FLAG: FlagSpec = { name: "json", desc: "JSON output", kind: "bool" };
const NETWORK_FLAG: FlagSpec = { name: "network", desc: "Named network or path", kind: "value" };
const DRY_RUN_FLAG: FlagSpec = { name: "dry-run", desc: "Show what would happen; change nothing", kind: "bool" };
const IDENTITY_FLAG: FlagSpec = { name: "identity", desc: "Agent identity", kind: "value" };
const HARNESS_FLAG: FlagSpec = { name: "harness", desc: "Coding-agent harness", kind: "value", values: HARNESSES };
const TRANSPORT_FLAG: FlagSpec = { name: "transport", desc: "Bus transport", kind: "value", values: TRANSPORTS };
const PERSONA_FLAG: FlagSpec = { name: "persona", desc: "Persona file", kind: "value", takesPath: true };
// Not "CLAUDE_CONFIG_DIR" — the flag names the HARNESS's own config-relocation dir (CLAUDE_CONFIG_DIR for
// claude, CODEX_HOME for codex), which is how an account is selected (decision 0004).
const CONFIG_DIR_FLAG: FlagSpec = { name: "config-dir", desc: "Config dir for the session (selects the account)", kind: "value", takesPath: true };

const NETWORK_POSITIONAL: PositionalSpec = { desc: "Network", dynamic: "networks" };
const IDENTITY_POSITIONAL: PositionalSpec = { desc: "Agent identity", dynamic: "identities" };

/** The convoy command tree. Keep in sync with the `switch` dispatch in cli.ts — src/completions.test.ts
 *  asserts every dispatched subcommand has an entry here. */
export const COMMANDS: readonly CommandSpec[] = [
  {
    name: "ls",
    desc: "List the convoy's members (default subcommand)",
    flags: [
      { name: "tree", desc: "Spawn-parentage tree + cross-machine liveness", kind: "bool" },
      { name: "live-only", desc: "Only live members", kind: "bool" },
      JSON_FLAG,
      NETWORK_FLAG,
      { name: "stale-after", desc: "Liveness staleness threshold (ms)", kind: "value" },
    ],
  },
  {
    name: "doctor",
    desc: "Setup-readiness suite: prove your setup can do real agent work",
    flags: [
      { name: "quick", desc: "Preflight only (no LLM calls)", kind: "bool" },
      { name: "full", desc: "Real CoS-to-supervisor-to-worker org proof (slower)", kind: "bool" },
      NETWORK_FLAG,
    ],
  },
  {
    name: "init",
    desc: "Stand up a network (name, megarepo, CoS)",
    // No --network: the network is the positional/--name, and passing --network is rejected (rc=2).
    flags: [
      { name: "name", desc: "Network name", kind: "value" },
      { name: "megarepo", desc: "Megarepo path agents cut worktrees off", kind: "value", takesPath: true },
      { name: "ding", desc: "Ding sidecar service (node = st ding, rust = compoundingtech/ding)", kind: "value", values: DING_SERVICES },
      { name: "quiet", desc: "No prompts or narration", kind: "bool" },
      { name: "yes", desc: "Accept defaults non-interactively", kind: "bool" },
      { name: "no-channel", desc: "Skip creating the default channel", kind: "bool" },
      JSON_FLAG,
    ],
    positional: { desc: "Network name or dir", dynamic: "networks", takesPath: true },
  },
  {
    name: "add",
    desc: "Declare an agent into the synced catalog (no launch)",
    flags: [
      IDENTITY_FLAG,
      { name: "host", desc: "Owning host (default: this machine)", kind: "value" },
      HARNESS_FLAG,
      { name: "model", desc: "Model id passed to the harness", kind: "value" },
      TRANSPORT_FLAG,
      { name: "mcp", desc: "Shorthand for --transport mcp", kind: "bool" },
      NETWORK_FLAG,
      { name: "dir", desc: "Workspace dir", kind: "value", takesPath: true },
      { name: "bin", desc: "Harness executable (path or command name)", kind: "value", takesPath: true },
      { name: "supervisor", desc: "Identity this agent reports to", kind: "value" },
      PERSONA_FLAG,
      { name: "permanent", desc: "Always-on member", kind: "bool" },
      DRY_RUN_FLAG,
      { name: "force", desc: "Overwrite an existing declaration", kind: "bool" },
    ],
    positional: { desc: "Role", values: ROLE_SPELLINGS },
  },
  {
    name: "render",
    desc: "Materialize an agent's worktree overlay from its catalog agent file",
    flags: [
      { name: "dir", desc: "Workspace dir", kind: "value", takesPath: true },
      NETWORK_FLAG,
      DRY_RUN_FLAG,
      { name: "print", desc: "Print instead of writing (alias for --dry-run)", kind: "bool" },
    ],
    positional: IDENTITY_POSITIONAL,
  },
  {
    name: "cos",
    desc: "Bootstrap a Chief of Staff",
    flags: [
      { name: "repo", desc: "CoS repo dir (required)", kind: "value", takesPath: true },
      IDENTITY_FLAG,
      TRANSPORT_FLAG,
      { name: "mcp", desc: "Shorthand for --transport mcp", kind: "bool" },
      NETWORK_FLAG,
      PERSONA_FLAG,
      { name: "prefix", desc: "Session-id prefix (default: short hostname)", kind: "value" },
      CONFIG_DIR_FLAG,
      { name: "permanent", desc: "Always-on member", kind: "bool" },
      DRY_RUN_FLAG,
      { name: "force", desc: "Overwrite an existing declaration", kind: "bool" },
    ],
  },
  {
    name: "run",
    // `run` is `add` + launch + attach, so its flag set IS `add`'s (they share `buildDeclaration`), plus
    // `--no-attach` for non-interactive callers. `--permanent` is here now: a run-created agent is a real
    // catalog member, so "always-on" is a coherent thing to ask of it. `--prefix` and `--config-dir` are
    // gone — the declaration carries the host prefix (`--host`) and the harness config dir (via `env`), and
    // a per-invocation override of either would desync the session from the agent file that describes it.
    desc: "Declare an agent, launch it, and attach (add + up, in one step)",
    flags: [
      IDENTITY_FLAG,
      { name: "host", desc: "Owning host (default: this machine)", kind: "value" },
      HARNESS_FLAG,
      { name: "model", desc: "Model id passed to the harness", kind: "value" },
      TRANSPORT_FLAG,
      { name: "mcp", desc: "Shorthand for --transport mcp", kind: "bool" },
      NETWORK_FLAG,
      { name: "dir", desc: "Workspace dir", kind: "value", takesPath: true },
      { name: "bin", desc: "Harness executable (path or command name)", kind: "value", takesPath: true },
      { name: "supervisor", desc: "Identity this agent reports to", kind: "value" },
      PERSONA_FLAG,
      { name: "permanent", desc: "Always-on member", kind: "bool" },
      { name: "no-attach", desc: "Declare and launch, but do not attach", kind: "bool" },
      DRY_RUN_FLAG,
      { name: "force", desc: "Re-declare an existing (stopped) agent with these flags", kind: "bool" },
    ],
    positional: { desc: "Role (default: worker)", values: ROLE_SPELLINGS },
  },
  {
    name: "up",
    desc: "Host a network in the foreground (supervisor + flapping-cap)",
    // No --network: the network is the positional, and --network is rejected (rc=2).
    flags: [
      { name: "once", desc: "One-shot reconcile-and-exit (no daemon)", kind: "bool" },
      JSON_FLAG,
      { name: "reconcile-interval", desc: "Reconcile interval", kind: "value" },
      { name: "fast-fail-window", desc: "Fast-fail window", kind: "value" },
      { name: "fast-fail-limit", desc: "Consecutive fast fails before flapping", kind: "value" },
      { name: "notify", desc: "Extra ding recipients on crash/flap (comma-separated)", kind: "value" },
    ],
    positional: NETWORK_POSITIONAL,
  },
  {
    name: "down",
    desc: "Tear down the network — the only path that kills sessions",
    // No --network: the network is the positional, and --network is rejected (rc=2).
    flags: [DRY_RUN_FLAG, { name: "force", desc: "Tear down without confirmation", kind: "bool" }, JSON_FLAG],
    positional: NETWORK_POSITIONAL,
  },
  {
    name: "eval",
    desc: "Run a batch/eval cell end-to-end (spin → wait for the done-signal → grade) → machine verdict",
    flags: [
      { name: "sandbox", desc: "Sandbox dir the cell spins in (default: a temp dir)", kind: "value", takesPath: true },
      NETWORK_FLAG,
      { name: "job", desc: "Job id whose completion event to wait on", kind: "value" },
      { name: "timeout", desc: "Max wait for the done-signal (ms)", kind: "value" },
      { name: "poll", desc: "Completion-event poll interval (ms)", kind: "value" },
      { name: "keep", desc: "Keep the sandbox network after grading", kind: "bool" },
      JSON_FLAG,
    ],
    positional: { desc: "Eval cell (a dir with task.toml + fixture/)", takesPath: true },
  },
  {
    name: "job",
    desc: "Signal a batch job complete (done) or read the completion event back (status)",
    flags: [
      { name: "status", desc: "Self-reported job outcome", kind: "value", values: ["ok", "fail"] },
      { name: "job", desc: "Job id within the network", kind: "value" },
      { name: "message", desc: "Optional note surfaced in the verdict", kind: "value" },
      NETWORK_FLAG,
      JSON_FLAG,
    ],
    positional: { desc: "Verb", values: ["done", "status"] },
  },
  {
    name: "env",
    desc: "Print eval-safe exports for a network's env",
    flags: [IDENTITY_FLAG, NETWORK_FLAG],
    positional: NETWORK_POSITIONAL,
  },
  {
    name: "shell",
    desc: "Open an interactive subshell with a network's env exported",
    flags: [IDENTITY_FLAG, NETWORK_FLAG],
    positional: NETWORK_POSITIONAL,
  },
  {
    name: "remove",
    desc: "Remove an agent (retire it in the catalog)",
    flags: [DRY_RUN_FLAG, NETWORK_FLAG],
    positional: IDENTITY_POSITIONAL,
  },
  {
    name: "rename",
    desc: "Rename an agent — moves the catalog entry and the durable bus folder, leaving a tombstone",
    flags: [DRY_RUN_FLAG, NETWORK_FLAG, { name: "host", desc: "Owning host (default: this machine)", kind: "value" }],
    // Two positionals (`<old> <new>`), but only the first is completable: the second is a name the user
    // is inventing. The table models one positional, so it describes the old identity.
    positional: IDENTITY_POSITIONAL,
  },
  {
    name: "reload",
    desc: "Re-materialize an agent from its pty.toml (kill + respawn)",
    // Completion-only: cmdReload does not call `unknownFlag`, so it accepts anything today.
    rejectsUnknown: false,
    flags: [DRY_RUN_FLAG, { name: "write-only", desc: "Heal the pty.toml only; do not respawn", kind: "bool" }, NETWORK_FLAG],
    positional: IDENTITY_POSITIONAL,
  },
  {
    name: "pretrust",
    desc: "Batch pre-trust agent dirs before spawning many back-to-back",
    flags: [CONFIG_DIR_FLAG, HARNESS_FLAG],
    positional: { desc: "Agent dir", takesPath: true },
  },
  {
    name: "install-cli",
    desc: "Symlink convoy + st + pty onto PATH",
    flags: [{ name: "bin", desc: "Target bin dir (default ~/.local/bin)", kind: "value", takesPath: true }],
  },
  {
    name: "personas",
    desc: "Persona status / install",
    // Completion-only: cmdPersonas takes a verb, not flags, and rejects nothing.
    rejectsUnknown: false,
    positional: { desc: "Verb", values: ["status", "install"] },
  },
  {
    name: "completions",
    desc: "Print a shell completion script",
    positional: { desc: "Shell", values: ["bash", "fish", "zsh"] },
  },
];

/** `-h`/`--help` is honored for every subcommand (cli.ts intercepts it before dispatch), so it is
 *  offered everywhere rather than repeated on each entry. */
export const HELP_FLAG: FlagSpec = { name: "help", desc: "Show help", kind: "bool" };

/** Flags accepted before a subcommand. */
export const TOP_LEVEL_FLAGS: readonly FlagSpec[] = [HELP_FLAG, { name: "version", desc: "Show version", kind: "bool" }];

export function commandSpec(name: string): CommandSpec {
  const spec = COMMANDS.find((c) => c.name === name);
  if (spec === undefined) throw new Error(`convoy: no command-table entry for "${name}" (src/command-table.ts)`);
  return spec;
}

/** The `[bool, value]` `--`-prefixed allow-lists `unknownFlag` needs for a command. Dispatch calls this
 *  rather than repeating the flag names, so the table and the accepted surface are the same thing. */
export function flagAllowList(name: string): [string[], string[]] {
  const flags = commandSpec(name).flags ?? [];
  const of = (kind: FlagSpec["kind"]): string[] => flags.filter((f) => f.kind === kind).map((f) => `--${f.name}`);
  return [of("bool"), of("value")];
}
