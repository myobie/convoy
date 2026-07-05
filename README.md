# convoy

The orchestrator for a [smalltalk](https://github.com/myobie/smalltalk) agent network — the tool you use to stand up and run your crew of agents.

Where the pieces sit:
- **smalltalk** — the message bus (send / read / archive / status / agents / context).
- **pty** — the session manager (runs each agent in a terminal).
- **convoy** — ties them together: launches agents, wires their transport (MCP or ding), installs their persona, keeps the network in sync across machines.

The metaphor: your agents travel together like a convoy, and each can carry **sidecars** — a *ding* sidecar (delivers messages to an agent running with no MCP) and a *sync* sidecar (rsyncs the bus to peer machines on write). smalltalk carries the talk; pty runs the terminals; convoy is the whole thing rolling down the road, sidecars and all.

## Status

Early. Commands are migrating here **gradually** from smalltalk (`launch`, `init`, …) so the surface stays working throughout.

## Commands (planned)

- `convoy add <harness> --identity <id> [--ding] [--permanent] [--persona <path>]` — add an agent to the convoy (was `st launch`). It joins the network as a running member.
- `convoy remove <id>` — remove an agent from the convoy (teardown / decommission). The symmetric partner to `add`.
- `convoy init` — wire a directory's MCP / hooks (was `st init`).
- `convoy doctor` — the "will this actually work here?" check: tools installed, config sane, hooks fire, the bus round-trips, an agent can spawn.
- `convoy ls` — list the convoy's members.

## License

MIT.
