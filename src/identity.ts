// ONE identity grammar, DERIVED — not authored here.
//
// Convoy used to carry its own `isValidIdentity` (`/^[a-z0-9][a-z0-9._-]*$/`, agent-spec.ts), which
// DISAGREED with the bus: `worker_fodfix` passed convoy and was rejected by smalltalk, and so did any
// name ending in `-`, `.`, or `_`. That produces the worst possible failure ordering — a name that
// declares cleanly, syncs to every machine in the catalog, and only fails when the agent tries to write
// its first message. The fix is not a better regex; a second regex would just be a second chance to
// disagree. The grammar is imported from the component that OWNS the namespace.
//
// Three independent bounds apply to an identity, from three different owners:
//
//   charset + reserved words  → smalltalk (`isAgent`), which owns the bus folder namespace
//   length                    → pty, which keys its unix socket on `<PTY_ROOT>/<session>.sock`
//   counter shape             → convoy, which owns what a durable declared name MEANS
//
// Only the third is convoy's to define.

import { isAgent } from "@compoundingtech/smalltalk";
import { agentShort } from "./agent-spec.ts";
import { ROLES, parseRole } from "./role.ts";

/** `sockaddr_un.sun_path` capacity: Darwin/BSD 104, Linux 108. pty (`sessions.ts validateName`) takes the
 *  smaller so one name works on every machine in a network; convoy mirrors that exactly rather than
 *  picking its own bound, so an identity convoy accepts is one pty can bind. */
export const SUN_PATH_MAX = 104;

/** The longest suffix convoy appends to a session id: the ding sidecar's `.ding` plus pty's `.sock`.
 *  `<PTY_ROOT>/<prefix>.<agentShort>.ding.sock` is the longest path any declared agent produces. */
const LONGEST_SUFFIX = ".ding.sock".length;

/** The byte budget an identity has, given where its sockets land and what prefixes them. Derived, not a
 *  constant: a network on a long path legitimately has less room for names than one on a short path. */
export function identityByteBudget(ptyRoot: string, prefix: string): number {
  // path.join collapses a trailing separator; measure the joined form or the budget is off by one.
  const dir = ptyRoot.replace(/\/+$/, "");
  return SUN_PATH_MAX - Buffer.byteLength(dir, "utf8") - 1 /* "/" */ - Buffer.byteLength(prefix, "utf8") - 1 /* "." */ - LONGEST_SUFFIX;
}

/** The context a full identity check needs. Both parts are optional because `convoy add` can run before a
 *  network is resolvable; without them the length bound is simply not checked (and says so). */
export interface IdentityContext {
  /** `<net>/pty` — where pty binds `<session>.sock`. */
  ptyRoot?: string | undefined;
  /** The session-id prefix (the short hostname unless overridden). */
  prefix?: string | undefined;
  /** Identities already declared on this network — uniqueness is scoped to the network, not the machine. */
  existing?: readonly string[] | undefined;
}

/** Does this identity look like a per-parent COUNTER (`worker-3`, `supervisor-2`) rather than a name?
 *  Returns the role stem when it does. A counter re-derives only within ONE parent's lifetime: restart the
 *  parent and `worker-2` is a different agent than it was yesterday. Meaningful stems are unaffected —
 *  `fabric-2` is a second agent on a named thing, not the second anonymous worker. */
export function counterStem(identity: string): string | null {
  const m = /^(.*)-(\d+)$/.exec(agentShort(identity));
  const stem = m?.[1];
  if (stem === undefined) return null;
  // Role names and their aliases are the counter-shaped stems; anything else is a real name.
  const role = parseRole(stem);
  if (role !== null) return stem;
  return (["agent", "child", "peer", "session"] as const).includes(stem as never) ? stem : null;
}

/** Every reason this identity cannot be declared, in the order a reader should fix them. Empty = valid.
 *  Called at DECLARE time (`convoy add`, spec parse) — not just before launch — because the catalog is
 *  synced: an invalid name that reaches the catalog has already propagated to every peer machine. */
export function identityErrors(identity: string, ctx: IdentityContext = {}): string[] {
  const errors: string[] = [];
  if (!identity) {
    return ["identity is empty"];
  }
  if (!isAgent(identity)) {
    errors.push(
      `invalid identity "${identity}": the bus accepts lowercase letters, digits, \`.\` and \`-\`, ` +
        `starting AND ending alphanumeric, and no reserved name (inbox, archive, status, agents, …). ` +
        `Note \`_\` is NOT accepted — \`${identity.replace(/_/g, "-")}\` would be.`,
    );
  }
  const { ptyRoot, prefix } = ctx;
  if (ptyRoot !== undefined && prefix !== undefined) {
    const budget = identityByteBudget(ptyRoot, prefix);
    const len = Buffer.byteLength(identity, "utf8");
    if (len > budget) {
      errors.push(
        `identity "${identity}" is ${len} bytes; this network allows ${budget} ` +
          `(pty binds ${ptyRoot}/${prefix}.<identity>.ding.sock against a ${SUN_PATH_MAX}-byte limit). ` +
          `Shorten the name, or put the network on a shorter path.`,
      );
    }
  }
  if (ctx.existing?.includes(identity)) {
    errors.push(`identity "${identity}" is already declared on this network — pick another, or \`convoy remove ${identity}\` first`);
  }
  return errors;
}

/** True when the identity is declarable. */
export function isDeclarableIdentity(identity: string, ctx: IdentityContext = {}): boolean {
  return identityErrors(identity, ctx).length === 0;
}

/** The message explaining why convoy will not SEED `context/` under a counter-named identity, or null when
 *  it will. Convoy refuses rather than warns: the failure it narrows — an agent reading a stranger's
 *  `context/now.md` as its own memory and acting on it — is silent, and a warning at declare time is not
 *  read at the moment the wrong file is opened weeks later. Note convoy can only decline to CREATE the
 *  dir; the bus creates it on demand, so this is a default and not an invariant (DELTA-005). */
export function counterContextRefusal(identity: string): string | null {
  const stem = counterStem(identity);
  if (stem === null) return null;
  return (
    `refusing to create durable context/ under "${identity}": \`${stem}-<n>\` is a COUNTER, and the counter ` +
    `re-derives per parent lifetime — after a restart, "${identity}" names a different agent than it did before, ` +
    `which would silently inherit the previous one's context/now.md as its own memory. ` +
    `convoy will not CREATE it, but the bus still would on demand — so prefer a stable name over relying on this. ` +
    `Give the agent a meaningful name (what it works on, not what number it is).`
  );
}

/** The roles whose bare `<role>-<n>` form is counter-shaped — exported so help text and docs cannot drift
 *  from the check. */
export const COUNTER_STEMS: readonly string[] = [...ROLES, "agent", "child", "peer", "session"];
