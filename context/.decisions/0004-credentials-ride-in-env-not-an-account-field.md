# 0004 — Credentials ride in `env`; there is no `account` field

Status: accepted

## Context

An agent must run as a particular account. Both supported harnesses already
express this the same way: Claude Code relocates its whole configuration —
credentials, settings, skills — via `CLAUDE_CONFIG_DIR`, and codex via
`CODEX_HOME`. Selecting an account *is* selecting a config directory; there is
no separate account identifier the harness understands.

The tempting spec addition is a first-class `account` field, because "which
account" is the question a person actually asks.

## Options

**An `account` field mapped to a config dir.** Reads well and requires convoy to
own a mapping from account names to directories — a lookup that has to live
somewhere, be synced, and be kept in agreement with the directories that
actually exist. It also creates two ways to say the same thing, and therefore a
state where they disagree and one silently wins.

**A `credentials` block.** The same problem in different clothing: a second
vocabulary for a thing the harness already names.

**The env block, which the spec already has.**

## Decision

Credential selection is `CLAUDE_CONFIG_DIR` / `CODEX_HOME` in the spec's `env`
block. There is no `account` field. Convoy reads `CLAUDE_CONFIG_DIR` back out of
`env` to populate the launch spec's config dir, so the derived session manifest
and the declaration cannot disagree — there is one value, read from one place.

Values are written `$HOME`-relative so a spec stays portable across machines,
which is what keeps the catalog machine-agnostic.

## Consequences

- Adding a harness with a different credential mechanism needs no spec change —
  it is another env var.
- Nothing in convoy knows what an "account" is, so nothing in convoy can be
  wrong about it.
- The cost is expressiveness: `env` is untyped, so a misspelled variable is not
  caught. This is the same exposure any env var has, and it is visible in the
  declaration rather than hidden behind a mapping.
- Convoy cannot enumerate accounts or validate that one exists. A deployment
  that wants that owns it, which is consistent with convoy not encoding
  deployment policy.
- Spec `env` is merged *under* derived wiring, never over it, so a declared env
  key cannot repoint an agent at another bus.

## Evidence

- Both harnesses' documented config-relocation variables, already threaded
  through convoy's existing `configDir` handling for Claude.
- `src/agent-spec-file.test.ts` asserts the config dir is derived from `env`
  rather than duplicated, and that derived wiring outranks declared env.
