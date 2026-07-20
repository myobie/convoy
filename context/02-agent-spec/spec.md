# Agent Spec — Spec

## Scope

This node owns the catalog file format, discovery, identity validation, and the
declare/render/up/rename lifecycle. It does not own where the catalog lives (see
[01-network](../01-network/spec.md)), nor what reconcile does with the
declarations it finds (see [03-supervision](../03-supervision/spec.md)).

## Format decoding

`src/spec-format.ts` makes the format a decoding detail — decision
[0007](../.decisions/0007-one-canonical-object-behind-three-formats.md). Each of
KDL, TOML, and JSON decodes to the same plain-object shape, and exactly one
downstream function — `parseAgentFile` in `src/agent-file.ts` — applies field
semantics. This is the mechanism for SPEC-R02 and SPEC-R03: a format that decodes
to the canonical object is fully supported by construction, and there is no
per-format field handling anywhere above the decoder.

TOML and JSON map to plain objects natively. KDL is a node/argument/property
language rather than a key/value one, so `kdlToPlain` defines the mapping:

| KDL | canonical | TOML equivalent |
| --- | --- | --- |
| `identity "fabric"` | `{identity: "fabric"}` | `identity = "fabric"` |
| `retired #true` | `{retired: true}` | `retired = true` |
| `tags role="agent"` | `{tags: {role: "agent"}}` | `tags = {role="agent"}` |
| `env { A "1"; B "2" }` | `{env: {A: "1", B: "2"}}` | `[env]` |
| `pty "agent" { command "x" }` | `{pty: {agent: {command: "x"}}}` | `[pty.agent]` |
| `file dest="a"` (repeated) | `{file: [{dest:"a"}, …]}` | `[[render.file]]` |

The load-bearing rule is the fifth row. A node with one unnamed argument *and*
children treats that argument as a name segment, which is what gives the spec's
`[pty.<name>]` blocks a KDL spelling. Without it, SPEC-R02 would be false for the
one construct the format cares most about.

Repeated sibling nodes collapse to an array — the `[[render.file]]` shape.
Repeated *named* object nodes merge into one table instead, so a table of tables
has both spellings. The residual once-vs-repeated ambiguity is the same one TOML
has between `[x]` and `[[x]]`, and `asArray` resolves it the same way: by what
the consuming field expects.

## Discovery

`readCatalog` in `src/catalog.ts` walks `catalog/**/*.{kdl,toml,json}`,
depth-limited to refuse symlink loops, sorted for determinism, skipping hidden
entries at every level. The recommended layout is
`catalog/{host}/{identity}/agent.{ext}`, but the rule is deliberately weaker than
the layout, which is what SPEC-R08 requires.

Recognition (SPEC-R11) is two-staged and the staging is the point.
`looksLikeAgentSpec` accepts a document declaring *either* `identity` or `role`;
`parseAgentFile` then requires both. Requiring both to be recognized at all would
mean a spec that misspells or omits one is silently not an agent — a file sitting
in the catalog looking declared while nothing runs and nothing complains.

`pathDefaults` reads segments positionally from the right, popping the filename
(which never supplies a default, per SPEC-R09), then the identity segment, then
the host segment. A deeper tree still resolves the two segments nearest the file.
A directory named for a role is a grouping convention and is exempted from the
identity comparison, so `catalog/workers/…` does not warn on every file beneath
it.

Disagreements (SPEC-R10) warn and content wins. Erroring would strand an agent
over a directory name; silently preferring the path would make one spec mean
different things in different folders. The path default applies only when the
file is silent.

Failures are collected rather than thrown (SPEC-R12): unreadable files, decode
errors, and validation errors each become an entry in the catalog's error list
and discovery continues. Duplicate identities (SPEC-R01) name the file that
declared the identity first. An agent with no supervisor warns unless its role is
`chief-of-staff`, which is the root of the tree.

`host` is lowercased on read. The host filter, the bus id, and the bus folder are
all lowercase, so a hand-authored capitalized host would otherwise never match
its machine and the agent would never launch with no error anywhere.

## Identity validation

`src/identity.ts` composes three bounds from three owners:

- charset and reserved words — smalltalk's `isAgent`, imported rather than
  reimplemented (SPEC-R13, and [CV-C01](../requirements.md));
- length — pty's socket bound, specified in
  [01-network](../01-network/spec.md) (NET-R11 through NET-R13);
- counter shape — convoy's own, since convoy owns what a durable declared name
  means.

Only the third is convoy's to define. Importing the first rather than restating
it is decision [0001](../.decisions/0001-identity-grammar-is-the-buss.md);
deriving the second from the socket is
[0002](../.decisions/0002-identity-length-is-derived-from-the-socket.md).

`identityErrors` returns every reason in the order a reader should fix them, and
is called from `parseAgentFile` — the one function every declaration path funnels
through — which is what makes SPEC-R14 structural rather than remembered. The
supervisor field is validated through the same function, since a typo'd
supervisor silently orphans an agent from its escalation path.

`counterStem` recognizes `<role>-<n>` and the generic stems `agent`, `child`,
`peer`, and `session`; a meaningful stem such as `fabric-2` is a second agent on
a named thing, not the second anonymous worker. `counterContextRefusal` refuses
rather than warns (SPEC-R16) — decision
[0006](../.decisions/0006-counter-named-identities-get-no-durable-context.md).

## Authoring

`convoy add` writes the recommended layout at
`catalog/<host>/<identity>/agent.toml`. TOML is the authored format (SPEC-T01);
KDL and JSON are read, not written. `agentFileToToml` emits only set fields so
the file stays minimal and diffable, and emits `pty` last because TOML tables
must follow every top-level scalar.

`agentFileToSpec` compiles a declaration down to the launch-level spec the
overlay writers consume, defaulting harness to `claude` and transport to `ding`.
Credential selection is read back out of `env` rather than stored separately
(SPEC-R07), so the derived launch artifact and the declaration agree by
construction — decision
[0004](../.decisions/0004-credentials-ride-in-env-not-an-account-field.md).

`bin` substitutes for the harness binary while the derived flags are preserved —
decision [0005](../.decisions/0005-bin-replaces-the-harness-binary.md). It is
charset-validated (SPEC-R06): it is interpolated into a shell launch command, so
it must be a plain path or command name with no whitespace, quotes, or
metacharacters. Arguments belong in the harness's own flags.

## Rename

`src/rename.ts` moves both sides — the catalog entry and the whole bus folder —
which is what makes SPEC-R17 hold; that both halves move and that the tombstone
is convoy's alone is decision
[0003](../.decisions/0003-rename-moves-both-halves-and-tombstones-the-old-name.md).
Moving the bus folder wholesale is why in-flight mail survives: messages sitting
in the inbox travel with the folder and need no special handling precisely
because the move is a move and not a re-creation.

The tombstone is a dotfile marker at the old bus folder. It carries no inbox,
archive, or status beside it, because the bus lists a folder only when one of
those exists and a tombstone carrying them would resurrect the old name in every
agent listing on the network (SPEC-R18). Rename is idempotent by reading its own
tombstone, satisfying SPEC-R20 for a partially completed move.

## Design questions

- Whether redirect resolution belongs on the bus, which would let a peer holding
  a stale name reach the renamed agent instead of manufacturing an unread folder.
