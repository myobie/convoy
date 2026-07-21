# Transports — Spec

## Scope

This node owns the two transports, their derivation, and the sessions each
implies. It does not own the field that declares one (see
[02-agent-spec](../02-agent-spec/spec.md)), nor the reconcile that launches the
resulting sessions (see [03-supervision](../03-supervision/spec.md)).

## The two transports

`Transport` is the closed union `"mcp" | "ding"` and `Harness` is
`"claude" | "codex"`, both in `src/agent-spec.ts`. The declared value is
validated when the agent is parsed, so TRN-R01 is enforced at declare time
alongside every other enum.

**`ding`** — the sidecar transport. The agent's workspace overlay declares a
second session beside the harness session, running `st ding <harness-session>
--identity <bus-id> --root <st-root>`. That process watches the identity's inbox
on the bus and pokes the named harness session when mail arrives. Watching runs
in the bus's own runtime binary, which is what makes the transport independent of
the harness's integration surface (TRN-T01).

**`mcp`** — the in-process transport. The harness talks to the bus itself, and
the overlay declares only the harness session. The absence of a companion is
therefore load-bearing rather than incidental, which is what TRN-R03 states.

## Derivation

One rule decides the effective transport, and it is stated twice in two
complementary positions:

```text
effectiveTransport = harness === "codex" ? "ding" : declaredTransport
```

`preflight` in `src/agent-spec.ts` computes it for the reported and tagged value,
so what an operator is shown is the transport that will actually run. `usesDing`
in `src/launch.ts` expresses the same rule as a predicate — `harness === "codex"
|| transport === "ding"` — and every session-writing path in `writePtyToml`
consults it rather than reading the declared field. This is the mechanism for
TRN-R04 and TRN-R05: there is no code path from a declaration to a launched
session that bypasses the derivation, so an unserviceable combination cannot
reach a spawn.

The correction is reported, not thrown (TRN-R06). Requesting the in-process
transport on `codex` emits `codex has no MCP transport — it always runs
ding-mode; ignoring --transport mcp` and proceeds with the sidecar. The effective
transport is also written into the derived session's tags, so an operator reading
a live session sees what it actually runs rather than what was asked for.

The declaration default is `ding`, applied when compiling a declaration down to a
launch spec.

## Session identity

Session ids derive from the agent (TRN-R08): the harness session is
`<prefix>.<agentShort>` and the companion appends `.ding`, giving
`<prefix>.<agentShort>.ding`. `agentShort` strips a trailing harness suffix from
the identity so the id names the agent rather than the tool. Both ids are stable
across respawns, which is what lets the companion's command reference the harness
session by name without the reference going stale.

These are the ids whose socket paths consume the name budget specified in
[01-network](../01-network/spec.md); the companion's `.ding.sock` is the longest
suffix the budget accounts for, which is why the budget is computed against the
sidecar rather than the harness session.

## Restart durability

`dingCommand(busId, harnessSessionId, root)` bakes `--root <st-root>` into the
command string rather than relying on `ST_ROOT` in the session's environment.
Under TRN-C01 a restart replays the command and drops the environment, so an
environment-only wiring survives the first launch and silently loses its network
on the first restart — the companion then watches the wrong bus, or none, and the
agent stops being notified with nothing failing. Baking the root into the command
is the whole of TRN-R07, and it is why the command string is the durability
engine for this transport.

`regenerateDingRoot` upgrades an overlay whose companion command lacks `--root`. It
recovers the network from the session's own `ST_ROOT` environment value or its
`st.network` tag, rewrites only the companion's command string, and leaves the
rest of the file byte-for-byte untouched. It is idempotent — a command that
already carries `--root` produces no change — and refuses to act when the network
cannot be recovered, rather than emitting a guessed root. A dry run computes the
difference without writing.

## Notification targeting

Crash-notification tags are written on the harness session only, never on the
companion (TRN-R09). Tagging both would cause one event to notify the same bus
identity twice, since the two sessions share it. The companion runs the bus's
watch command and reads no such tags itself, so it has no use for them.

## Design questions

- Whether the in-process transport should be capability-detected from the
  harness at launch rather than keyed on the harness name, so a harness that
  gains bus integration needs no change here.
