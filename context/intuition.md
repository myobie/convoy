# convoy — Intuition

## The mental model

Convoy is a scheduler for agents, in the same shape as a scheduler for services.
The comparison people reach for is Nomad, and it holds where it matters: **the
agent is the job, and its pty sessions are the tasks**. You declare what should
exist; something else notices what does exist; the difference is the work.

Three components divide the problem, and keeping them straight explains most of
convoy's design:

```
convoy  ≈ the scheduler   declares, renders, reconciles, supervises
smalltalk ≈ the registry   who exists, who is live, and the mail between them
pty     ≈ the runtime      actually runs a terminal and keeps it alive
```

Convoy reimplements neither of the others. That is not modesty — it is the
source of two constraints that shape everything. smalltalk owns the namespace,
so smalltalk decides what an agent may be called. pty owns the sockets, so pty's
socket path decides how long a name may be. Convoy inherits both rather than
having opinions about either.

## Why declaration, and not just launching

The obvious way to start an agent is to start it. The reason convoy does not is
continuity.

A session is mortal. It crashes, it compacts, it gets killed, the machine
reboots. If the agent's identity is generated at launch, then every restart
produces a new name, a new bus folder, and an empty memory — the agent is a
stranger to its own past, and nothing long-running is possible. Externalizing
state to a file does not help if the name that addresses that file changes every
time.

So identity has to be **declared** — written down, durable, and independent of
any session. Once it is, two things become true at once. Durable state under
that name survives, so a cold-booted agent can reconstruct itself. And a session
becomes disposable: you can kill it at any moment and a fresh one converges on
the same goal. Crash recovery stops being an aspiration and becomes a property
you can test.

This is why declaring and launching are separate verbs. `add` writes a
declaration and starts nothing. `up` reconciles. The catalog is desired state;
sessions are actual state; convoy moves the second toward the first, repeatedly.

## The three layers that are all called "spec"

This trips up every reader once, so it is worth being explicit. The
[ontology](./ontology.md) has the full set; the shape is:

- The **agent spec** is a file in the catalog. Portable, synced, authored.
- The **launch spec** is that file compiled for one machine. In memory only.
- The **session manifest** is what pty reads. A build artifact in the workspace.

Only the top one is written by a human. The other two are derived, and anything
in them that cannot be derived from the layer above is a bug. That is the
correct-by-construction property: you supply intent, convoy supplies wiring, and
the categories of mistake that motivated the tool are unavailable rather than
merely discouraged.

## Why the catalog is a tree you slurp

Discovery scans the catalog recursively and keeps whatever declares an agent.
Identity comes from the file's *content*, never its name or its path; directory
segments only supply defaults.

The reason is that a filename is a terrible identifier. It is easy to rename by
accident, it collides with the filesystem's rules rather than the bus's, and it
makes moving a file a semantic act. Reading identity from content means you can
reorganise the catalog freely, and a spec means the same thing wherever it sits.
Where the path and the content disagree, the content wins and convoy says so —
erroring would strand an agent over a directory name.

## Why names are hard to choose and easy to change

Identity is meaningful, declared, and durable. That puts a real cost on picking
one, and a cost on naming is only acceptable if the choice is correctable.
Hence rename, which moves the declaration *and* the whole bus folder, so nothing
the agent externalized is orphaned.

The honest limit is worth knowing up front: the bus has no redirect. Convoy
leaves a tombstone and follows it, but a peer that still holds the old name and
sends to it afterwards will create a folder nobody reads. Moving the folder is
what saves in-flight mail; the tombstone is what keeps convoy's own view
coherent. See [DELTA-002](./.delta/DELTA-002-stale-sends-to-a-renamed-identity.md).

The same reasoning explains why convoy will not seed durable context for a
counter-named agent. A `worker-2` is only `worker-2` for one parent lifetime, so
memory addressed by that name will eventually be read by a stranger. The name is
allowed; convoy just will not prepare a place to keep memory under it. Note this
is a default and not an invariant — the bus creates the directory on demand, so
an agent determined to externalize state still can.

## Where to read next

- [vision.md](./vision.md) — why convoy exists and what "done" means.
- [requirements.md](./requirements.md) — the constraints that hold everywhere.
- [ontology.md](./ontology.md) — the vocabulary, including the three "specs".
- [.decisions/](./.decisions/) — why the sharp edges are shaped as they are.
- [.delta/](./.delta/) — where the contract and the implementation disagree today.
- Subsystems: [network](./01-network/), [agent spec](./02-agent-spec/),
  [supervision](./03-supervision/), [transports](./04-transports/),
  [doctor](./05-doctor/).
