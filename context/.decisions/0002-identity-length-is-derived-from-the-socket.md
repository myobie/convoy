# 0002 — Identity length is derived from the socket, not chosen

Status: accepted

## Context

Identity length needs a bound, and the obvious move is to pick a round number.
The real constraint is not aesthetic. pty binds each session's unix socket at
`<PTY_ROOT>/<session-name>.sock` and validates that path against
`sockaddr_un.sun_path`, taking 104 bytes — the smaller of Darwin's 104 and
Linux's 108 — so that one name works on every machine in a network.

Convoy derives the session name from the identity: `<prefix>.<agentShort>` for
the harness session and `<prefix>.<agentShort>.ding` for the sidecar. So the
budget an identity actually has is whatever the socket limit leaves after the
network's path, the prefix, the longest suffix convoy appends, and the
separators.

This means the bound is **contextual**. A network at `/n` genuinely affords
longer agent names than one at `/home/user/.local/state/convoy/default`. A fixed
constant is either wrong for short paths (needlessly restrictive) or wrong for
long ones (accepts names that cannot bind).

## Options

**A fixed maximum.** Simple and explainable, but necessarily wrong in one
direction, and the direction it is wrong in is the one that fails at spawn time
rather than declare time.

**No bound; let pty fail.** Correct in outcome and terrible in ordering — the
failure arrives at first launch, on the machine that runs the agent, not the one
that named it.

**Derive the budget from the network.** More moving parts, and requires the
network to be resolved before validation, which the declare path already does.

## Decision

`identityByteBudget(ptyRoot, prefix)` computes
`104 − len(ptyRoot) − 1 − len(prefix) − 1 − len(".ding.sock")`, mirroring pty's
own `validateName` exactly rather than approximating it, and the check runs only
when the network context is available. Without that context the length bound is
skipped and says so, rather than substituting a guess.

The longest suffix is used, not the harness session's, because a bound that
admits a name the ding sidecar cannot bind admits a half-working agent.

## Consequences

- An identity convoy accepts is one pty can bind, on either platform.
- The same identity can be valid on one network and invalid on another. This is
  surprising until the error explains it, so the message names the path, the
  budget, and the limit rather than only the length.
- Moving a network to a longer path can invalidate existing names. Discovery
  reports these per file rather than failing the reconcile.
- Convoy mirrors pty's constant rather than importing it, because pty does not
  export it. This is a knowing duplication: the test asserts the boundary
  produces a path of exactly 104 bytes, so a drift in either direction is caught
  by a failing assertion rather than by a spawn failure in production.

## Evidence

- pty's `validateName` and `SUN_PATH_MAX = 104` in its session module, with the
  comment recording the Darwin/Linux choice.
- `src/identity.test.ts` constructs the boundary-length identity and asserts the
  resulting socket path measures exactly the limit, and that one byte more is
  refused.
