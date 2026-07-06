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

- `convoy add <role> --identity <id> [--transport mcp|ding] [--network <path>] [--persona <path>] [--dry-run]` — add an agent, correct-by-construction (was `st launch`). Role → permission-mode/persona/posture are **derived**, never hand-set; wiring is dry-run-validated before launch.
- `convoy remove <id> [--purge]` — remove an agent (teardown / decommission). The symmetric partner to `add`.
- `convoy cos --repo <dir>` — bootstrap a Chief of Staff: create/point-at its private repo, then launch it (correct-by-construction). The CoS runs its own first-run interview on boot.
- `convoy init [dir]` — create + wire a smalltalk network folder (was `st init`).
- `convoy doctor` — the "will this actually work here?" check: tools installed, config sane, the bus round-trips.
- `convoy ls [--live-only]` — list the convoy's members.
- `convoy app <install|status>` — manage the `Convoy.app` menubar host (non-brew install path).

## License

MIT.
