# convoy

The orchestrator for a [smalltalk](https://github.com/compoundingtech/smalltalk) agent network — the tool you use to stand up and run your crew of agents.

Where the pieces sit:
- **smalltalk** — the message bus (send / read / archive / status / agents / context).
- **pty** — the session manager (runs each agent in a terminal).
- **convoy** — ties them together: launches agents, wires their transport, installs their persona, keeps the network in sync across machines.

```
┌ convoy — the orchestrator ───────────────────┐
│ spawn · reconcile · respawn                  │
│                                              │
│ ┌ smalltalk — the bus ─────────────────────┐ │
│ │ a folder per agent · messages are files  │ │
│ │                                          │ │
│ │ cos/inbox/         ──  [ pty: claude ]   │ │
│ │ supervisor/inbox/  ──  [ pty: codex  ]   │ │
│ │ worker/inbox/      ──  [ pty: claude ]   │ │
│ │                                          │ │
│ │ send  = drop a file in a peer's inbox/   │ │
│ │ ding  = poke that agent's pty to read it │ │
│ └──────────────────────────────────────────┘ │
│                                              │
│ stop convoy → the agents keep running        │
└──────────────────────────────────────────────┘

 convoy ≈ Nomad   ·   smalltalk ≈ Consul   ·   pty ≈ pty
```

The metaphor: your agents travel together like a convoy, and each can carry **sidecars** — a *ding* sidecar (delivers messages to an agent running with no MCP) and a *sync* sidecar (rsyncs the bus between peer machines). smalltalk carries the talk; pty runs the terminals; convoy is the whole thing rolling down the road, sidecars and all.

The philosophy behind all of it is in the [manifesto](MANIFESTO.md); the durable
design intent — what convoy guarantees and why it is shaped this way — lives in
[`context/`](context/intuition.md), convoy's VRS.

Agents are declared in the [agent spec](https://github.com/compoundingtech/agent-spec)
format: one file per agent in the synced catalog, in KDL, TOML, or JSON. The
agent is the job, and its `pty` blocks are the tasks.

## Quickstart — adopt it in isolation

Once the three tools are on your PATH (see [Getting Started](#getting-started) for the one-time sibling clone + build), standing a network up end-to-end is **`init` → `doctor` → `up`**:

```sh
convoy init ~/nets/demo     # stand up a network (use a SHORT path — PTY_ROOT is <net>/pty, ≤ 90 bytes)
convoy doctor               # prove THIS machine can do real agent work — honest: no false negatives
convoy add worker --identity wk --dir ~/repos/app   # DECLARE an agent into the synced catalog (launches nothing)
convoy up ~/nets/demo       # reconcile the catalog: render + launch + supervise this host's agents
```

That's the whole on-ramp — convoy pulls **smalltalk** (the bus) and **pty** (the sessions) into one network you bring up with one command. `convoy doctor` won't lie to you: it runs a **real signed-in auth probe** per harness and locates the hooks the way they're actually wired (via `ST_BIN`, not just `st` on `$PATH`), so a green doctor genuinely means it works — it reports "couldn't verify" rather than a false "not present" / "not signed in". Stopping `convoy up` leaves the agents running; `convoy down` tears the network down.

## Status

Early but real. The CLI is a **TypeScript package** (Node ≥23.6, which strips the types at load — no build step) that **orchestrates** the existing tools (it drives `st` and `pty`; it reimplements neither). `ls`, `doctor`, `init`, `add`, `remove`, `cos`, `up`, `down`, and `reload` work against the live bus today.

The guiding requirement: **it must be impossible to misconfigure an agent.** `convoy add` takes high-level intent and derives all wiring correct-by-construction, validated before launch — see [notes/ACCEPTANCE.md](notes/ACCEPTANCE.md).

## Getting Started

convoy runs from source on **Node ≥ 23.6** (it strips the TS types at load — no build step) and works on **macOS + Linux**. It orchestrates `st` (smalltalk) and `pty`, and **file-depends on `pty`**, so clone the four repos **as siblings** in one parent directory. Every step below is copy-pasteable; `convoy doctor --quick` at the end confirms your machine is actually ready.

**1. Clone the four repos as siblings:**

```sh
# pick a parent dir, e.g. ~/src/github.com/compoundingtech, and clone all four INTO it
git clone https://github.com/compoundingtech/pty
git clone https://github.com/compoundingtech/smalltalk
git clone https://github.com/compoundingtech/personas
git clone https://github.com/compoundingtech/convoy
```

**2. Build pty, then install smalltalk + convoy:**

```sh
( cd pty && npm install && npm run build )   # REQUIRED — convoy imports @compoundingtech/pty from ../pty
( cd smalltalk && npm install )
( cd convoy && npm install )
```

**3. Put `convoy`, `st`, `pty` on your PATH — reliably:**

```sh
node convoy/bin/convoy install-cli   # symlinks all three into ~/.local/bin (override: --bin <dir>)
```

`install-cli` runs through `node` so it works before `convoy` is on PATH, is idempotent, and prints the exact **shell-specific** line to add `~/.local/bin` to your PATH if it isn't already (then restart your shell). **Do not use `npm link`** — a global `npm link` can pollute the shared `@compoundingtech/pty` symlink and silently break ding delivery for the whole network.

**4. Confirm the machine is ready, then stand up a network:**

```sh
convoy doctor --quick            # the "will this work on MY machine?" gate (see below)
convoy init ~/nets/demo          # use a SHORT path: PTY_ROOT (<net>/pty) must be ≤ 90 bytes
convoy add worker --identity wk --dir ~/repos/labelkit --network ~/nets/demo   # DECLARE an agent (writes catalog/wk.toml — launches nothing)
convoy up ~/nets/demo            # RECONCILE the catalog: render + launch this machine's declared agents
```

convoy is **declarative** (the Nomad model): **`add` declares** (writes an agent file into the network's synced `catalog/`), **`render` materializes** the worktree overlay, and **`up` reconciles** — it launches the agents whose `host` is the local machine and adopts the ones already alive. Declaring never launches anything; `convoy up` is what brings the crew up. Because the catalog syncs across machines, dropping an agent file with `host=B` schedules that agent onto machine B — **the synced folder is the scheduler.** (`convoy cos --repo ~/cos --network ~/nets/demo` bootstraps a Chief of Staff to seed the crew.)

`convoy doctor --quick` verifies **every cross-machine assumption up front** — Node ≥ 23.6, OS, a short-enough TMPDIR (pty sockets have a ~104-byte limit), `git`, `st`/`pty`/`convoy` on PATH, the bus round-trips, hooks discoverable + `/compact`-safe, personas present, and a **real signed-in auth probe** per harness (a credential can be present on disk but revoked, so a file check would pass while actually signed out) — each with an **actionable fix** instead of a cryptic failure at spawn. When you want proof the whole thing works end to end, run the full `convoy doctor` (fast per-mechanism checks) — and `convoy doctor --full` for the real-org proof (your real CoS→supervisor→worker run the whole lifecycle autonomously; opt-in, takes minutes). See [Commands](#commands).

## Commands

- `convoy add <role> --identity <id> [--host <machine>] [--dir <repo>] [--mcp] [--network <path>] [--persona <path>] [--permanent] [--dry-run] [--force]` — **DECLARE** an agent (the folder-based model): write its **agent file** into the synced catalog at `<net>/catalog/<id>.toml`, correct-by-construction. It launches **nothing** — declaring ≠ running; `convoy up` reconciles the catalog + launches this host's agents. `--host` is which machine runs it (default: this machine — it's the `<host>` in the `<host>.<identity>` bus id and the key `convoy up` host-filters on). **Ding-only by default**; `--mcp` opts into MCP. Role → permission-mode/persona/posture are **derived**, never hand-set. Re-declaring an existing agent refuses without `--force` (the catalog syncs across machines — a silent overwrite could disrupt a running agent).
- `convoy render <id> [--dir <workspace>] [--network <path>] [--dry-run]` — **materialize** an agent's worktree overlay (`.claude/rules/convoy.md` loader + `.convoy/{PERSONA.md,DING-BUS.md,pty.toml}` + `.claude/settings.local.json`) from its catalog agent file, git-excluding all of it — **no launch, no bus writes**. `--dry-run` prints exactly what it would write. The `render` verb of the declarative model (**add = declare · render = materialize · up = reconcile**); useful for inspecting the no-pollution footprint, and what `convoy up` does automatically on the way to launching.
- `convoy remove <id>` — remove an agent (teardown / decommission). The symmetric partner to `add`.
- `convoy rename <old> <new> [--dry-run] [--network <path>] [--host <machine>]` — **rename an agent without orphaning what it externalized**: moves the catalog entry **and the whole bus folder** (`context/`, `context/decisions/`, `archive/`, `inbox/`, `status`), so mail in flight at rename time is delivered under the new name. Leaves a **tombstone** at the old identity that *convoy* follows for its own resolution — note smalltalk has no redirect, so a peer still holding the old name that sends **after** the rename creates a folder nobody reads (see `context/.delta/DELTA-002`). A **running** session keeps its old bus id until re-materialized (`convoy reload <new>`, or down+up). Rename is why a meaningful declared identity is affordable: a name you can't change is a name nobody picks carefully.
- `convoy cos --repo <dir>` — bootstrap a Chief of Staff: create/point-at its private repo, then launch it (correct-by-construction). The CoS runs its own first-run interview on boot.
- `convoy up <network> [--once] [--json] [--reconcile-interval <s>]` — **host a network** by **reconciling the synced catalog** against reality (the TCC anchor + supervisor). For each agent file whose `host` is THIS machine: render-if-not-rendered + **launch-or-adopt** (adopts a live session; respawns only genuinely-dead permanents, with a crash-loop **flapping-cap**); a `retired = true` agent is **torn down**. A `host=OTHER` file is **skipped** — its own machine's `convoy up` launches it once the catalog syncs there. **The synced folder IS the cross-machine scheduler:** drop a job file with `host=B` and it runs on B, no RPC. Reconciles on a **timer + `fs.watch(catalog/)`** so a dropped/edited file runs (or retires) immediately; **`--once`** does a single reconcile pass then exits (for a shepherd cron / manual healing). Run it in a TCC-granted terminal (kitty) so agents inherit its grants. Stopping `convoy up` **leaves agents running** (decoupled from the supervisor — use `convoy down` to tear down); `--json` emits a machine-readable event stream.
- `convoy down [network] [--dry-run] [--force] [--json]` — **tear down the network**: the *only* command that kills sessions. Refuses while a `convoy up` host holds the network (it would respawn what you kill) unless `--force`.
- `convoy reload <id> [--dry-run]` — re-materialize an agent from its `pty.toml` (kill + respawn), picking up edits to its permission-mode / persona / ding wiring.
- `convoy pretrust <dir> [<dir>...] [--config-dir <path>]` — batch **pre-trust** agent working dirs in one atomic write, so a caller that spawns **multiple agents back-to-back** doesn't hit the workspace-trust race (see below). Call it once, with every dir, before the first `convoy add`. Config-dir-agnostic (writes the ambient `~/.claude.json`); pass `--config-dir` only for agents that will run under `CLAUDE_CONFIG_DIR`.
- `convoy install-cli [--bin <dir>]` — symlink `convoy` + `st` + `pty` (from their sibling repos) onto your PATH (default `~/.local/bin`), **reliably + idempotently, without `npm link`** (the global-symlink footgun that once broke ding delivery network-wide). Run it the first time via `node <convoy-clone>/bin/convoy install-cli`; it verifies the links and prints the shell-specific PATH line if the dir isn't on PATH yet. Portable (macOS + Linux).
- `convoy init [dir]` — create + wire a smalltalk network folder (ST_ROOT, bus layout, hooks).
- `convoy doctor [--quick] [--full]` — the **setup-readiness suite**: proves your machine can do real agent work. A fast **preflight gate** (`st`/`pty` on PATH, bus round-trips, PTY_ROOT length, hooks discoverable + `/compact`-safe, personas present, and a **real signed-in auth probe** per installed harness — a tiny live call, because a credential can be present on disk but revoked, so a file check would pass while actually signed out) — `--quick` stops here — then the **readiness checks**, each spun in an isolated throwaway network that never touches your prod network (it snapshots prod pty sessions before/after and asserts zero delta): a tmp network stands up + tears down; inbox+ding delivery works end-to-end; agent state externalizes + is reconstructed after a cold restart; inbox processing stays exactly-once across a restart; and a CoS→supervisor→worker tree fixes a real bundled bug, graded held-out (the fix behaves + is mutation-valid, delegation is visible on the bus, only the worker commits). These use **thin deterministic stand-ins** for the two upper tiers — fast per-mechanism health. **`--full`** is the complementary **real-org proof**: your **real** chief-of-staff + supervisor + worker, hosted under `convoy up`, run the whole lifecycle autonomously end-to-end — hands-off bring-up (first-run interview pre-seeded away, dirs pre-trusted, no prompts), an autonomous CoS→supervisor→worker delegation chain visible on the bus, a mutation-valid graded worker fix, restart-continuity (a cold no-`--resume` restart reconstructs from externalized `now.md` state and *straddles* the restart), and a clean teardown that leaves prod **sessions, durable crons, and trust config** untouched. Run the default for fast mechanism health; run `--full` (opt-in — a real multi-agent run takes minutes) when you want the real-org assurance that "when *you* `convoy init` + `convoy up`, it works." Every check is self-cleaning; failures are named + localize to a gate.
- `convoy ls [--live-only]` — list the convoy's members.
- `convoy personas <status|install>` — the base personas convoy installs for roles. `init`/`add`/`cos` auto-install them if missing (footgun-proof setup); this is explicit control.
- `convoy completions <bash|fish|zsh>` — print a shell completion script to stdout. Generated from the same command table argv dispatch validates against (`src/command-table.ts`), so completions can't drift from the flags convoy actually accepts. Install with e.g. `convoy completions fish > ~/.config/fish/completions/convoy.fish`.

## Operating

- **Spawning multiple agents back-to-back? Pre-trust them first.** Claude Code records workspace trust in a
  single shared `~/.claude.json`. When you `convoy add` several agents in quick succession, the first agent's
  booting Claude can read that file, then flush its stale copy back — clobbering the trust entry `convoy add`
  just wrote for a later sibling, which then stalls on the "do you trust this folder?" dialog. It's an
  ordering race a per-`add` write can't win (the clobber comes from an *earlier* sibling's process). The fix
  is to make every trust entry present **before any agent boots**: run `convoy pretrust <dir1> <dir2> …` once
  with all the working dirs before your first `convoy add`. `convoy up` does this for you automatically
  (it batch-pre-trusts every member before it brings the network up), so a hosted network needs no extra step
  — this only bites a caller (a script, or a supervisor) that spawns agents itself with bare `convoy add`.
- [Driving your convoy remotely](docs/remote-control.md) — steer any member (especially your CoS) from
  your phone or a browser via Claude Code Remote Control, and the restart gotcha for a hosted network.

## License

MIT.
