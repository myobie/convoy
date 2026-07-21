# 0005 — `bin` replaces the harness binary, keeping the derived flags

Status: accepted

## Context

Convoy execs the harness by name: `exec claude …`, `exec codex …`. A deployment
that wraps its harness — for credential selection, persona projection, policy
gates, telemetry — is bypassed entirely by that. The result is that a
convoy-managed session runs *outside* the boundary every other session in that
deployment runs inside, which is the opposite of what an orchestrator should do
to a deployment's invariants.

There is a second, quieter problem. `Harness` is a closed union of `"claude"`
and `"codex"`. A deployment running any other harness has no expressible option
at all.

## Options

**Widen the `Harness` union per harness.** Every new harness is a convoy change,
and convoy acquires opinions about flags it cannot test.

**A full `command` override on the agent.** Maximally flexible and discards the
correct-by-construction property that motivates declaration: an override
re-authors the permission mode, the model flag, and the boot prompt by hand,
which is precisely the class of error convoy exists to remove.

**Replace only the binary name.**

## Decision

An optional agent-level `bin` is used in place of the bare harness name when
deriving the command. Everything else is still derived: the permission posture,
the model flag, the boot prompt, the env, the tags. `harness` continues to
select the *flag shape*, so a wrapper around a Claude-compatible harness sets
`harness = "claude"` and `bin` to the wrapper.

`bin` is charset-validated on the same grounds as the model id: it lands
unquoted inside an `sh -c` string, so it must be a plain path or command name.
Arguments are deliberately not permitted — flags belong to the derived command,
not smuggled through the binary name.

## Consequences

- A wrapped deployment gets convoy-managed sessions inside its own boundary
  without convoy knowing what the wrapper does.
- The closed `Harness` union stops being a hard limit without becoming an open
  set convoy has to reason about: an unlisted harness picks the nearest
  compatible flag shape and points `bin` at itself.
- A wrapper must accept the harness's flags. Convoy cannot verify this, and a
  wrapper that swallows `--permission-mode` produces an agent running under a
  posture nobody declared. This is the accepted cost of not owning the wrapper;
  the alternative was not running inside it at all.
- Because `bin` cannot carry arguments, a wrapper needing fixed arguments must
  be a script rather than a command line. This keeps the launch string
  injection-free.

## Evidence

- The acceptance criteria record the exact anti-pattern this addresses: a
  hand-written manifest pointing at a launcher script, described as the thing
  declaration was meant to eliminate.
- `src/agent-spec-file.test.ts` asserts the binary is replaced while every
  derived flag survives, for both harness flag shapes, and that shell
  metacharacters are refused.
