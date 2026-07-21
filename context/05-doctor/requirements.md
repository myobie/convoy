# Doctor — Requirements

## Context

Doctor answers one question: can this machine do real agent work? It is the
readiness contract, and it is the first command a newcomer runs and the first
command anyone runs when something is wrong. Its value is entirely in being
believed, which makes honesty a harder requirement than coverage.

Doctor exercises the other subsystems rather than inspecting them. It relies on
the network isolation guarantee of
[01-network](../01-network/requirements.md) (NET-R09) and proves it by
observation.

## Assumptions

- **DOC-A01 A working machine is not a working setup:** Installed binaries,
  present credential files, and a readable configuration do not imply an agent
  can be launched and reached.
- **DOC-A02 The user's real network is precious:** Doctor runs on a machine with
  live agents doing real work, and is expected to be safe to run at any moment.

## Constraints

- **DOC-C01 Credential files outlive credential validity:** A credential present
  on disk can be server-side revoked, so a file or keychain check cannot
  distinguish signed-in from signed-out.
- **DOC-C02 Tooling is not necessarily on the search path:** Agents are wired to
  bus tooling by absolute path, so the absence of a command on the interactive
  search path is not evidence the tooling is absent.
- **DOC-C03 Harness self-diagnostics are unstructured:** A harness's own doctor
  emits human-readable text with no machine-readable output and no documented exit
  code, so there is nothing in it that can reliably gate a decision.
- **DOC-C04 Declaring does not launch:** An agent becomes a process only when
  reconcile acts on its declaration
  ([03-supervision](../03-supervision/requirements.md), SUP-R01).

## Acceptable Tradeoffs

- **DOC-T01 Real work over fast checks:** Doctor spawns real agents and waits on
  real bus traffic, trading runtime for a result that means what it says.
- **DOC-T02 Warnings over false failures:** An unverifiable condition reports as
  unverified and does not fail the run, trading a weaker signal for a report that
  is never wrong.

## Requirements

### Must Prove Real Capability

Refines [CV-R16](../requirements.md) — checks exercise the real path.

- **DOC-R01 End-to-end proof:** Doctor must prove that this machine can stand up
  a network, launch an agent, deliver a message to it, and tear it down — by
  doing each of those things, not by inspecting the conditions for them.
- **DOC-R02 Real lifecycle order:** A check that asserts a live session must
  first declare the agent and then reconcile. Given DOC-C04, a check that asserts
  a session after declaring alone is unsatisfiable on every machine, and such a
  check is a defect in doctor rather than a finding about the machine.
- **DOC-R03 Verified authentication:** Harness authentication must be established
  by an operation that would fail if the credential were invalid. Given DOC-C01,
  the presence of a credential does not satisfy this.

### Must Be Safe To Run

Refines [CV-R18](../requirements.md), proving [NET-R09](../01-network/requirements.md).

- **DOC-R04 Isolated execution:** Every check must run in its own throwaway
  network with its own bus root and session registry, relying on the isolation
  guarantee of NET-R09.
- **DOC-R05 Untouched production gate:** Doctor must observe the user's real
  network before and after the run and must fail if anything changed. An isolation
  breach must be reported as a defect in doctor, not as a problem with the
  machine.
- **DOC-R06 Self-cleaning:** Every throwaway network, session, and configuration
  entry a check creates must be removed when the run ends, including when a check
  fails or aborts.

### Must Be Honest

Refines [CV-R15](../requirements.md) — verified, failed, and undetermined stay distinct.

- **DOC-R07 Three outcomes, not two:** Every check must be able to report pass,
  fail, or could-not-verify. A condition doctor cannot establish must report as
  unverified and must not gate the result.
- **DOC-R08 No false negatives from absent tooling:** Locating supporting tooling
  must use the same resolution agents use, including absolute paths, so that a
  machine whose tooling is off the search path is not reported as missing it
  (DOC-C02).
- **DOC-R09 Unused capability is not a failure:** A harness that is not installed
  must be skipped, and a harness that is installed but not used by this setup must
  not fail the run on its account.
- **DOC-R10 Absence of a network is not a fault:** On a machine with no network
  yet, structural checks must report as not-applicable and must not produce
  failures, so that doctor exits successfully before a network is created.
- **DOC-R11 Advisory legs never gate:** A check whose source cannot be relied on
  for a verdict (DOC-C03) must be reported as advisory and must not affect the
  result.

### Must Be Actionable

Refines [CV-R17](../requirements.md) — failures name their fix.

- **DOC-R12 Every check states what it proves:** A check must name the property a
  pass establishes, so a reader learns what was verified and not merely that
  something passed.
- **DOC-R13 Every failure names its next step:** A failing check must state a
  concrete action that would resolve it. A failure with no next step is an
  incomplete check.
- **DOC-R14 Structural coherence:** Doctor must not be able to pass while its own
  steps are incoherent. A check whose assertions cannot all hold — because it
  omits a required step or asserts a state its steps cannot reach — must be
  detectable without running it against a healthy machine.
