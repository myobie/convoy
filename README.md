# convoy

The orchestrator for a [smalltalk](https://github.com/myobie/smalltalk) agent network — the tool you use to stand up and run your crew of agents.

Where the pieces sit:
- **smalltalk** — the message bus (send / read / archive / status / agents / context).
- **pty** — the session manager (runs each agent in a terminal).
- **convoy** — ties them together: launches agents, wires their transport (MCP or ding), installs their persona, keeps the network in sync across machines.

The metaphor: your agents travel together like a convoy, and each can carry **sidecars** — a *ding* sidecar (delivers messages to an agent running with no MCP) and a *sync* sidecar (rsyncs the bus to peer machines on write). smalltalk carries the talk; pty runs the terminals; convoy is the whole thing rolling down the road, sidecars and all.

The philosophy behind all of it is in the [manifesto](MANIFESTO.md).

## Status

Early but real. The CLI is a Swift SPM package that **orchestrates** the existing tools (it drives `st` and `pty`; it reimplements neither). `ls`, `doctor`, `init`, `add`, and `remove` work against the live bus today. A macOS menubar app (`Convoy.app`) ships from the same package. See [BUILD.md](BUILD.md).

The guiding requirement: **it must be impossible to misconfigure an agent.** `convoy add` takes high-level intent and derives all wiring correct-by-construction, validated before launch — see [notes/ACCEPTANCE.md](notes/ACCEPTANCE.md).

## Commands

- `convoy add <role> --identity <id> [--mcp] [--network <path>] [--persona <path>] [--dry-run]` — add an agent, correct-by-construction. **Ding-only by default** (no MCP); `--mcp` opts into MCP wiring. Role → permission-mode/persona/posture are **derived**, never hand-set; wiring is dry-run-validated before launch.
- `convoy remove <id> [--purge]` — remove an agent (teardown / decommission). The symmetric partner to `add`.
- `convoy cos --repo <dir>` — bootstrap a Chief of Staff: create/point-at its private repo, then launch it (correct-by-construction). The CoS runs its own first-run interview on boot.
- `convoy init [dir]` — create + wire a smalltalk network folder (ST_ROOT, bus layout, hooks).
- `convoy doctor` — the "will this actually work here?" check: tools installed, config sane, the bus round-trips, personas present.
- `convoy ls [--live-only]` — list the convoy's members.
- `convoy personas <status|install>` — the base personas convoy installs for roles. `init`/`add`/`cos` auto-install them if missing (footgun-proof setup); this is explicit control.
- `convoy app <install|status>` — manage the `Convoy.app` menubar host (non-brew install path).

## Operating

- [Driving your convoy remotely](docs/remote-control.md) — steer any member (especially your CoS) from
  your phone or a browser via Claude Code Remote Control, and the restart gotcha for a hosted network.

## Shell completions

convoy generates completion scripts for bash, zsh, and fish — with value completion for
roles (`chief-of-staff`, `worker`, …), transports (`mcp`/`ding`), harnesses (`claude`/`codex`),
and directory/file completion for `--network`, `--dir`, `--repo`, and `--persona`.

```sh
# zsh — write to a dir on your $fpath, then restart your shell
convoy --generate-completion-script zsh > ~/.zsh/completions/_convoy

# bash — source it from your ~/.bashrc
convoy --generate-completion-script bash > ~/.local/share/bash-completion/completions/convoy

# fish
convoy --generate-completion-script fish > ~/.config/fish/completions/convoy.fish
```

## License

MIT.
