# DELTA-003 — Specs convoy can read but cannot edit

## Contract

[CV-T01](../requirements.md) accepts that convoy reads three formats and writes
one. The tradeoff is stated for the *authoring* path — new declarations are
written in TOML — and does not license operations that silently do nothing.

## Reality

Every operation that edits an existing declaration serializes TOML. For a spec
authored in KDL or JSON, those operations cannot write the file back.

Retirement handles this by not matching non-TOML specs, so `convoy remove`
reports the agent as absent rather than editing it. Rename refuses explicitly,
naming the file and telling the author to edit `identity` by hand. The refusal
is correct; the retirement path's silence is not — "not found" is a misleading
answer to a request about an agent that demonstrably exists in the catalog.

## Effect

An agent declared in KDL or JSON can be discovered, launched, and supervised,
but cannot be retired through convoy, and reports as absent when someone tries.
The author must edit the file by hand, which is precisely the manual editing
declaration exists to remove.

## Resolution

Either serialize each format convoy reads, or make every edit path refuse
explicitly the way rename does — naming the file and the field to change. The
second is cheap and removes the misleading answer; the first removes the gap.
The retirement path should not report "not found" for a spec it found.
