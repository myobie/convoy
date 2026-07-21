# Supervision — Requirements

## Context

Supervision is the loop that closes the gap between what a network declares and
what a machine runs. Desired state is the catalog, whose format and discovery
belong to [02-agent-spec](../02-agent-spec/requirements.md). Actual state is the
machine-local session registry described in
[01-network](../01-network/requirements.md) (NET-R10). This node owns the
comparison, the plan it produces, and everything that happens when a plan meets a
process that misbehaves.

## Assumptions

Upstream: [CV-A01](../requirements.md) makes the synced directory the
coordination substrate, and [CV-A02](../requirements.md) makes sessions mortal.
This node adds what those imply for the supervisor's own lifecycle.

- **SUP-A01 The synced folder is the scheduler:** No supervisor talks to another
  machine. Each machine's own loop decides what to act on, so there is no
  scheduling authority to elect, fail over, or keep consistent.
- **SUP-A02 Agents outlive their supervisor:** An agent session is a
  long-running process holding real work in progress, and restarting or upgrading
  the supervisor is a routine operation.

## Constraints

- **SUP-C01 Shared on-disk supervision state:** Respawn accounting is exchanged
  with the session runtime through on-disk tags whose wire format is fixed. A
  writer that does not match the reader byte for byte is not interoperable.
- **SUP-C02 Transient liveness reporting:** The session runtime can transiently
  report a session as gone while its process is alive, so a single negative
  liveness reading is not proof of death.
- **SUP-C03 Trust is a shared mutable file:** Harness workspace trust lives in a
  single per-user configuration file that each booting harness reads and rewrites,
  so concurrent writers can lose each other's updates.

## Acceptable Tradeoffs

- **SUP-T01 Decoupled lifecycle:** Stopping supervision leaves agents running,
  trading the convenience of one command that stops everything for the guarantee
  that a supervisor restart never destroys work.
- **SUP-T02 Bounded respawn over unbounded persistence:** A session that fails
  repeatedly and quickly stops being respawned, trading eventual self-recovery for
  protection against a spawn loop consuming the machine.

## Requirements

### Must Reconcile Declaratively

Refines [CV-R10](../requirements.md) — idempotent reconciliation, given the desired/actual split this node defines.

- **SUP-R01 Desired against actual:** Supervision must compute what should run
  from the catalog and what does run from the session registry, and must act only
  on the difference.
- **SUP-R02 Four dispositions:** Every declared agent must resolve to exactly one
  disposition: launch, tear down, adopt, or defer to another host. A declaration
  that resolves to none of these, or to more than one, is a defect.
- **SUP-R03 Planning is pure:** Producing the plan must be a pure function of its
  inputs — no filesystem writes, no process control, no clock — so that any
  desired/actual combination can be exercised in a test without a running network.
- **SUP-R04 Idempotence:** Reconciling twice with no change in desired or actual
  state must produce no second action. An adopted session must remain the same
  process across arbitrarily many reconcile passes.
- **SUP-R05 One loop, two entry points:** Continuous supervision and a
  single-shot pass must drive the same comparison, so that a single pass can never
  behave differently from one iteration of the loop.

### Must Scope Work To This Machine

- **SUP-R06 Host filtering:** An agent runs on the machine its declaration names,
  identified by that machine's short lowercase hostname. A declaration naming no
  host belongs to the machine reading it.
- **SUP-R07 Another host is not an error:** A declaration for a different machine
  must be recorded as deferred and must not be launched, torn down, or reported as
  a problem. The machine it names launches it once the catalog reaches there.

### Must Handle Lifecycle Correctly

Refines [CV-R12](../requirements.md) (death is recoverable) against [CV-C03](../requirements.md) (decommission is an edit).

- **SUP-R08 Decommission by edit:** A declaration marked retired must cause any
  live session for that agent to be torn down and must never be launched. Retired
  and respawn strategy are independent axes, so a retired permanent agent is
  expressible and reconcile reads both signals.
- **SUP-R09 Never relaunch a live process:** A session must be treated as live
  whenever its process is alive, including when the session runtime reports it as
  gone (SUP-C02). Duplicating a running agent is worse than delaying a relaunch.
- **SUP-R10 Death is classified precisely:** Supervision must distinguish a
  session that exited with a recorded status from one that vanished with no exit
  record, and must report which occurred. A death reported as the wrong kind is a
  defect even when the resulting action is the same.
- **SUP-R11 Death is recovered:** A supervised session that dies must be
  re-materialized from its manifest, so that an agent declared to run on a machine
  is running on that machine again without human action.
- **SUP-R12 Bounded respawn:** Repeated fast failures must stop respawn and mark
  the session's state, and the accounting must survive across supervisor restarts
  by living in the shared on-disk state (SUP-C01). A change to a session's command
  must be distinguishable from a repeat of the same failing command.

### Must Not Destroy Work

Refines [CV-R13](../requirements.md) — observation does not destroy.

- **SUP-R13 Stopping supervision detaches:** Stopping or crashing the supervisor
  must leave every session running. Nothing about the supervisor's own lifecycle
  may terminate an agent.
- **SUP-R14 Teardown is explicit:** Exactly one operation terminates sessions,
  and it must be invoked deliberately. It must be able to report what it would do
  without doing it.

### Must Bring Up Cleanly

- **SUP-R15 Trust before spawn:** Every workspace an agent will run in must be
  marked trusted before any agent is spawned, so no agent stalls on an interactive
  trust prompt.
- **SUP-R16 Trust is written once, for everyone:** Pre-trust must be a single
  atomic write covering every workspace in the bring-up, seeded from both running
  sessions and the catalog. A per-agent write cannot satisfy this: a first-ever
  multi-agent bring-up would lose entries to the concurrent-writer race
  (SUP-C03).
- **SUP-R17 Bootstrap is best-effort:** A failure to pre-trust must be reported
  and must not abort the bring-up, because an agent that could have launched must
  not be blocked by a bootstrap convenience.
