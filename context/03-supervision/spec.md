# Supervision — Spec

## Scope

This node owns reconcile, teardown, death handling, respawn bounding, and
bring-up pre-trust. It does not own the format of the declarations it reads (see
[02-agent-spec](../02-agent-spec/spec.md)), nor which sessions an agent implies
(see [04-transports](../04-transports/spec.md)).

## The reconcile core

`reconcilePlan` in `src/reconcile.ts` is the pure function SUP-R03 requires. It
takes catalog entries, observed sessions, this machine's short hostname, and an
injected accessor that extracts a session's bus id, and returns a plan with
exactly the four buckets of SUP-R02:

```text
launch     — active, this host, not running
teardown   — retired, this host, with live sessions
adopt      — active, this host, already alive
otherHost  — declared for a different machine
```

The bus-id accessor is injected rather than imported so the module carries no
dependency on the supervisor that executes its plans, which is what keeps it
testable without a running network.

`agentBusId` compiles a declaration to `<host>.<identity>`, defaulting the host
to this machine. That id is the join key: it is what a running session carries as
its bus agent, so matching desired to actual is an equality check on one derived
string rather than a heuristic.

Both continuous supervision and the single-shot pass call this one function
(SUP-R05). Continuous supervision drives it from a filesystem watch on the
catalog plus a timer; the single-shot pass drives it exactly once.

## Host filtering

The filter key is the short lowercase hostname (SUP-R06). Declarations lowercase
their host on read, specified in [02-agent-spec](../02-agent-spec/spec.md), so
the comparison is a plain equality and a hand-authored capitalized host cannot
silently fail to match.

Deferral is a bucket, not a skip (SUP-R07). Recording other-host entries rather
than dropping them is what lets an operator see that a declaration was read,
understood, and correctly not acted on — the difference between "not mine" and
"not found".

## Liveness

`liveOf` treats a session as live when it is not reported gone, or when it is
reported gone but its process id is still alive. This realizes SUP-R09 against
SUP-C02: the runtime can transiently report gone under load, and relaunching on
that reading would duplicate a running agent.

Retirement (SUP-R08) is read before liveness. A retired declaration with live
sessions goes to teardown; a retired declaration with none is a no-op. Retirement
and respawn strategy are separate fields precisely so reconcile can read two
orthogonal signals rather than overload one.

Retirement is an edit rather than a deletion because the catalog converges by
union — the constraint is stated in
[CV-C03](../requirements.md) and applied by
[02-agent-spec](../02-agent-spec/requirements.md) (SPEC-R19).

## Death and recovery

Death classification (SUP-R10) distinguishes a `vanished` session — the daemon
died with no exit record — from an `exited` session with a nonzero code, and
reports the distinction in its message: `vanished (hard death — no exit record)`,
a killed-with-no-exit-code reading, or the concrete exit code. The classifier is
a pure predicate over status and exit code, so every branch is exercisable
without killing a real process.

Recovery (SUP-R11) re-materializes the dead session from the manifest that
launched it, so that recovery is a repeat of the original launch rather than a
second code path that can drift from it. Which artifact serves as that manifest
is a design question below.

## Bounded respawn

`src/flapping-cap.ts` implements the respawn bound of SUP-R12 as pure functions
over the session's `strategy.*` tag state — no I/O and no clock, so every branch
is unit-testable and the contract is independent of how convoy talks to the
session runtime.

The tag keys are the shared wire format of SUP-C01 and are fixed:
`strategy.consecutive-fast-fails`, `strategy.last-respawn-at`,
`strategy.command-hash`, `strategy.status`, `strategy.fast-fail-window`, and
`strategy.fast-fail-limit`. The defaults are a three-failure limit inside a
sixty-second window, each overridable per session by its own tag. Crossing the
limit sets the status to `flapping`.

`strategy.command-hash` is what distinguishes a changed command from a repeated
failing one: a new command hash resets the consecutive-failure count, so
correcting a broken command restores respawn without an operator clearing state
by hand.

Respawn state lives on disk rather than in the supervisor's memory, which is what
lets the accounting survive the supervisor restart that SUP-A02 assumes is
routine. The supervisor separately remembers permanence in memory, because
terminating a session strips its strategy tag.

## Lifecycle decoupling

Supervision shutdown never terminates sessions (SUP-R13). Stopping the supervisor
reports how many sessions it is leaving running and exits. This is the whole of
SUP-T01: an operator restarting or upgrading supervision does not weigh that
against losing in-flight agent work.

Teardown is one operation (SUP-R14). It enumerates live agent sessions for the
network, terminates each, and reports the count. Sessions whose metadata lingers
after exit are excluded from the plan, because terminating an already-dead
session would fail and mis-report a clean teardown as a failure. A dry run prints
the same plan without acting. Teardown suppresses respawn for what it terminates,
since reconcile would otherwise restore the permanent sessions it just removed.

## Bring-up pre-trust

`src/trust.ts` marks agent workspaces trusted in the harness's per-user config
before any agent boots (SUP-R15), so no agent stalls on an interactive
workspace-trust prompt with nothing to answer it.

The write is a single atomic read-modify-write covering every workspace in the
bring-up (SUP-R16). A per-agent write cannot win the race SUP-C03 describes: the
Nth agent's booting harness reads the config before the (N+1)th entry exists,
then flushes its stale copy over it. The only ordering that survives is every
entry present before any harness boots. Both the supervisor's bring-up and the
standalone pre-trust command go through the same batch function, so the two
layers share an identical write.

Entries are keyed on the workspace's real path, because that is the canonical
path the harness looks up; keying on a literal path containing a symlink would
mismatch and the prompt would still appear. The write is temp-plus-rename to
shrink the window for clobbering a concurrent harness write, and it is
best-effort (SUP-R17): a failure is reported and returned, never thrown.

The seed set is the union of running sessions' workspaces and the catalog's
declared workspaces. Seeding from sessions alone would miss a first-ever bring-up
where nothing is running yet — which is exactly the case the batch exists to
protect.

## Design questions

- Which artifact is authoritative as the recovery manifest: the workspace
  overlay's session file, the declaration it was compiled from, or the tags the
  live session carried.
- Whether the supervision tree implied by the `supervisor` field should
  constrain launch ordering, so that an agent's escalation path is live before
  the agent that depends on it.
