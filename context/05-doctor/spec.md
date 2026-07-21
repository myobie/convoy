# Doctor — Spec

## Scope

This node owns the readiness suite: its isolation harness, the shape of a check,
the honesty rules, and the gates. It does not own the subsystems it exercises; it
consumes them through the same command surface a user does.

## Shape of a check

A check reports a name, a verdict, a detail line, an optional fix, and an
optional advisory note. Structural checks additionally carry what a pass proves,
which is the mechanism for DOC-R12 — the property is authored beside the
assertion, so a check cannot exist without stating what it establishes.

Verdicts are three-valued (DOC-R07). A boolean carries pass and fail; `null`
carries could-not-verify. Only `false` gates the result, so an unverifiable
condition is visible without being fatal (DOC-T02). The advisory field is the
same idea one level down: a note attached to a passing check, so a partial result
is reported honestly without turning the run red.

## Isolation harness

`makeSandbox` creates a throwaway network under a short temporary base and
returns an environment with the bus root, session registry, and network variable
all pinned into it (DOC-R04). Because every check runs convoy as a subprocess
with that environment plus an explicit network argument, the isolation is
established by the same resolution precedence specified in
[01-network](../01-network/spec.md) (NET-R05, NET-R08) rather than by a
doctor-specific mechanism.

Sandbox paths are length-guarded at 70 bytes for the session registry, because
the socket-path budget of NET-R11 applies inside a sandbox exactly as it does in
a real network. Exceeding it fails with an actionable message naming the
temporary directory as the thing to shorten, rather than surfacing as an opaque
bind failure inside a check.

Cleanup (DOC-R06) is per-check plus an end-of-suite sweep over every sandbox the
run created, so a check that aborts before its own teardown still leaves nothing
behind. Trust entries written during a run are removed for both harnesses on the
same path.

## The untouched-network gate

The suite snapshots the user's real session registry before the run and again
after it, and asserts an empty delta in both directions (DOC-R05). Added and
removed session names are both reported, since a leaked spawn and a leaked
teardown are equally isolation breaches.

The gate's failure text names it as an isolation breach to be filed as a bug.
This is deliberate: DOC-R05 is doctor auditing itself, and reporting it as a
machine problem would send the reader to fix the wrong system.

Sessions whose metadata lingers after exit are excluded from the snapshots, since
counting them would false-positive both the teardown check and the delta gate.

## Lifecycle order

Every spawning check follows the same sequence, which is the direct expression of
DOC-R02:

```text
convoy init      → the sandbox network exists
convoy add       → the agent is DECLARED (this does not launch it)
convoy up --once → reconcile turns the declaration into a session
assert           → the session is live / reached available / received mail
```

The reconcile step is not optional and is not an implementation convenience.
Under DOC-C04 a declaration is inert, so a check that asserts a live session
without reconciling asserts something no healthy machine can satisfy — it would
fail by construction everywhere, which is a defect in the check rather than a
finding. Each step reports its own failure with its own fix, so a break is
attributed to the operation that broke rather than to the assertion downstream of
it.

The suite layers proofs on this spine: a single agent standing up and tearing
down; inbox and notification delivery end to end; a multi-tier organization
delegating and producing a graded fix against a bundled bug.

## Structural coherence

DOC-R14 is satisfied by making the suite's own steps inspectable rather than by
trusting review. A check's step sequence is data a test can assert over, so the
omission of a reconcile step before a session assertion is caught by doctor's own
tests. The rule this encodes: a check that cannot pass on a healthy machine is a
defect in doctor, and doctor must not be able to ship it.

## Authentication probe

`src/doctor/auth.ts` makes a real minimal harness call rather than reading a
credential. Under DOC-C01 a revoked token still decodes locally, so the harnesses'
own status commands — which decode the cached credential without contacting a
server — report signed-in while real calls fail. A small headless invocation
either succeeds or returns the not-signed-in signal.

The signal is normalized to four values and classified by a pure function, so
every outcome is testable without real credentials:

| Signal | Meaning | Verdict |
| --- | --- | --- |
| `live` | a real call succeeded | pass |
| `signed-out` | a clear not-signed-in or unauthorized response | fail when required, warn otherwise |
| `unavailable` | the harness is not installed | skipped |
| `inconclusive` | a network or timeout error, unattributable to auth | fail as unverified |

The `required` input carries DOC-R09: a harness this setup does not use, merely
installed and signed out, warns rather than fails. Failures name the exact
re-login step for that harness (DOC-R13).

## Locating supporting tooling

Bus tooling is resolved in the same order the agents use — the tooling directory
variable, then the absolute binary path baked into the wired hooks, then a search
of the interactive path (DOC-R08). Agents are wired by absolute path, so a
machine whose bus binary is off the search path is correctly wired and would be
false-failed by a path-only check.

When the tooling cannot be located, `hooksNotLocated` returns a non-blocking
could-not-verify state rather than asserting absence. A failure to locate is not
proof of absence, and doctor does not say untrue things.

The hook checks that follow prove three properties: both hook files are present;
both parse under the real system shell; and the entry shim, run beside a
deliberately broken implementation in a throwaway directory, still exits zero.
The third is the important one — it proves that a future break in the
implementation cannot block compaction — and it never touches the real files.

## Non-gating legs

Structural checks short-circuit to a single not-applicable line when the target
network has neither a config nor a bus directory, so a machine before its first
network exits successfully (DOC-R10). A partial network does not short-circuit:
it falls through to the checks, where the missing config is reported with its
fix. The short-circuit deliberately does not key on the network directory
existing, because pinning the session registry can create a child of it as a side
effect, making mere existence a false positive.

Harness self-diagnostics run read-only and time-guarded, and are reported as
advisory only (DOC-R11). Under DOC-C03 there is nothing in their output to gate
on. Verbose output with a few buried warnings is distilled through that harness's
own headless invocation, falling back to the raw text when the distillation fails
or times out, so a slow or failed distillation never stalls the run.

## Design questions

- Whether the untouched-network gate should extend beyond the session registry
  to the bus and catalog, so a leaked catalog write is caught by the same gate
  that catches a leaked spawn.
