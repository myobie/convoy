# convoy — Ontology

Canonical language for convoy. Several of these terms were overloaded in earlier
prose; the distinctions below are load-bearing, because two of them name
different objects that were both called "spec".

## Structure

Three layers describe one agent, and each is a different kind of thing:

```
Agent Spec        declared intent   — a file in the catalog, synced, durable
   ↓ compiled
Launch Spec       resolved intent   — in memory, machine-specific, never on disk
   ↓ serialized
Session Manifest  runnable state    — pty's file in the workspace
```

Reading downward loses portability and gains concreteness. Only the top layer is
authored; the other two are derived, and a change to either of them that is not
derivable from the layer above is a defect.

## Language

**Network**:
A directory holding one agent network: its bus, its session root, its catalog,
and its worktrees. The unit of isolation — two networks share nothing.
_Avoid_: cluster, environment, workspace

**Bus**:
The smalltalk message substrate — a folder per agent, messages as files. Convoy
provisions it and does not implement it.
_Avoid_: queue, broker, channel

**Catalog**:
The synced tree of agent specs. It is desired state: what should be running,
independent of what is.
_Avoid_: registry, inventory, database

**Agent Spec**:
One agent's declared intent, as a file in the catalog. The only authored layer,
and the only one that is portable across machines.
_Avoid_: agent file, config, catalog entry, pty.toml

**Launch Spec**:
An agent spec compiled against a particular machine and network — paths
resolved, defaults applied, wiring derived. In memory only.
_Avoid_: agent spec, config

**Session Manifest**:
The pty-format file convoy writes into a workspace describing the sessions to
run. A build artifact of rendering, never hand-authored.
_Avoid_: agent spec, config file

**Task**:
One pty session belonging to an agent. An agent is the job; its tasks are the
sessions that make it run.
_Avoid_: process, job, agent

**Identity**:
The agent's declared name, and the key its durable state is addressed by. Distinct
from the bus id and the session id, both of which are derived from it.
_Avoid_: name, id, agent name

**Bus Id**:
The host-prefixed identity (`<host>.<identity>`) naming the agent's bus folder,
so machines sync as a union rather than colliding.
_Avoid_: identity, agent id

**Session Id**:
The pty session name derived from the prefix and the identity. Bounded in length
because it becomes a socket path.
_Avoid_: identity, bus id, pid

**Declare**:
To write an agent spec into the catalog. Declaring launches nothing.
_Avoid_: create, add, spawn, start

**Render**:
To materialize an agent's workspace overlay — the session manifest, persona, and
any extra declared files — from its spec. Rendering launches nothing.
_Avoid_: build, install, deploy

**Reconcile**:
To compare desired state against actual state and act on the difference. The
operation convoy repeats; the reason recovery is ordinary.
_Avoid_: sync, refresh, poll

**Adopt**:
To recognise an already-running session as satisfying a declaration, and leave it
alone. The reason restarting the supervisor does not disturb the network.
_Avoid_: attach, reuse, skip

**Retire**:
To decommission an agent by editing its spec, because the catalog is
no-delete and a removed file re-propagates from a peer.
_Avoid_: delete, remove, archive

**Tombstone**:
The marker left at a renamed-away identity so convoy can resolve a stale
reference. Read by convoy only — the bus has no redirect mechanism.
_Avoid_: alias, redirect, forwarder

**Durable Context**:
The per-agent state that outlives any session and is addressed by identity — the
memory a cold-booted agent reconstructs itself from.
_Avoid_: history, cache, memory, session state

**Counter Discriminator**:
A trailing number that distinguishes agents only within one parent's lifetime, so
the same name denotes different agents across restarts. Distinguished from a
meaningful discriminator, which denotes the same thing every time.
_Avoid_: suffix, index, instance id

**Transport**:
How an agent receives bus traffic: a ding sidecar that pokes it, or a direct MCP
connection.
_Avoid_: protocol, channel, connection

**Ding**:
A poke delivered to an agent's session telling it that its inbox changed. It
carries no content; the bus carries the content.
_Avoid_: message, notification, event

**Harness**:
The agent program convoy runs. Distinct from the **bin**, which is what convoy
actually execs — a deployment's wrapper around the harness.
_Avoid_: agent, model, runtime

**Pre-trust**:
Marking a workspace trusted before a harness starts there, so an unattended
session never stops at an interactive trust prompt.
_Avoid_: auth, permission, allowlist

**Readiness**:
Whether this machine can do real agent work, established by exercising the real
lifecycle rather than by inspecting configuration.
_Avoid_: health, status, validation
