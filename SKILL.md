---
name: convoy
description: >-
  Stand up and run a crew of agents — a CoS → supervisor → worker network — on
  this machine. convoy is the front door: it DECLARES agents into a synced
  catalog, materializes each one's workspace overlay, and hosts + supervises the
  running network (respawn, crash-loop cap). Reach for convoy whenever you need
  to CREATE, LAUNCH, HOST, or TEAR DOWN agents — not to talk to them.
when_to_use: >-
  You need to stand up an agent network, declare/add a new agent, host and
  supervise agents (start/respawn/adopt), tear a network down, or prove a setup
  is ready to run agents (doctor). NOT for messaging another agent (that is
  smalltalk / the `st` CLI) and NOT for wrapping a single terminal session (that
  is pty).
---

# convoy — stand up and run a crew of agents

## What it is
`convoy` is the single front door to a smalltalk agent network. It composes the
two lower layers — **@myobie/smalltalk** (the message bus + agent status, driven
by the `st` CLI) and **@myobie/pty** (persistent terminal sessions) — into one
verb set for the *lifecycle* of a crew: declare agents, materialize their
workspaces, host + supervise them, tear them down. Roles form a tree:
**chief-of-staff (CoS) → supervisor → worker** (plus technical-manager).

## When to reach for it
- Stand up a new network: `convoy init` (then `convoy up`).
- Add an agent: `convoy add <role> --identity <id>` (claude or codex harness).
- Host + supervise the network (respawn on exit, crash-loop cap): `convoy up`.
- Tear it down: `convoy down` (the only verb that kills sessions).
- Check readiness before trusting a setup: `convoy doctor`.

For *talking to* an agent (send/reply/read a message, answer a `[DING]` poke),
use `st` (smalltalk) — not convoy. For wrapping one process in a session, use
`pty`.

## The declarative arc (the core model)
convoy is folder-based and declarative — **declaring an agent is not running it**:

- **`convoy add`** = *declare*. Writes an agent file to the network's SYNCED
  catalog at `<net>/catalog/<identity>.toml`. Launches nothing.
- **`convoy render <id>`** = *materialize*. Compiles that agent file down into its
  workspace overlay (`.convoy/pty.toml`, persona, hooks). No launch, no bus.
- **`convoy up`** = *reconcile*. Reads the catalog, host-filters to THIS machine,
  and launches (or adopts) this host's agents — then supervises them every
  interval (respawn on exit, flapping-cap on crash-loops). The catalog syncs
  across machines, so `up` is also a cross-machine scheduler: drop a
  `host = "other-box"` agent file and that box's `convoy up` runs it.

Decommission an agent by EDITING its file (`retired = true`), not by deleting it —
the catalog syncs union/no-delete, so a bare `rm` just re-propagates from a peer.

## The idiom (happy path)
```sh
convoy init myproj                              # stand up a network at <home>/myproj (name → CoS)
convoy add worker --identity build-wk --dir ~/repos/app --harness claude   # DECLARE (writes catalog/build-wk.toml)
convoy add worker --identity iroh --dir ~/repos/x --model claude-fable-5    # optional per-agent model
convoy up myproj                                # reconcile + launch this host's agents, then supervise
convoy ls --tree                                # who's around: spawn tree + cross-machine liveness
convoy down myproj                              # tear down (the ONLY path that kills sessions)
```
`convoy env <net>` / `convoy shell <net>` export a network's env
(`ST_ROOT`/`PTY_ROOT`/`CONVOY_NETWORK`) so `st` and `pty` target it with zero
manual setup.

## Footguns (the ones that actually bite)
- **`convoy add` declares — it does NOT launch.** After `add`, nothing is
  running until `convoy up` reconciles the catalog. (declaring ≠ running.)
- **`ST_ROOT` is the BUS root (`<net>/smalltalk`), NOT the network dir.** Select a
  network by NAME or PATH (or `convoy env`), not by hand-setting `ST_ROOT` to a
  network dir — convoy derives the bus/pty/catalog subtrees from the network dir
  itself. A bare `convoy <cmd>` with no network / no `ST_ROOT` targets convoy's
  own default network (`<home>/default`), never st's global `~/.local/state/smalltalk`.
- **A network name vs a path.** A bare token (`default`, `my-net`) resolves under
  convoy's home (`($XDG_STATE_HOME|~/.local/state)/convoy/<name>`); anything with
  a `/` is used as a filesystem path.
- **`convoy up` never tears down.** Stopping (or crashing) the host DETACHES —
  agents keep running their last orders and a restart re-adopts them. Only
  `convoy down` kills sessions.
- **Ding by default.** Agents run ding-mode (the `st` poke bus), not MCP; pass
  `--mcp` only if you explicitly want MCP (codex is always ding).

## The exact surface
Run `convoy --help` for the full subcommand list, and `convoy <subcommand> --help`
for a command's flags. `convoy doctor` (`--quick` / `--full`) proves a setup can
do real agent work. `convoy --version` prints `<semver>+<short-sha>`.
