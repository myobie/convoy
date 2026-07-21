# Network — Spec

## Scope

This node owns network layout, network resolution, the isolation boundary, and
the identity byte budget that the layout imposes. It does not own what a catalog
file means (see [02-agent-spec](../02-agent-spec/spec.md)), nor how declared
agents become running sessions (see [03-supervision](../03-supervision/spec.md)).

## Layout

`networkLayout()` in `src/paths.ts` maps a network directory to its bus, session
registry, and worktrees; `catalogDir()` in `src/agent-file.ts` supplies the
fourth child. Every wiring site derives paths from these rather than joining
strings independently.

```text
<net>/
  smalltalk/    # the bus — ST_ROOT points HERE, not at <net>. Synced.
  catalog/      # declared agents. Synced.
  pty/          # session registry — PTY_ROOT. Machine-local.
  worktrees/    # agent workspaces.
```

The split realizes NET-R10. `smalltalk/` and `catalog/` sit inside the sync
boundary; `pty/` and `worktrees/` sit outside it. The catalog is what makes
"declare on machine A, run on machine B" work without an RPC layer: the synced
folder *is* the scheduler.

`stRootOf(dir)` produces the bus root; `networkDirOfStRoot()` is its inverse. The
inverse is not a convenience — it is the enforcement point for NET-R06. It treats
a value whose last segment is `smalltalk` as a bus root and returns its parent,
and treats anything else as an already-network directory. A network literally
named `smalltalk` still resolves: its bus root is `<home>/smalltalk/smalltalk`,
whose parent is the correct `<home>/smalltalk`.

## Named networks and the default

`convoyHome()` returns `($XDG_STATE_HOME | ~/.local/state)/convoy`. Named
networks are its direct children, which is what makes NET-R03's non-overlap
structural rather than checked.

`isNetworkName()` discriminates a bare name from a path with
`/^[A-Za-z0-9][A-Za-z0-9._-]*$/` plus a separator check, so `default` and
`my-net` are names while `/tmp/n`, `./n`, `~/n`, and `../n` are paths.
`DEFAULT_NETWORK_NAME` is `default`, and `defaultConvoyNetwork()` resolves
`<home>/default` as the last-resort fallback for NET-R04. Standalone smalltalk
keeps its own default bus location; this fallback changes only how convoy
resolves a network when nothing else names one.

## Resolution

The precedence chain of NET-R05 is implemented once per entry point and reads the
same order everywhere: explicit `<network>` argument or `--network`, then
`CONVOY_NETWORK`, then `networkDirOfStRoot(ST_ROOT)`, then
`defaultConvoyNetwork()`.

`CONVOY_NETWORK` carries the network *directory*, and `convoy env` / `convoy
shell` export it alongside `ST_ROOT` and `PTY_ROOT` so an interactive shell and
convoy agree on the same network. Because the exported triple is derived from one
resolved directory, the three values cannot disagree.

NET-R08 is realized by pinning rather than defaulting: the resolved network's
`pty/` is written into the child environment unconditionally, so an ambient
`PTY_ROOT` left over from another network is replaced rather than inherited. The
same applies to `ST_ROOT`.

## Isolation

Isolation (NET-R09) is a property of the layout — nothing outside a network
directory is written during a network operation — but it is only *proved* by
observation. The proof lives in [05-doctor](../05-doctor/spec.md), which runs
checks in throwaway networks and asserts a zero delta against the untouched
network. That gate is what turns NET-R09 from an intention into a verified
invariant.

## The identity byte budget

`identityByteBudget(ptyRoot, prefix)` in `src/identity.ts` computes NET-R11
directly:

```text
budget = SUN_PATH_MAX - len(ptyRoot) - 1 - len(prefix) - 1 - len(".ding.sock")
```

`SUN_PATH_MAX` is 104 — the Darwin/BSD figure, chosen over Linux's 108 to satisfy
NET-R12 (NET-C01). pty applies the same bound in its own session-name validation,
and convoy mirrors it exactly rather than picking an independent number, so an
identity convoy accepts is one pty can bind.

The longest suffix is `.ding.sock`, because the longest path any declared agent
produces is the ding sidecar's socket:
`<PTY_ROOT>/<prefix>.<agentShort>.ding.sock`. Budgeting against the *longest*
derived session, not the harness session, is what makes acceptance safe for every
session an agent implies. The transport that produces that sidecar is specified
in [04-transports](../04-transports/spec.md).

A trailing separator on `ptyRoot` is stripped before measuring, because path
joining collapses it and measuring the unjoined form is off by one.

The budget is enforced at declare time by `identityErrors()`, which reports the
name's byte length, the network's allowance, the exact socket path template, and
the limit — satisfying NET-R13. The charset and reserved-word half of that check
belongs to smalltalk and is specified in
[02-agent-spec](../02-agent-spec/spec.md) (SPEC-R12); this node owns only the
length bound.

## Design questions

- Whether a network should record its own budget in its config so that a name
  accepted on the declaring machine is provably acceptable on a peer whose path
  to the network differs.
