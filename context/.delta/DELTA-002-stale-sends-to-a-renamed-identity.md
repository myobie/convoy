# DELTA-002 — A stale send to a renamed identity creates an unread folder

## Contract

[CV-R09](../requirements.md) requires that a reference to a superseded identity
either resolves to the current one or is reportable, and specifically that it
must not silently become a new agent.

## Reality

Convoy's own resolution honors the tombstone left by a rename. The bus does not:
smalltalk has no redirect mechanism, and its send path validates the recipient
name and then creates the inbox directory unconditionally. A peer that still
holds the old identity and sends to it *after* a rename therefore succeeds,
writing into a folder nobody reads.

Mail in flight *at* rename time is unaffected — it moves with the folder, which
is why rename is a move rather than a re-creation. The gap is strictly
post-rename sends from references that have not caught up.

The tombstone limits the damage rather than closing it: because it is a bare
dotfile with no `inbox/`, `archive/`, or `status`, the old identity does not
appear in agent listings until such a send resurrects it.

## Effect

Messages are lost silently. The sender sees success. The intended recipient
never learns a message existed. A resurrected old-name folder subsequently
appears in agent listings as though the renamed-away agent were back.

## Resolution

Redirect resolution belongs in smalltalk, which owns identity-to-folder
resolution: a send to a tombstoned identity should follow the redirect, or fail,
rather than manufacture the folder. Convoy cannot close this from its side
because it is not in the send path.

Until then, convoy can narrow it by detecting resurrected tombstone folders
during reconcile and forwarding their contents to the current identity. That
turns silent loss into delayed delivery, which is a smaller wrong.
