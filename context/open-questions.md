# convoy — Open Questions

Unresolved design uncertainty. Each entry names what would settle it.

## Tombstone retention

Tombstones accumulate: every rename leaves one, permanently, and nothing prunes
them. They are cheap individually, but they are also the reason a renamed-away
name can never be reused, and an unbounded set of reserved names on a long-lived
network is its own problem.

The question is what the retention rule should key on. Age is the obvious answer
and probably the wrong one — a stale reference does not expire on a schedule,
and the whole point of the tombstone is the reference that has not caught up.
Something closer to "no peer has addressed this name in N reconciles" would be
right, but convoy does not observe sends and so cannot measure it.

Blocker: convoy has no visibility into whether anything still holds the old
name. Resolving this likely depends on the same bus-side redirect support that
[DELTA-002](./.delta/DELTA-002-stale-sends-to-a-renamed-identity.md) needs, which
would put the observation where the sends are.

## Supervisor as a first-class relationship

`supervisor` is declared, validated as an identity, and otherwise inert. The
supervision tree is not built from it, and crash notification is derived from
tags on the running session instead.

Two things are unclear. Whether the declared supervisor should *become* the
crash-notification target, replacing the tag-derived one — which would make the
escalation path a property of the declaration rather than of whoever happened to
spawn the agent. And what a declared supervisor that does not exist, or exists
on another machine, should mean at reconcile time.

Resolving this needs a position on whether the supervision tree is a real
structure convoy maintains or a convention agents observe among themselves.

## Ad-hoc sessions

There is no supported path for a session that is not a declared catalog member.
A deployment retiring its own launcher aliases needs somewhere for one-off
sessions to go.

The uncertainty is not whether to have one but what it means for the invariants.
An ad-hoc session has no declaration, so it cannot be reconciled, cannot be
recovered, and cannot be adopted — it is outside every property this VRS
promises. Whether that is acceptable as an explicit escape hatch, or whether an
ad-hoc session should instead be a declaration marked ephemeral, determines
whether it is a small addition or a change to what "declared" means.

## Cross-machine rename

Rename moves the catalog entry, which syncs, and the bus folder, which is
touched only on the machine that runs the command. An agent whose bus folder
lives on another machine is therefore renamed by half.

Whether this needs solving depends on whether a bus folder is genuinely
single-machine. The bus syncs, so the folder may exist in more than one place,
in which case rename needs to be an operation each machine converges on rather
than one that happens once — which would make it a reconcile concern rather than
a command.
