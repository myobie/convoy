# Network — Requirements

## Context

A network is the unit convoy operates on: the boundary that decides which agents
exist, which machine runs them, where their bus lives, and what a name is allowed
to be. Every other subsystem resolves a network first and works inside it.

Two external systems bound this node. The bus namespace and its folder layout
belong to smalltalk. The session-socket namespace belongs to pty, which binds a
Unix-domain socket per session and therefore imposes a hard byte limit that
propagates into what convoy may accept as a name.

## Assumptions

Upstream: [CV-A01](../requirements.md) establishes the synced directory as the
coordination substrate. This node adds the fleet's heterogeneity.

- **NET-A02 Heterogeneous fleet:** A single network spans machines with different
  operating systems, so a name that works on one member must work on all of them.

## Constraints

Upstream: [CV-C02](../requirements.md) bounds identity length by the socket path,
and [CV-C01](../requirements.md) gives the bus ownership of the name grammar.
This node refines the first with the portability rule the fleet imposes.

- **NET-C01 The smaller capacity is the portable one:** `sockaddr_un.sun_path`
  holds 104 bytes on Darwin/BSD and 108 on Linux. Under NET-A02 a name must bind
  on every member of the network, so the applicable capacity is the smaller of
  the two rather than the local machine's.

## Acceptable Tradeoffs

- **NET-T01 Name budget over path freedom:** A network may live at any path, and a
  long path legitimately shrinks the room agents have for names. Convoy reports
  the reduced budget rather than silently truncating names or forbidding deep
  paths.

The catalog's no-delete convergence is [CV-C03](../requirements.md); this node
owns only which of its children that convergence covers (NET-R10).

## Requirements

### Must Define What A Network Is

- **NET-R01 A network is a directory:** Any directory can be a network. Given a
  network directory, every other location convoy uses must be derivable from it
  without additional configuration.
- **NET-R02 Fixed internal layout:** A network directory contains exactly four
  well-known children with fixed meanings: the bus, the machine-local session
  registry, agent workspaces, and the catalog of declared agents. A reader who
  knows the network directory must be able to name all four without inspecting
  convoy's configuration.
- **NET-R03 Named networks share one home:** A network referred to by a bare name
  rather than a path must resolve to a stable per-user location, and networks
  named differently must resolve to sibling directories that never overlap. A
  value containing a path separator must be treated as a path and used verbatim.
- **NET-R04 Zero-config default:** With no network named anywhere — no argument,
  no flag, no environment — convoy must resolve a usable default network, so that
  initializing and bringing up a network requires no configuration.

### Must Resolve Networks Predictably

- **NET-R05 Deterministic precedence:** Network resolution must follow one total
  order: an explicit network argument or flag, then the `CONVOY_NETWORK`
  environment variable, then the network derived from an ambient bus root, then
  the default network. The same inputs must always resolve to the same network.
- **NET-R06 The bus root is not the network root:** The bus-root environment
  variable names the bus, which is a child of the network directory. Any code path
  that recovers a network directory from a bus root must recover the parent, so
  that state written from an ambient environment lands in the network and not
  inside the bus.
- **NET-R07 Environment named by `CONVOY_NETWORK`:** Convoy resolves its network
  from `CONVOY_NETWORK`. The published agent spec writes `$CONVOY_NET` in example
  values; that spelling is example prose, not a variable convoy reads, and convoy
  must not resolve a network from it.
- **NET-R08 Resolution pins the runtime environment:** Once a network is resolved,
  every child process convoy starts must see the bus root and session registry of
  *that* network. An inherited environment pointing at a different network must be
  overridden, never merged.

### Must Keep Networks Isolated

Refines [CV-R18](../requirements.md) — this node states the property; [05-doctor](../05-doctor/requirements.md) proves it.

- **NET-R09 No cross-network effect:** An operation performed against one network
  must produce no observable change in any other network — no session created or
  destroyed, no file written, no bus folder touched. This must be verifiable by
  observing another network before and after the operation.
- **NET-R10 Sync boundary is explicit:** The bus and the catalog are shared state
  and must converge across machines. The session registry is machine-local and
  must never be shared; a session record from one machine must never be
  interpreted as describing another machine's process.

### Must Respect The Name Budget

Refines [CV-R03](../requirements.md) (declare-time validation) against [CV-C02](../requirements.md) (the socket bound).

- **NET-R11 Path length is part of the contract:** The number of bytes available
  for an agent's name is a property of the network, derived from where its session
  sockets land and what prefixes them. Two networks at different paths must
  legitimately report different budgets.
- **NET-R12 Portable acceptance:** A name convoy accepts on any member of a
  network must be bindable as a session socket on every member, including the
  member with the smallest socket-path capacity.
- **NET-R13 Budget failures are declare-time and explanatory:** A name that
  exceeds the budget must be rejected when it is declared, and the rejection must
  state the name's size, the network's allowance, and that shortening the name or
  moving the network to a shorter path both resolve it.
