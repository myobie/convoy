# convoy — Requirements

## Context

Convoy composes two components it does not own. **smalltalk** is the bus: a
folder per agent, messages as files, and the authority on what an agent name may
be. **pty** is the session manager: it runs each agent in a terminal and keys
each session's socket on the session's name. Convoy ties them together and owns
the declaration that produces both.

This root node states the constraints that hold across convoy. Subsystem nodes
refine them: [01-network](./01-network/), [02-agent-spec](./02-agent-spec/),
[03-supervision](./03-supervision/), [04-transports](./04-transports/),
[05-doctor](./05-doctor/).

## Assumptions

- **CV-A01 Files as the coordination substrate:** Cross-machine coordination
  happens by a synced directory rather than an RPC. A machine learns what it
  should run by reading files that arrived on disk.
- **CV-A02 Sessions are mortal:** Any session can end at any moment without
  warning or an exit record. Durability comes from what was externalized before
  it ended, never from the session's own memory.
- **CV-A03 Deployments wrap their harness:** A real deployment interposes on the
  harness binary for credential selection, persona projection, policy, and
  telemetry. Convoy is one caller among several and must not be the one that
  bypasses the wrapper.

## Constraints

- **CV-C01 The bus owns the name:** smalltalk decides which agent names are
  valid. Convoy has no authority to widen that grammar, and any name convoy
  accepts that smalltalk rejects is a defect in convoy.
- **CV-C02 The socket bounds the name:** pty binds a unix socket whose path
  embeds the session name, against a `sockaddr_un.sun_path` capacity of 104
  bytes. Identity length is therefore bounded by where the network lives, not by
  taste.
- **CV-C03 The catalog is synced union, no-delete:** Removing a catalog file
  locally does not remove the agent; a peer re-propagates it. Decommissioning is
  an edit to the file, not a deletion of it.
- **CV-C04 No redirect on the bus:** smalltalk resolves an identity to a folder
  by string join and supports no alias, redirect, or tombstone. Its send path
  validates the name and then creates the folder, so a message to a name nobody
  reads succeeds silently rather than failing.
- **CV-C05 A running session predates any change to it:** A session already
  running carries the wiring it was launched with. Changing a declaration cannot
  retroactively change a live session; only re-materializing it can.

## Acceptable Tradeoffs

- **CV-T01 Read three formats, write one:** Convoy reads KDL, TOML, and JSON but
  serializes only TOML, trading the ability to rewrite every spec it can read for
  one authored format that stays diffable and one serializer to keep correct.
- **CV-T02 Warnings over refusals for legacy shape:** A spec missing a field that
  became required warns rather than fails, trading strictness for not stranding
  every already-declared agent at the moment the field is introduced.
- **CV-T03 Derived wiring outranks declared wiring:** Where a declaration and a
  derived value collide, the derived value wins. This trades expressiveness for
  the correct-by-construction property that motivates declaration at all.
- **CV-T04 Convergence over immediacy:** Convoy reconciles on a loop rather than
  acting transactionally, trading immediate effect for the ability to recover
  from any intermediate state, including its own interrupted writes.

## Requirements

### Declaration

- **CV-R01 Declaration precedes launch:** An agent exists because it is declared
  in the catalog, not because a session is running. Anything that spawns an agent
  must write its declaration before launching it.
- **CV-R02 Intent in, wiring derived:** A declaration carries intent — who the
  agent is, what it works on, how it talks. Every operational value the session
  needs must be derived from that intent rather than authored alongside it.
- **CV-R03 Validation at declare time:** Every constraint that can be checked
  against a declaration must be checked when the declaration is written, not when
  it is launched. A declaration that reaches the catalog has already propagated.
- **CV-R04 One grammar for names:** Convoy must validate identities against the
  grammar of the component that owns the namespace, rather than any grammar of
  its own.
- **CV-R05 Declarations are portable:** A declaration must not embed anything
  specific to the machine that wrote it. Machine-specific values are named
  indirectly so the same file means the right thing on every machine.

### Continuity

- **CV-R06 Identity outlives the session:** An agent's identity must be stable
  across restarts, and its durable state must be addressed by that identity
  rather than by anything session-scoped.
- **CV-R07 Durable state only under stable names:** Convoy must not provision
  durable per-agent state under a name whose meaning can change between
  restarts.
- **CV-R08 Renaming preserves continuity:** Changing an agent's identity must
  carry its durable state and its declaration to the new name, leaving the agent
  as it was under a different name.
- **CV-R09 Stale references resolve or are visible:** A reference to a
  superseded identity must either resolve to the current one or be reportable.
  It must not silently become a new agent.

### Convergence

- **CV-R10 Reconciliation is idempotent:** Applying the desired state to a
  machine repeatedly must produce the same result as applying it once, from any
  starting state.
- **CV-R11 A partial change is completable:** Any multi-step change to durable
  state must be ordered so that re-running it after an interruption converges,
  rather than requiring manual repair.
- **CV-R12 Death is recoverable:** A supervised session that ends without being
  asked to must be re-materialized from its declaration.
- **CV-R13 Observation does not destroy:** Stopping the supervisor must leave
  running agents running. Only an explicit teardown may end sessions.
- **CV-R14 One bad declaration is contained:** A malformed or invalid entry must
  be reported and skipped without preventing every other agent from reconciling.

### Honesty

- **CV-R15 Verified, not assumed:** A readiness report must distinguish what was
  verified, what failed, and what could not be determined, and must never
  present the third as either of the first two.
- **CV-R16 Checks exercise the real path:** A readiness check must drive the same
  lifecycle a user drives. A check whose steps cannot produce the state it
  asserts is a defect in the check.
- **CV-R17 Failures name their fix:** A refusal must state what is wrong and what
  would make it right, in terms of the declaration the user controls.
- **CV-R18 Isolation is provable:** Operations that create throwaway state must
  leave the user's real network untouched, and that must be checked rather than
  asserted.
