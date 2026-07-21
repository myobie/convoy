# 0001 — The identity grammar is the bus's, imported not restated

Status: accepted

## Context

Convoy validated identities with a regex of its own,
`/^[a-z0-9][a-z0-9._-]*$/`, reachable only from the pre-launch preflight.
smalltalk, which owns the bus folder namespace, validates with
`/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/` plus a list of fourteen reserved names.

The two disagree. `worker_fodfix` passes convoy's regex and is rejected by the
bus; so is any name ending in `-`, `.`, or `_`. Because `convoy add` checked the
identity for truthiness only and never ran even convoy's own regex, such a name
was written into the catalog, synced to every peer machine, and failed for the
first time when the agent tried to write to the bus.

That is the worst available failure ordering. The name is durable and
distributed before anything rejects it, so the failure surfaces on a different
machine than the one that made the mistake, at a time unrelated to the act that
caused it.

## Options

**Fix convoy's regex to match smalltalk's.** Cheapest, and wrong for the reason
the defect exists: a second regex is a second opportunity to drift. The two
already agreed once, presumably.

**Validate by attempting the write.** Honest but unusable — it requires a bus
and a network at declare time, and produces an error from a component the user
did not invoke.

**Import the bus's validator.** smalltalk exports `isAgent`/`asAgent` and
`RESERVED_NAMES` from its package entry point, which convoy already depends on
and already imports for its bus reader.

## Decision

Convoy imports `isAgent` from `@compoundingtech/smalltalk` and has no identity
grammar of its own. Convoy's `isValidIdentity` remains only as the historical
value the regression test compares against.

Length is a separate bound with a separate owner and is derived from pty (see
[0002](./0002-identity-length-is-derived-from-the-socket.md)).

## Consequences

- Whatever the bus accepts, convoy accepts; whatever it rejects, convoy rejects.
  The test asserts this over a name table rather than testing a regex, so the
  agreement is checked rather than assumed.
- Convoy inherits smalltalk's reserved-name list without maintaining a copy,
  including entries convoy has no independent reason to care about.
- A change to smalltalk's grammar changes convoy's behavior without a convoy
  change. This is the intent: the namespace has one owner. It does mean a
  smalltalk release can newly reject a name convoy previously declared, which
  discovery surfaces as a per-file error rather than a crash.
- Convoy's dependency on smalltalk moves from "reads the bus" to "reads the bus
  and shares its name algebra", which is a tighter coupling than before and the
  correct one.

## Evidence

- Direct execution of smalltalk's exported validator confirms the divergence:
  `isAgent("worker_fodfix")` is `false` where convoy's `isValidIdentity` is
  `true`.
- `src/identity.test.ts` asserts agreement across a table of names spanning
  charset, boundary, and reserved-word cases, so the two cannot silently drift.
