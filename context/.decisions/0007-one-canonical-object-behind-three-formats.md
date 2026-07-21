# 0007 — One canonical object behind three formats

Status: accepted

## Context

The agent spec is defined in KDL, TOML, and JSON with "identical semantics". The
claim is easy to state and easy to violate: three parsers, each applying field
rules, will drift, and the drift will be in edge cases nobody writes tests for —
whether a bare node means `true`, whether a repeated block is a list, whether a
missing field is absent or empty.

There is a second problem, and it is worse than an omission. The published
examples are not structurally identical to each other:

- Its **KDL** nests every field under an `agent "<identity>"` node, so identity
  is a positional argument rather than a field.
- Its **JSON** and **TOML** are flat, with `identity` as an ordinary top-level
  key.
- Its **JSON** names the task table `ptys`; its TOML and KDL name it `pty`.

So "three formats, identical meaning" does not survive a literal reading of the
documents that illustrate it. An implementation cannot satisfy all three examples
by decoding to one shape unless it reconciles them explicitly.

## Options

**Three parsers producing the typed object.** The straightforward reading of
"three formats", and the one that makes identical semantics a promise three
implementations have to keep rather than a structural fact.

**Convert KDL and JSON to TOML text, then parse.** Avoids a second semantics
path at the cost of a lossy round trip through a text format, with quoting and
type-coercion failures at every boundary.

**Decode to a common object, then apply semantics once.**

## Decision

Each format decodes to the same canonical plain object, and exactly one function
applies field rules and validation. Format selects the decoder and nothing else;
there is no per-format field handling above the decoding layer. Identical
semantics is therefore structural — a format that decodes correctly is fully
supported by definition.

The KDL mapping is defined explicitly, its load-bearing rule being that a node
with one unnamed argument **and** children treats that argument as a name
segment: `pty "agent" { … }` means `[pty.agent]`. Without that rule the spec's
central construct has no KDL spelling.

Repeated sibling nodes collapse to a list, which is how `[[render.file]]` spells
in KDL; repeated *named* nodes merge into one table, so a table of tables can be
written either way.

Where the published examples disagree with each other, **both spellings are
accepted** rather than one being declared correct. A lone top-level `agent` node
is unwrapped into the flat form, and `ptys` is read as `pty`. Convoy is an
implementation, not the spec's editor; picking a winner unilaterally would
silently invalidate catalogs written against the other published example. The
divergence is reported upstream instead.

## Consequences

- Adding a fourth format is a decoder, not a semantics review.
- The equivalence is testable directly, and is tested by decoding the same
  document in all three formats and asserting the results are equal — rather
  than by three parallel parser test suites that can each be individually right
  and collectively inconsistent.
- KDL requires a parser dependency. `@bgotink/kdl` was chosen for having no
  transitive dependencies, in a package that otherwise has one runtime
  dependency; the alternative pulled in a parser generator.
- The canonical object is untyped, so a typo in a field name is not caught by
  the decoder. It is caught, or ignored, by the single semantics path — which is
  the right place for that decision to be made once.
- The KDL mapping is convoy's design, not the spec's. Until the spec adopts it,
  a different implementation could map KDL differently and still claim
  conformance. This is a gap in the published spec rather than in convoy, and is
  worth proposing upstream.
- Accepting both spellings means convoy cannot detect a spec that mixes them
  incoherently, and it carries two code paths for one concept until the spec
  converges. That cost is deliberate and expected to be temporary; the tests pin
  both so a future convergence is a visible change rather than a silent one.

## Evidence

- `src/spec-format.test.ts` decodes one document in all three formats and
  asserts structural equality, pins each individual mapping rule, and parses the
  published spec's own KDL example verbatim — including its raw-string command
  and its `agent "<identity>"` wrapper.
