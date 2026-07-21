# convoy — Roadmap

Non-normative future direction. Entries do not constrain implementation until
promoted into requirements, spec, or a decision record.

## Declared tasks and rendered files

The agent spec's `pty` and `render` blocks are the user-extensibility story: a
deployment ships skills, hooks, and extra sessions alongside an agent without
patching convoy. Both are parsed and carried today but not applied
([DELTA-004](./.delta/DELTA-004-declared-pty-and-render-blocks-are-parsed-not-applied.md)).

Applying them raises a design question worth settling before implementing:
whether declared tasks *replace* the derived ones or join them. Replacement is
simpler and discards correct-by-construction for that agent; joining preserves it
but needs a rule for what happens when a declared task collides with a derived
one.

- Trigger: a deployment needs a session convoy has no opinion about, or needs to
  ship files with an agent.
- Promotion target: the agent-spec subsystem spec, plus a decision record for
  the replace-versus-join rule.

## Writing every format convoy reads

Serializing KDL and JSON would close
[DELTA-003](./.delta/DELTA-003-reads-three-formats-writes-one.md) and make every
edit path work on every spec. The cost is three serializers to keep in agreement
with one parser, and format-preserving edits (comments, ordering, style) are
substantially harder than parsing.

- Trigger: specs authored in KDL or JSON become common enough that hand-editing
  them for retirement and rename is a real cost.
- Promotion target: an acceptable-tradeoff revision to CV-T01.

## Redirect resolution on the bus

The cleanest fix for
[DELTA-002](./.delta/DELTA-002-stale-sends-to-a-renamed-identity.md) is for the
bus to resolve tombstones on the send path, since that is where the sends are.
This is a smalltalk change, not a convoy one, but convoy's tombstone format is
the natural thing for it to read.

- Trigger: rename becomes common enough that post-rename stale sends are
  observed rather than theorised.
- Promotion target: an integration constraint in requirements, and removal of
  the delta.

## Reconcile-driven tombstone forwarding

A cheaper, convoy-side narrowing of the same gap: detect resurrected tombstone
folders during reconcile and forward their contents to the current identity.
Turns silent loss into delayed delivery without needing a bus change.

- Trigger: bus-side redirect is not forthcoming and the loss is being observed.
- Promotion target: the supervision subsystem spec.

## Cross-machine convergence for identity changes

If rename becomes a reconcile concern rather than a command
(see [open questions](./open-questions.md)), the same machinery would cover other
identity-affecting edits, and would make rename work uniformly regardless of
which machine issued it.

- Trigger: a network routinely runs agents whose bus folders exist on more than
  one machine.
- Promotion target: the supervision subsystem, or a dedicated child node for
  cross-machine convergence.
