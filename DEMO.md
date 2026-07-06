# convoy — demo script

The story: **one command installs it, one command stands up a network, and you can see it.**

## 0. Prereqs (already true on the demo box)

- `st` (smalltalk) and `pty` on PATH — the tools convoy orchestrates.
- Homebrew.
- (For a live CoS spawn) network access — convoy auto-clones the public personas repo.

## 1. Install — one command

```sh
brew install --cask myobie/convoy/convoy
```

Installs `Convoy.app` → `/Applications` and the `convoy` CLI → PATH. Both run immediately
(the cask clears the un-notarized-download Gatekeeper friction; see `notes/DISTRIBUTION.md`).

```sh
convoy --version
convoy doctor          # will-it-work-here: tools, bus round-trip, personas, app
```

## 2. Stand up a network — one command

```sh
convoy init ~/nets/demo
```

Creates + wires the network **and auto-installs the base personas** — no hand-prep.

## 3. Bring up a Chief of Staff

```sh
convoy cos --repo ~/cos --network ~/nets/demo
```

- Creates the CoS's **private git repo** (init + seed + first commit).
- Launches a `chief-of-staff` agent **correct-by-construction**: `bypassPermissions` + `--permanent`
  + persona — all **derived**, dry-run-validated, then launched.
- The CoS runs its own **first-run interview** on boot.

## 4. See it — the menubar app

Open **Convoy.app** (menubar). It shows the network at a glance: members, live count, parked
flags, the network name, last refresh. Toggle **Keep Mac awake** and, if a host dir is set,
**Host network** (the app becomes the pty-daemon's responsible process → agents inherit its
grants — the TCC crux, `notes/HOSTING.md`).

```sh
convoy ls              # the same network, from the CLI
```

## The point (talking track)

- **Footgun-proof by construction.** `convoy add`/`cos` take high-level intent and *derive* every
  wiring — permission mode from role, ENV, tags, transport, hooks — validate it, dry-run `st
  launch`, and launch only on clean wiring. You cannot misconfigure an agent (`notes/ACCEPTANCE.md`).
- **Orchestrates, doesn't reimplement.** smalltalk is the bus, pty the sessions; convoy ties them
  into one story (`MANIFESTO.md`).
- **One artifact.** CLI + menubar app from one Swift package, shipped by one brew cask.

## Rehearsal

`scripts/demo-smoke.sh` runs the happy path against a scratch network (no persistent agents
spawned) and checks each link before you're live.
