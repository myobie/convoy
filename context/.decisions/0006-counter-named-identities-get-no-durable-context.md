# 0006 — Convoy does not seed durable context for counter-named identities

Status: accepted

## Context

`context/now.md` is the memory a cold-booted agent reconstructs itself from. It
is addressed by identity, and it outlives every session that wrote it. That is
only safe if the identity means one agent for as long as the file exists.

A `<role>-<n>` counter does not have that property. The counter re-derives within
a single parent's lifetime, so restarting the parent renumbers its children. The
`worker-2` that boots tomorrow is a different agent from the `worker-2` that
booted today, and it will open today's `now.md` and treat it as its own memory.

The failure is silent, arrives long after the naming choice, and is
indistinguishable from the agent having done the work itself — it reads a
stranger's work state and acts on it.

## Options

**Warn at declare time.** The warning is read at the moment the name is chosen
and not at the moment the wrong file is opened, weeks later, by a different
process. Warnings do not prevent this class of failure; they annotate it.

**Ban counter-shaped identities entirely.** Overreaches. A short-lived
counter-named agent is fine — it is the *durable state* that is unsafe, not the
name. Banning the name breaks ad-hoc use for a problem that only exists when
memory is involved.

**Refuse the durable state, not the name.**

## Decision

Convoy refuses to provision `context/` under a counter-named identity. The agent
still launches and still gets a bus folder; convoy simply does not hand it a
pre-made place to put durable memory. The refusal is printed with the reason,
naming the inheritance failure rather than only the rule.

**This is a strong default, not an invariant.** The directory is not convoy's to
withhold — `st context write` creates it unconditionally, so an agent that
externalizes work state makes its own. Preventing that requires enforcement where
the directory is created, which is the bus. See
[DELTA-005](../.delta/DELTA-005-counter-context-refusal-is-not-enforcement.md).

A counter is recognised as a trailing number on a stem that is a role name, a
role alias, or one of a small set of generic words (`agent`, `child`, `peer`,
`session`). Meaningful discriminators are unaffected: `fabric-2` is a second
agent working on a named thing, not the second anonymous worker. The harness
suffix is stripped first, so `worker-2-claude` is recognised as the counter it
is.

## Consequences

- The unsafe case is narrowed rather than eliminated. Convoy no longer creates
  the inheritable artifact, which removes the case where an agent finds one
  waiting for it; an agent that writes its own is still exposed.
- Counter-named agents remain usable for exactly the work they are suited to:
  ephemeral, fan-out, no memory.
- The stem list is a judgement call and can be wrong in both directions. A
  meaningful stem that happens to be a role word loses durable context; a
  counter with an unusual stem keeps it. The list is exported so the check and
  any documentation of it cannot drift, and erring toward the small list keeps
  false refusals rare.
- An agent that would have externalized state must be given a meaningful name
  first. This is the intended pressure: the name is the thing that makes the
  memory addressable, so choosing one is the price of having memory.

## Evidence

- `src/identity.test.ts` asserts recognition across every role name and alias,
  through the harness suffix, and asserts that meaningful discriminators are
  left alone and that the refusal does not make the identity undeclarable.
