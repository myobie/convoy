# convoy

The orchestrator for a [smalltalk](https://github.com/compoundingtech/smalltalk) agent network — the tool you use to stand up and run your crew of agents.

Where the pieces sit:
- **smalltalk** — the message bus (send / read / archive / status / agents / context).
- **pty** — the session manager (runs each agent in a terminal).
- **convoy** — ties them together: launches agents, wires their transport (MCP or ding), installs their persona, keeps the network in sync across machines.

The metaphor: your agents travel together like a convoy, and each can carry **sidecars** — a *ding* sidecar (delivers messages to an agent running with no MCP) and a *sync* sidecar (rsyncs the bus to peer machines on write). smalltalk carries the talk; pty runs the terminals; convoy is the whole thing rolling down the road, sidecars and all.

The philosophy behind all of it is in the [manifesto](MANIFESTO.md).

## Status

Early but real. The CLI is a **TypeScript package** (Node ≥23.6, which strips the types at load — no build step) that **orchestrates** the existing tools (it drives `st` and `pty`; it reimplements neither). `ls`, `doctor`, `init`, `add`, `remove`, `cos`, `up`, `down`, and `reload` work against the live bus today. The macOS menubar app (`Convoy.app`) lives in a separate `convoy-macos` repo. See [BUILD.md](BUILD.md).

The guiding requirement: **it must be impossible to misconfigure an agent.** `convoy add` takes high-level intent and derives all wiring correct-by-construction, validated before launch — see [notes/ACCEPTANCE.md](notes/ACCEPTANCE.md).

## Getting Started

convoy runs from source on **Node ≥ 23.6** (it strips the TS types at load — no build step). It orchestrates `st` (smalltalk) and `pty`, and **file-depends on `pty`**, so clone the four repos **as siblings** in one parent directory:

```sh
# e.g. under ~/src/github.com/compoundingtech
git clone https://github.com/compoundingtech/pty
git clone https://github.com/compoundingtech/smalltalk
git clone https://github.com/compoundingtech/personas
git clone https://github.com/compoundingtech/convoy

# build pty — REQUIRED (convoy imports @myobie/pty from ../pty via a file: dependency)
cd pty && npm install && npm run build && cd ..

# install smalltalk + convoy
( cd smalltalk && npm install )
( cd convoy && npm install )

# put st, pty, and convoy on your PATH — `npm link` in each repo, or symlink their
# bin/ entrypoints (smalltalk/bin/st, pty/bin/pty, convoy/bin/convoy)
```

Then stand up a network:

```sh
convoy doctor --quick            # fast preflight: tools, bus, hooks (incl /compact-safety), personas, PTY_ROOT length
convoy init ~/nets/demo          # use a SHORT path: PTY_ROOT (<net>/pty) must be ≤ 90 bytes
convoy cos --repo ~/cos --network ~/nets/demo   # bootstraps + boots a Chief of Staff (available in ~30s)
```

Run `convoy doctor --quick` first — the preflight fails loud on anything missing (a too-long network path, `st`/`pty` off PATH, undiscoverable hooks, a `/compact`-breaking hook) instead of a cryptic error at spawn. Then, when you want proof the whole thing works, run the full `convoy doctor` (below).

## Commands

- `convoy add <role> --identity <id> [--mcp] [--network <path>] [--persona <path>] [--dry-run]` — add an agent, correct-by-construction. **Ding-only by default** (no MCP); `--mcp` opts into MCP wiring. Role → permission-mode/persona/posture are **derived**, never hand-set; wiring is dry-run-validated before launch.
- `convoy remove <id>` — remove an agent (teardown / decommission). The symmetric partner to `add`.
- `convoy cos --repo <dir>` — bootstrap a Chief of Staff: create/point-at its private repo, then launch it (correct-by-construction). The CoS runs its own first-run interview on boot.
- `convoy up <network> [--json] [--reconcile-interval <s>]` — **host a network in the foreground** (the TCC anchor + supervisor). Brings the network's permanent sessions up as its own children and reconciles them — respawn on exit, with a crash-loop **flapping-cap**. Run it in a TCC-granted terminal (kitty) so agents inherit its grants. Stopping `convoy up` **leaves agents running** (they're decoupled from the supervisor); `--json` emits a machine-readable event stream.
- `convoy down [network] [--dry-run] [--force] [--json]` — **tear down the network**: the *only* command that kills sessions. Refuses while a `convoy up` host holds the network (it would respawn what you kill) unless `--force`.
- `convoy reload <id> [--dry-run]` — re-materialize an agent from its `pty.toml` (kill + respawn), picking up edits to its permission-mode / persona / ding wiring.
- `convoy init [dir]` — create + wire a smalltalk network folder (ST_ROOT, bus layout, hooks).
- `convoy doctor [--quick]` — the **setup-readiness suite**: proves your machine can do real agent work. A fast **preflight gate** (`st`/`pty` on PATH, bus round-trips, PTY_ROOT length, hooks discoverable + `/compact`-safe, personas present) — `--quick` stops here — then the full **readiness checks**, each spun in an isolated throwaway network that never touches your prod network (it snapshots prod pty sessions before/after and asserts zero delta): a tmp network stands up + tears down; inbox+ding delivery works end-to-end; agent state externalizes + is reconstructed after a cold restart; inbox processing stays exactly-once across a restart; and a CoS→supervisor→worker tree fixes a real bundled bug, graded held-out (the fix behaves + is mutation-valid, delegation is visible on the bus, only the worker commits). Every check is self-cleaning; failures are named + actionable. The full run spins real agents (minutes); `--quick` is instant.
- `convoy ls [--live-only]` — list the convoy's members.
- `convoy personas <status|install>` — the base personas convoy installs for roles. `init`/`add`/`cos` auto-install them if missing (footgun-proof setup); this is explicit control.
- `convoy app <install|status>` — manage the `Convoy.app` menubar host (non-brew install path).

## Operating

- [Driving your convoy remotely](docs/remote-control.md) — steer any member (especially your CoS) from
  your phone or a browser via Claude Code Remote Control, and the restart gotcha for a hosted network.

## License

MIT.
