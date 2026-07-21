// `convoy run` — an AD-HOC session: the runnable core WITHOUT the declaration on top.
//
// The agent spec's own layering is the justification: "`pty` is the runnable core; the agent fields are
// the superset — a `pty` block alone still runs; convoy just layers intent on top." An ad-hoc session is
// that lower layer. It is deliberately NOT a catalog member, and the line is drawn where the spec already
// draws it rather than at a flag we invented.
//
// Why not a transient catalog entry (the "ephemeral declaration" fork in open-questions.md):
//   1. The catalog syncs under a UNION/NO-DELETE policy (see fabric-sync.ts, and the spec's `retired`
//      field: "an edit, never a file delete"). A per-run entry is therefore PERMANENT, fleet-wide garbage
//      that nothing can ever collect. Ad-hoc sessions are the highest-frequency kind; that is the worst
//      possible thing to make undeletable.
//   2. `supervisor` is required for every non-root agent. An ad-hoc session has no honest answer, so an
//      ephemeral declaration would have to fabricate one and corrupt the supervision tree.
//   3. convoy's own schema already refuses it: `strategy` accepts ONLY "permanent", and
//      agent-file.test.ts asserts `strategy = "ephemeral"` throws. Declaring-but-ephemeral is a shape the
//      declaration contract does not have.
//
// What an ad-hoc session consequently does NOT get — stated here because the whole risk of this command
// is someone later assuming it is equivalent to a declared one:
//   · no catalog entry            → `convoy up` cannot reconcile it, and never will
//   · no respawn / no recovery    → dies with its process; a host reboot does not bring it back (R44)
//   · no durable context          → its identity is minted per launch, so it starts empty every time and
//                                   CANNOT satisfy R48/R49 by construction. This is the honest reason a
//                                   generated name is safe here: nothing is promised on top of it.
//   · no adoption path            → it cannot later become declared; declare it properly instead.
//
// What it DOES get, because it launches through convoy's real launch path rather than bare-exec'ing a
// harness: the network's ST_ROOT/PTY_ROOT wiring, a bus identity with inbox/archive (so it is addressable
// and observable), persona + permission-mode derivation, pretrust, and a real pty session.

import { isValidIdentity } from "./agent-spec.ts";

/** Prefix marking a bus identity as ad-hoc. Chosen so `st agents` / `convoy ls` / `pty ls` all show at a
 *  glance that a session is outside the declaration contract, with no lookup and no extra field. */
export const AD_HOC_PREFIX = "run-";

/** Length of the random discriminator. 6 base36 chars ≈ 2.2e9 — collision risk is negligible at the
 *  handful-per-day rate ad-hoc sessions actually occur, and the whole identity stays 10 bytes so it costs
 *  almost nothing against the socket-path budget (`<PTY_ROOT>/<prefix>.<identity>.ding.sock`). */
export const AD_HOC_DISCRIMINATOR_LEN = 6;

/** Generate an ad-hoc identity: `run-<random base36>`.
 *
 *  RANDOM, deliberately, not a counter. #88 item 6 is about `<role>-<n>` counter names: a counter
 *  re-derives within each parent's lifetime, so after a restart `worker-2` names a DIFFERENT agent and
 *  would read a stranger's `context/now.md` as its own memory. A random discriminator never recurs, so
 *  the silent-inheritance failure is impossible by construction rather than merely discouraged.
 *
 *  `rand` is injectable so the generator is testable without stubbing globals. */
export function generateAdHocIdentity(rand: () => number = Math.random): string {
  let s = "";
  while (s.length < AD_HOC_DISCRIMINATOR_LEN) {
    // Drop the leading "0." and take base36 digits; loop because Math.random() can return a short string.
    s += rand().toString(36).slice(2);
  }
  return `${AD_HOC_PREFIX}${s.slice(0, AD_HOC_DISCRIMINATOR_LEN)}`;
}

/** True when an identity was minted by `convoy run`. Used to keep the disclosure honest: an explicitly
 *  named ad-hoc session (`--identity`) is still ad-hoc, but its name at least CAN recur, so it is worth
 *  telling the user that naming alone does not make it declared. */
export function isAdHocIdentity(identity: string): boolean {
  return identity.startsWith(AD_HOC_PREFIX);
}

/** Validate an operator-supplied `--identity` for `convoy run`.
 *
 *  Returns an error string, or null when acceptable. Deliberately REFUSES a name that collides with a
 *  declared catalog member: an ad-hoc session that shares an identity with a declared agent would write
 *  into that agent's bus folder — the same read-a-stranger's-memory failure #88 item 6 exists to prevent,
 *  arrived at from the other direction. */
export function validateRunIdentity(identity: string, declared: readonly string[]): string | null {
  if (!isValidIdentity(identity)) {
    return `invalid identity "${identity}" — lowercase alphanumeric plus \`. _ -\`, starting alphanumeric.`;
  }
  if (declared.includes(identity)) {
    return (
      `"${identity}" is already a DECLARED agent in this network. An ad-hoc session under that identity would ` +
      `share its bus folder and could read or overwrite its durable context. Pick another name, or run the ` +
      `declared agent with \`convoy up\`.`
    );
  }
  return null;
}

/** The contract disclosure printed on every ad-hoc launch.
 *
 *  Printed EVERY time, not once and not behind a flag. The stated risk of having this command at all is
 *  that it quietly becomes the default and the declared path withers; a notice that names what is missing
 *  and points at `convoy add` on every single launch is the cheapest available counter-pressure, and it
 *  costs nothing to anyone who genuinely wants a one-off. */
export function adHocNotice(identity: string, busId: string, role: string): string {
  // The suggested declared name is deliberately a PLACEHOLDER, never this session's identity. Echoing back
  // a generated `run-b3ur0v` would propose carrying a meaningless name into the catalog — and a meaningless
  // declared name is precisely what breaks context continuity, since nobody re-derives it on the next
  // cold boot. The whole value of declaring is choosing a name that means something.
  const generated = isAdHocIdentity(identity);
  const continuity = generated
    ? `    · its identity is minted per launch, so it has no durable context and starts empty every time.\n`
    : `    · it is undeclared, so nothing recreates it — its context does not survive as a managed session's would.\n`;
  return (
    `  ad-hoc session — NOT a declared catalog member.\n` +
    `    · \`convoy up\` will not reconcile, respawn, or recover it; it dies with its process.\n` +
    continuity +
    `    · addressable on the bus as ${busId} while it lives.\n` +
    `  For work that should survive a restart, declare it instead: \`convoy add ${role} --identity <a-meaningful-name>\`.`
  );
}
