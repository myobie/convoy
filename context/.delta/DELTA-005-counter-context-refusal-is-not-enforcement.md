# DELTA-005 — Refusing to seed durable context does not prevent it

## Contract

[CV-R07](../requirements.md) requires that convoy not provision durable per-agent
state under a name whose meaning can change between restarts, and decision
[0006](../.decisions/0006-counter-named-identities-get-no-durable-context.md)
makes counter-named identities the case that rule exists for.

## Reality

Convoy declines to create `context/` for a counter-named identity, and that is
all it can do. The directory is not convoy's to withhold: `st context write`
creates it unconditionally, `mkdir -p`-style, exactly as the bus's send path
creates an inbox.

Verified directly — writing context as `<host>.worker-2` against a network where
convoy refused to seed the directory produces `context/now.md` anyway.

So a counter-named agent that boots and externalizes work state will create its
own durable context, and a renumbered successor booting under the same name will
read it. The failure decision 0006 describes is narrowed, not closed: convoy no
longer hands a counter-named agent a pre-made place to put memory, but nothing
stops the agent from making one.

## Effect

The guard is a strong default rather than an invariant. An agent that never
writes context is safe; one that does is exposed exactly as before. Because the
refusal is printed at launch, an operator reading the log may reasonably conclude
the case is handled when it is only discouraged.

## Resolution

Enforcement has to live where the directory is created, which is smalltalk.
Either the bus refuses a context write under an identity marked non-durable, or
identities carry a durability flag that `st context write` honors.

Convoy's own step is to stop implying more than it delivers: the refusal message
should say that convoy will not seed durable context under this name, not that
the agent has none.
