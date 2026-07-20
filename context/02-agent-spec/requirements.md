# Agent Spec — Requirements

## Context

An agent is declared, not launched. The declaration is a file in the network's
catalog, and it is the source of truth for what should exist. This node owns the
file's format, how declarations are discovered, what makes a name legal, and the
lifecycle that carries a declaration from written to rendered to running to
renamed.

The catalog is synchronized state (see
[01-network](../01-network/requirements.md), NET-R10), which sets the severity of
every rule here: a bad declaration does not stay local. It propagates.

## Assumptions

- **SPEC-A01 Hand-authored and generated coexist:** Catalogs contain files
  written by convoy and files written by a person, and both must be first-class.
- **SPEC-A02 Names carry meaning:** An identity is a durable name that context
  and history hang off, not an opaque handle.

## Constraints

Upstream: [CV-C01](../requirements.md) gives the bus ownership of the name
grammar, [CV-C03](../requirements.md) makes the catalog converge by union with no
deletion, and [CV-C04](../requirements.md) establishes that the bus has no
redirect mechanism. This node adds the one constraint the published format
imposes.

- **SPEC-C01 Published interchange formats:** The agent spec defines KDL, TOML,
  and JSON as interchange formats with identical semantics. Convoy cannot make one
  format mean something another cannot express, nor accept a field in one format
  that it rejects in another.

## Acceptable Tradeoffs

Upstream: [CV-T01](../requirements.md) settles reading three formats and
authoring one, and [CV-T02](../requirements.md) settles warning over refusing on
legacy shape. This node applies the second to the catalog's directory layout.

- **SPEC-T01 Warn on path disagreement:** A directory that contradicts a file's
  contents warns rather than errors, trading strictness for the guarantee that no
  agent is stranded by a directory name.

## Requirements

### Must Define One Declaration Format

Refines [CV-R01](../requirements.md) and [CV-R02](../requirements.md) — this node states what the declaration may carry and how the formats relate.

- **SPEC-R01 One file, one agent:** Each agent is declared by exactly one file.
  Two files declaring the same identity within a network is an error and both must
  be reported rather than one silently winning.
- **SPEC-R02 Format-independent semantics:** The same declaration written in KDL,
  TOML, or JSON must produce an identical agent. No field may be expressible in
  one format and inexpressible in another, and no field may mean something
  different depending on the format it was written in.
- **SPEC-R03 Single semantics path:** Field rules, defaults, and validation must
  be applied in exactly one place, so that adding a format cannot introduce a
  behavioral difference and a format-specific bug cannot exist above decoding.
- **SPEC-R04 Declared field set:** An agent-level declaration supports identity,
  role, supervisor, host, workspace, transport, persona, strategy, retired,
  prefix, harness, bin, model, env, and render. An unknown or malformed value in
  any of these must be rejected at parse time with a message naming the field and
  the accepted values.
- **SPEC-R05 Sessions are tasks of the agent:** An agent may declare child
  session blocks carrying an id, command, working directory, tags, environment,
  and a garbage-collection exemption. When none are declared, convoy must derive
  the agent's sessions from its agent-level intent, so that a correct declaration
  requires no session-level detail.
- **SPEC-R06 Wrapper command substitution:** A declaration may name a command to
  run in place of the bare harness name. When named, convoy must use it wherever
  it would otherwise use the harness name, so that a deployment which wraps its
  harness has no session running outside that wrapper.
- **SPEC-R07 Credentials ride in environment:** Account and credential selection
  is expressed through the agent's environment, written relative to the home
  directory so one declaration is machine-agnostic. There is no separate account
  field, and no second place where an account can be named.

### Must Discover Declarations Robustly

Refines [CV-R14](../requirements.md) — containment of one bad declaration, applied to catalog discovery.

- **SPEC-R08 Recursive discovery:** Discovery must find declarations anywhere
  beneath the catalog, at any depth and under any filename, provided the file
  carries a recognized format extension.
- **SPEC-R09 Identity comes from content:** The identity of an agent is the
  identity its file declares. Moving or renaming a file must not rename, duplicate,
  or orphan an agent.
- **SPEC-R10 Path supplies defaults only:** Directory names may supply defaults
  for fields the file omits. When a directory and the file's contents disagree,
  the contents must win and the disagreement must be reported.
- **SPEC-R11 Claim before completeness:** A file declaring either an identity or
  a role is claiming to be an agent spec; missing the other field is a validation
  error against that claim. A file declaring neither is not a spec and must be
  skipped without comment.
- **SPEC-R12 One bad file is not a wedged catalog:** A malformed, unreadable, or
  invalid declaration must be reported and skipped, and every other declaration in
  the catalog must still be discovered.

### Must Constrain Names

Refines [CV-R04](../requirements.md), [CV-R03](../requirements.md), and [CV-R07](../requirements.md) — the grammar, when it is checked, and which names may hold durable state.

- **SPEC-R13 One identity grammar:** An identity convoy accepts must be an
  identity the bus accepts: lowercase letters, digits, `.` and `-`, beginning and
  ending alphanumeric, no underscore, and none of the reserved bus names. Convoy
  must not define a second grammar that could disagree.
- **SPEC-R14 Validation at declare time:** Every identity — an agent's own and
  the supervisor it names — must be validated at the moment it is declared, not at
  the moment it is used, because an invalid name that reaches the catalog has
  already propagated to every peer.
- **SPEC-R15 Network-scoped uniqueness:** Identities must be unique within a
  network rather than within a machine, since the catalog is shared.
- **SPEC-R16 Counters get no durable memory:** An identity of the form
  `<role>-<n>` names a position, not an agent, and re-derives to a different agent
  across parent lifetimes. Convoy must refuse to create durable per-agent context
  under such an identity, and the refusal must explain that a meaningful name
  resolves it.

### Must Support Correction

Refines [CV-R08](../requirements.md), [CV-R09](../requirements.md), and [CV-R11](../requirements.md) — rename, stale references, and completable partial changes.

- **SPEC-R17 Rename preserves continuity:** Renaming an agent must move both its
  declaration and its entire durable bus presence — context, decisions, archive,
  inbox, and status — so that mail in flight at rename time is delivered under the
  new name and nothing the agent externalized is orphaned.
- **SPEC-R18 Rename is diagnosable, not redirecting:** A renamed-away identity
  must leave a marker that convoy resolves for listing, uniqueness, and rename
  idempotency. Because the bus has no redirect mechanism
  ([CV-C04](../requirements.md)), a peer holding
  the old name and sending to it creates an unread folder; convoy must make that
  situation visible rather than claim to prevent it. The marker must not cause the
  old name to reappear in bus agent listings.
- **SPEC-R19 Removal is an edit:** Because the catalog converges by union
  ([CV-C03](../requirements.md)), decommissioning an agent must be expressed as a change to its
  declaration rather than as a file deletion.
- **SPEC-R20 Rerunnable declaration:** Declaring, rendering, and renaming must be
  safe to re-run. A partially completed operation must complete on a second run
  rather than fail or duplicate work.
