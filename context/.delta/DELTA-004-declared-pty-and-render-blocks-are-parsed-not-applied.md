# DELTA-004 — Declared `pty` and `render` blocks are parsed but not applied

## Contract

The agent spec states that an agent is the job and its `pty` blocks are the
tasks, and that a `render` block materializes extra files into the workspace so
a deployment can ship skills and hooks alongside an agent without patching
convoy.

## Reality

Both blocks are decoded, validated, carried on the parsed spec, and round-trip
through the writer. Neither is acted on. Rendering still derives the session
manifest entirely from agent-level intent, ignoring any declared `pty` tasks,
and writes no files from `render`.

The parsing is not speculative — it is what lets a spec authored against the
published format survive a read/write cycle without losing fields. But a
deployment that declares tasks or files today sees them preserved and not
honored.

## Effect

A spec can declare a task that never runs and a file that never appears, with no
error. That is the same silent-divergence failure mode the correct-by-
construction property exists to prevent, in a new place: the declaration and the
running system disagree, and nothing says so.

## Resolution

Either apply both blocks — declared tasks joining the derived ones, `render`
sources resolved relative to the spec file and destinations relative to the
workspace with placeholder substitution — or report a declared-but-unapplied
block as a warning at discovery so the divergence is at least visible.

The warning is the smaller step and should not be skipped if application is
deferred: a field that is silently inert is worse than one that is rejected.
