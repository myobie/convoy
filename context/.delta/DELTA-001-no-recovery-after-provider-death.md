# DELTA-001 — A dead provider is detected but never replayed

## Contract

[CV-R12](../requirements.md) requires that a supervised session which ends
without being asked to is re-materialized from its declaration. Recovery is the
property that makes [CV-A02](../requirements.md) — sessions are mortal —
survivable rather than merely true.

## Reality

The supervisor detects provider death precisely, distinguishing a hard death
with no exit record from an ordinary exit, and reports it as such. It then does
nothing further. The manifest is not replayed and no new session is spawned, so
a hard death leaves the agent permanently absent until something else reconciles
the network.

The detection is the difficult half and it works; the response is missing.

## Effect

An agent whose provider dies hard is gone until the next reconcile pass that
notices it has no session. Where the supervisor is the only thing running, that
is never. The network degrades silently — the agent is not listed as failed,
because from the supervisor's perspective it was correctly identified as dead
and correctly reported.

## Resolution

Replay the manifest on hard death, subject to the flapping cap so a session that
dies on startup does not spin. The cap already exists and already carries the
policy for how many restarts in what window are acceptable.
