# 0003 — Rename moves both halves, and the tombstone is convoy's alone

Status: accepted

## Context

Requiring a meaningful, declared identity puts a cost on naming: the name is
durable, it is what peers address, and it is what durable context hangs off. A
cost on naming is only acceptable if a wrong choice is cheaply correctable.
Without rename, correcting a name means abandoning everything the agent
externalized under the old one, which in practice means names are never
corrected and bad ones calcify.

Rename therefore has to move two things that live in two different trees: the
catalog entry (desired state) and the bus folder (durable state — `context/`,
`context/decisions/`, `archive/`, `inbox/`, `status`).

The complication is in-flight mail and stale peers. The intent was a redirect
tombstone at the old identity so that references which have not caught up
resolve rather than fail.

Investigation of smalltalk shows that guarantee cannot be delivered from
convoy's side. smalltalk resolves an identity to a folder by string join. It has
no alias, redirect, or tombstone concept anywhere. Its send path validates the
recipient's name and then unconditionally creates the inbox directory. So a peer
holding the old name and sending to it after a rename does not fail and does not
redirect — it manufactures a folder that nobody reads, and that folder then
appears in agent listings because listings are a folder scan.

## Options

**Claim the redirect anyway.** Write the tombstone, document it as making
in-flight messages resolve. This would be false, and falsely documented
guarantees are worse than absent ones.

**Do not rename until smalltalk supports redirects.** Defensible, and it leaves
the naming cost unmitigated indefinitely for a dependency change convoy does not
control.

**Deliver what a move actually delivers, and scope the tombstone honestly.**

## Decision

Rename moves the whole bus folder and the catalog entry, and leaves a tombstone
that **convoy** resolves — for its own uniqueness checks, listings, and rename
idempotency. The tombstone is not claimed to be honored by the bus.

Moving the folder wholesale is what makes in-flight mail survive: messages
sitting in `inbox/` at rename time travel with the folder and are delivered
under the new name. They need no special handling precisely because the
operation is a move rather than a re-creation.

The residual gap — a stale peer sending to the old name *after* the rename — is
recorded as a delta rather than papered over.

Two structural details follow from smalltalk's behavior rather than from taste:

- The tombstone is a single dotfile with no `inbox/`, `archive/`, or `status`
  beside it, because smalltalk lists a folder as an agent when any of those
  exist. A tombstone carrying them would resurrect the renamed-away agent in
  every listing on the network.
- The bus folder moved is the host-prefixed `<host>.<identity>`, not the bare
  identity. Moving the bare name would move nothing and report success.

Ordering is bus first, then catalog. The bus half is the irreplaceable one; a
crash between the two leaves durable state moved and a stale declaration, which
the next run completes. The reverse order would point the declaration at a name
whose durable state is still under the old one.

## Consequences

- A name is correctable without losing history, which is what makes requiring a
  meaningful name reasonable.
- A rename is re-runnable after an interruption, and the "already done" state is
  detected rather than treated as an error.
- A running session keeps its old bus id until it is re-materialized, because a
  live session carries the wiring it launched with. Rename says so rather than
  implying the change is immediate.
- Renaming does not free the old name; the tombstone occupies it. This is
  deliberate — reusing a renamed-away name would resolve stale references to the
  wrong agent.
- Cross-machine rename is out of scope: the catalog syncs, but the bus folder
  move happens on the machine that runs the rename.

## Evidence

- smalltalk's send path: name validation followed by an unconditional inbox
  `mkdir`, with no existence check and no redirect probe.
- smalltalk's agent listing: a folder scan gated on `inbox/`, `archive/`, or
  `status` existing — which is what makes the bare-dotfile tombstone invisible.
- A search of smalltalk for redirect, alias, tombstone, moved, renamed, and
  forward finds no identity-level mechanism; the only "tombstone" concept is a
  message-level archive invariant.
- `src/rename.test.ts` asserts the durable move, in-flight mail survival,
  host-prefixed folder selection, tombstone invisibility, refusal to merge two
  agents' state, and re-runnability.
