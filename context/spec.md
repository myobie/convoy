# convoy — Spec

The root blueprint. Subsystem nodes own their own detail; this document defines
the layering, the lifecycle, and the boundaries between convoy and the
components it composes.

## Status

Draft.

## Scope

This node specifies how a declaration becomes a running agent, and which
component owns each decision along the way. It does not specify network layout
([01-network](./01-network/)), the spec format ([02-agent-spec](./02-agent-spec/)),
reconcile mechanics ([03-supervision](./03-supervision/)), transport wiring
([04-transports](./04-transports/)), or the readiness contract
([05-doctor](./05-doctor/)).

## Component boundaries

Convoy composes two components and owns neither. The division is not
organisational; each boundary carries a constraint convoy cannot relax.

| Component | Owns | Constraint it imposes on convoy |
| --- | --- | --- |
| smalltalk | the agent namespace, folders, messages | which identities are legal ([CV-C01](./requirements.md)); no redirect ([CV-C04](./requirements.md)) |
| pty | sessions, sockets, restart | how long an identity may be ([CV-C02](./requirements.md)) |
| convoy | declaration, derivation, reconciliation | — |

Convoy's authority stops at derivation. It decides what wiring an intent implies;
it does not decide what a name may be or how long a socket path can get.

## The compilation chain

One agent is described at three levels, each derived from the one above.

```
agent spec        catalog file, synced, authored, portable
    │  compile against this machine + this network
    ▼
launch spec       in memory: paths resolved, defaults applied, wiring derived
    │  serialize
    ▼
session manifest  workspace file, read by pty
```

Compilation is where machine-specific values enter. An agent spec names a host
and a workspace; the launch spec resolves the bus root, the session root, the
prefix, the bus id, the session ids, the permission posture, the boot prompt, the
persona, and the transport. Nothing in the session manifest may originate
anywhere but the layer above it — that is the mechanism behind
[CV-R02](./requirements.md).

Where a declared value and a derived value collide, the derived value wins
([CV-T03](./requirements.md)). Declared `env` is merged *under* derived
environment for this reason: a declared key must not be able to repoint an agent
at another bus.

## Lifecycle

Five verbs, each with a single responsibility. The separation between the first
three is the substance of [CV-R01](./requirements.md).

**Declare** writes an agent spec into the catalog and launches nothing. It is the
only step that creates an agent. Every constraint checkable against the
declaration is checked here ([CV-R03](./requirements.md)), because the catalog
syncs — a declaration that reaches it has already propagated.

**Render** materializes an agent's workspace overlay from its spec: the session
manifest, the persona, the harness rules, and any declared extra files. It
launches nothing and is idempotent.

**Reconcile** compares the catalog, host-filtered to this machine, against the
running sessions, and acts on the difference: launch what is declared and absent,
tear down what is retired and present, adopt what is declared and already
running, ignore what belongs to another machine.

**Rename** moves an identity: the declaration and the durable bus folder
together, leaving a tombstone. Ordered bus-first so an interrupted rename
completes on re-run ([CV-R11](./requirements.md)); see
[0003](./.decisions/0003-rename-moves-both-halves-and-tombstones-the-old-name.md).

**Retire** decommissions by editing the declaration rather than deleting it,
because the catalog is union/no-delete ([CV-C03](./requirements.md)) and a
deleted file re-propagates from a peer.

Teardown is deliberately not among them: stopping the supervisor leaves agents
running ([CV-R13](./requirements.md)), and only an explicit teardown ends
sessions.

## Identity

An identity is validated against three bounds with three owners, and convoy
authors only the third.

| Bound | Owner | Mechanism |
| --- | --- | --- |
| charset, reserved words | smalltalk | its exported validator, imported not restated |
| length | pty | derived from the socket path budget |
| counter shape | convoy | refuses durable state, not the name |

Identity is not the bus id and not the session id. Both are derived: the bus id
is `<host>.<identity>`, so machines sync as a union rather than colliding; the
session id is `<prefix>.<agent-short>`, with the sidecar appending a suffix. The
longest derived form is what the length bound must accommodate, because a bound
that admits a name the sidecar cannot bind admits a half-working agent.

Rationale for each: decisions
[0001](./.decisions/0001-identity-grammar-is-the-buss.md),
[0002](./.decisions/0002-identity-length-is-derived-from-the-socket.md), and
[0006](./.decisions/0006-counter-named-identities-get-no-durable-context.md).

## Durable state

Per-agent durable state lives on the bus under the agent's bus id, not in the
workspace and not in the session. It is what a cold-booted agent reconstructs
itself from, which is the whole reason identity must be stable
([CV-R06](./requirements.md)).

Convoy provisions it, and refuses to provision it under a name whose meaning can
change between restarts ([CV-R07](./requirements.md)). The refusal is narrow: the
agent still launches and still gets a bus folder, it simply has no durable
context to misattribute.

## Extension seams

Convoy provides seams for deployment-specific behavior without encoding any
deployment's choices.

- **`bin`** replaces the harness binary while every derived flag survives, so a
  deployment's wrapper is not bypassed
  ([0005](./.decisions/0005-bin-replaces-the-harness-binary.md)).
- **`env`** carries credential selection, so account choice needs no vocabulary
  of convoy's own
  ([0004](./.decisions/0004-credentials-ride-in-env-not-an-account-field.md)).
- **`render`** materializes deployment-owned files alongside an agent.
- **`persona`** overrides the role's default without convoy knowing its content.

Each seam is a value convoy passes through, never one it interprets. That is what
keeps [CV-A03](./requirements.md) satisfiable without convoy acquiring opinions
about policy, telemetry, or credentials.

## Failure posture

Three rules, applied consistently, and each chosen against a plausible
alternative.

**Refuse before writing, never after.** A declaration is validated at declare
time rather than at launch, because the catalog syncs and a late refusal happens
on a different machine than the mistake.

**Contain, do not halt.** A malformed or invalid entry is reported and skipped;
one bad edit never wedges a reconcile ([CV-R14](./requirements.md)). This is why
discovery returns errors and warnings alongside entries rather than throwing.

**Say what is unknown.** A check that could not determine an answer reports
exactly that, never a negative ([CV-R15](./requirements.md)). A convenient
false negative is the failure mode that makes a readiness tool worthless.
