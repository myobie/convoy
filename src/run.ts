// `convoy run` — DECLARE, launch, and attach. The interactive front door to the SAME declared model
// every other verb speaks.
//
// This SUPERSEDES the ad-hoc design that shipped in #92. `convoy run` is now exactly `convoy add` —
// same flags, same validation, same catalog write — plus a launch and an attach. The verb set is:
//
//   add     declare                              (no launch)
//   render  materialize the overlay              (no launch, no bus)
//   up      reconcile — launch what is declared  (no attach)
//   run     declare, launch, and attach
//
// Why the ad-hoc model was wrong, in one sentence: an undeclared session has no stable identity,
// therefore no durable `context/` directory, therefore it cannot externalize state or converge after a
// restart — a permanent second class of session that could never be promoted. Making `run` declare means
// every agent gets the same guarantees and the ad-hoc/declared distinction disappears rather than being
// managed forever.
//
// #92's three objections do not survive:
//   1. "`supervisor` is required for every non-root agent" — FALSE. `parseAgentFile` requires only
//      `identity` and `role`; there is no such field requirement. This was refuted on review.
//   2. "A per-run catalog entry is permanent fleet-wide garbage (union/no-delete sync)." Permanence is now
//      the INTENT, not a leak: a run-created agent is a declared agent that happened to be started
//      interactively. `retired = true` is the documented way to decommission one.
//   3. "`strategy` accepts only `permanent`." Consistent, not an obstacle — a run-created agent IS a real
//      declared agent, so the one legal value is the correct one.
//
// The coherence property that makes this safe: `convoy up`'s reconcile keys liveness on the bus id
// `<host>.<identity>` (reconcile.ts `agentBusId`), and `run` launches through the very same `nativeLaunch`
// that up's reconcile uses, pinning the same identity-derived session id. So a session started by `run` is
// ADOPTED by a concurrently-running `convoy up` — never double-spawned. Declaring and launching in one
// breath is indistinguishable, to every other verb, from `add` followed by `up`.

/** What `convoy run` should do about the declaration + session that already exist (or don't).
 *
 *  `run` deliberately does NOT inherit `add`'s flat "already declared → refuse without --force". The
 *  headline property of the declared model is that an agent's durable context SURVIVES a restart, so
 *  re-running an identity you already declared is the intended everyday path — the resume — not a
 *  collision. Refusing it would break the exact thing this redesign exists to deliver. */
export type RunAction =
  /** Not declared → write the agent file, launch, attach. The first-run path. */
  | "declare"
  /** Declared, no live session → launch from the EXISTING declaration, attach. The resume path: durable
   *  context is picked back up. The declaration is left untouched; changing it needs --force. */
  | "resume"
  /** Declared and already live → attach to the running session. No re-declare, no relaunch: joining an
   *  agent that is already working must never restart it and lose its in-flight state. */
  | "attach"
  /** Declared, not live, --force → overwrite the declaration with the flags given now, then launch+attach. */
  | "redeclare"
  /** Declared AND live AND --force → REFUSE. Overwriting a live agent's declaration and relaunching it
   *  would spawn a second session on the same pinned session id. `convoy reload` is the existing verb for
   *  kill-and-respawn, so point at it rather than growing a second way to do it. */
  | "refuse-live-force";

export interface RunSituation {
  /** A catalog entry for this identity already exists. */
  readonly declared: boolean;
  /** A live pty session is already serving this identity's bus id. */
  readonly live: boolean;
  /** --force was passed. */
  readonly force: boolean;
}

/** Resolve what `convoy run` does, given what already exists. Pure — the decision table is the design,
 *  so it is testable without a network, a catalog, or a pty. */
export function resolveRunAction(s: RunSituation): RunAction {
  if (!s.declared) return "declare";
  if (s.live) return s.force ? "refuse-live-force" : "attach";
  return s.force ? "redeclare" : "resume";
}

/** The message for the refused case, naming the verb that actually does what the user asked for. */
export function liveForceRefusal(identity: string): string {
  return (
    `"${identity}" is declared AND already running. \`--force\` would overwrite its declaration and launch a ` +
    `SECOND session on the same pinned session id. To pick up the running one, drop \`--force\` — ` +
    `\`convoy run --identity ${identity}\` attaches to it. To apply a CHANGED declaration to a live agent, use ` +
    `\`convoy reload ${identity}\` (kill + respawn), or \`convoy down ${identity}\` and re-run with --force.`
  );
}

/** The note printed when `run` resumes or attaches to an EXISTING declaration while the caller also passed
 *  configuration flags. Silently ignoring `--model`/`--harness`/... would be a real footgun: the user would
 *  believe they changed something. `add` gates a re-declare behind `--force`; `run` says so out loud. */
export function staleFlagsNote(identity: string, flags: readonly string[]): string | null {
  if (flags.length === 0) return null;
  return (
    `  ! using the EXISTING declaration for "${identity}" — ${flags.join(", ")} ${flags.length === 1 ? "was" : "were"} ignored.\n` +
    `    The catalog entry is the source of truth once it exists. \`--force\` re-declares it with these flags ` +
    `(the agent must not be running), or edit the agent file directly.`
  );
}

/** The configuration flags that describe a DECLARATION (as opposed to flags that only steer this
 *  invocation, like --network / --dry-run / --no-attach). Used to detect the stale-flag case above. */
export const DECLARATION_FLAGS = [
  "--harness",
  "--model",
  "--transport",
  "--mcp",
  "--dir",
  "--bin",
  "--supervisor",
  "--persona",
  "--permanent",
  "--host",
] as const;

/** Which declaration flags the caller actually passed. */
export function passedDeclarationFlags(args: readonly string[]): string[] {
  return DECLARATION_FLAGS.filter((f) => args.includes(f));
}

/** Which agent file `run` must key LIVENESS on: the existing declaration whenever there is one, never the
 *  one just built from this invocation's flags.
 *
 *  This is the single point where `run` either does or does not agree with `convoy up` about what "already
 *  running" means, so it is a named function rather than an inline `??` — the coherence claim of this whole
 *  design reduces to this choice.
 *
 *  `up`'s reconcile keys on `entry.af.host ?? thisHost` — the DECLARATION's host. `buildDeclaration` always
 *  populates `host` (`--host` ?? this machine), so keying on the args-built file would compute a
 *  this-machine-prefixed bus id for an agent declared `host = otherbox` (its catalog file having arrived by
 *  fabric sync). `run` would then find nothing live and launch a DUPLICATE alongside the real one. */
export function livenessAgentFile<T>(existing: T | null, fromArgs: T): T {
  return existing ?? fromArgs;
}

/** The line `run` prints once the session is up, stating the guarantees it DOES have — the exact inverse
 *  of #92's `adHocNotice`, which existed to disclaim them. Detaching is safe and is worth saying: a pty
 *  session outlives its client, and because the agent is declared, `convoy up` also respawns it if the
 *  process dies. That is the whole point of routing `run` through the declared path. */
export function declaredRunNotice(identity: string, busId: string, sessionRef: string): string {
  return (
    `  declared agent — detaching leaves it RUNNING.\n` +
    `    · detach with the pty escape; re-attach any time with \`convoy run --identity ${identity}\` or \`pty attach ${sessionRef}\`.\n` +
    `    · \`convoy up\` reconciles and respawns it like any other catalog member; its context/ survives a restart.\n` +
    `    · addressable on the bus as ${busId}.\n` +
    `  Decommission it with \`retired = true\` in its agent file (\`convoy down ${identity}\` just stops the session).`
  );
}
