# Transports — Requirements

## Context

An agent has to learn that mail arrived. A transport is how a harness process
finds out. The choice is declared as a field on the agent
([02-agent-spec](../02-agent-spec/requirements.md), SPEC-R04) and is realized as
a difference in the set of sessions the agent implies, which is why it is
supervision's input rather than its concern.

## Assumptions

- **TRN-A01 Harnesses differ in what they can serve:** Bus integration is a
  harness capability, not a universal one, so the set of workable transports is a
  function of the harness.
- **TRN-A02 Notification is not delivery:** The bus holds the message; a
  transport only causes the harness to look. A missed notification loses attention,
  not mail.

## Constraints

- **TRN-C01 Restart replays the command, not the environment:** Restarting a
  session preserves its command string and drops its environment, so anything a
  session needs across a restart must live in the command.
- **TRN-C02 One harness has no bus integration:** The `codex` harness offers no
  in-process bus transport.

## Acceptable Tradeoffs

- **TRN-T01 A sidecar per agent:** The notification transport costs a second
  session per agent, trading process count for a mechanism that works with any
  harness regardless of its integration surface.

## Requirements

### Must Define The Transports

- **TRN-R01 Exactly two transports:** An agent uses either the sidecar
  notification transport or the in-process bus transport. Any other value is
  rejected when the agent is declared.
- **TRN-R02 Sidecar transport observes and pokes:** Under the sidecar transport,
  a companion session watches the agent's bus inbox and causes the agent's harness
  session to attend to it when mail arrives. The companion must be a distinct,
  addressable session of the same agent.
- **TRN-R03 In-process transport has no companion:** Under the in-process
  transport, the harness reaches the bus directly and no companion session exists.
  The presence of a companion is therefore a reliable signal of which transport an
  agent runs.

### Must Be Derived, Never Hand-Wired

Refines [CV-R02](../requirements.md) and [CV-T03](../requirements.md) — derived wiring outranks declared wiring.

- **TRN-R04 The transport is derived:** The effective transport of a session must
  be computed from the agent's declaration and its harness. It must not be
  possible to obtain a session whose transport was set by any path other than that
  derivation.
- **TRN-R05 Capability is enforced:** A session must never be launched with a
  transport its harness cannot serve. An agent on a harness with no in-process
  transport (TRN-C02) runs the sidecar transport regardless of what its
  declaration requests.
- **TRN-R06 Unserviceable requests are corrected and reported:** A declaration
  requesting a transport its harness cannot serve must be corrected to the
  serviceable one and the correction must be reported. It must not be a fatal
  error, and it must not be silent.

### Must Survive Restart

Refines [CV-R06](../requirements.md) against [CV-C05](../requirements.md) — a running session carries the wiring it launched with.

- **TRN-R07 Sidecar wiring is restart-durable:** Everything the companion session
  needs to reach the correct network's bus must survive a session restart. Given
  TRN-C01, environment alone does not satisfy this.
- **TRN-R08 Session identity is stable:** An agent's harness session and its
  companion must have ids that are stable across respawns and derivable from the
  agent, so that references to either never drift.
- **TRN-R09 One notification per event:** Notification targeting must address the
  harness session and not the companion, so that a single event produces a single
  notification for an agent rather than one per session.
