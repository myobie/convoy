# convoy — Vision

## The Need

A crew of agents is easy to start and hard to keep. Starting one by hand means
setting an identity, a bus root, a session root, a permission posture, a persona,
a transport, and a set of hooks — and every one of those is a place to be subtly
wrong. A wrong one does not fail loudly; it produces an agent that runs, looks
healthy, and is quietly disconnected from the network it was supposed to join.

The deeper need is continuity. An agent that cannot survive its own restart is a
demo. Sessions end — they crash, they compact, they are killed, the machine
reboots — and if the agent's memory and name die with the session, then every
restart is a cold stranger and nothing long-running is possible. Continuity is
not a feature layered on top of orchestration; it is the property orchestration
exists to protect.

## The Vision

- Convoy is the single front door to an agent network: one tool that stands it
  up, keeps it running, and tells the truth about whether it works.
- An agent is **declared**, not launched. A declaration is durable, reviewable,
  and portable across machines; running is a consequence of a declaration, not
  the act that creates the agent.
- Declaration is **correct by construction**. Convoy takes intent and derives
  every piece of wiring from it, so the categories of misconfiguration that
  motivate the tool are not merely discouraged but unavailable.
- An agent's **name is meaningful and stable**, and the durable state hanging off
  that name outlives any session that used it. A name is also correctable,
  because a name nobody can change is a name nobody chooses carefully.
- Convoy **converges**. It compares what should be running against what is, and
  moves toward the former, repeatedly and idempotently — so recovery is the
  ordinary path rather than a special one.
- Convoy is **honest**. It reports what it verified, distinguishes "not present"
  from "could not verify", and never reports readiness it did not establish.

## What This Is Not

- Convoy is not the bus and not the session manager. It orchestrates them and
  reimplements neither.
- Convoy is not a harness, an agent, or a persona. It does not know what an agent
  should think or do.
- Convoy is not a deployment's policy layer. It provides the seams a deployment
  needs — a wrapped binary, a credential env, a rendered overlay — without
  encoding any particular deployment's choices.
- Convoy is not a scheduler that assigns work. It reconciles declarations; what
  agents do with each other is the network's business.

## Success Criteria

1. An agent declared on one machine runs on the machine it names, without any
   coordination beyond the catalog reaching that machine.
2. A declared agent that is killed at an arbitrary moment converges back to a
   running session on the same identity, with its durable state intact.
3. A name that convoy accepts at declare time is a name every component
   downstream can actually use.
4. Changing an agent's name preserves everything the agent externalized under
   the old one.
5. A green readiness report means an agent can do real work on this machine, and
   a red one names the thing to fix.
