import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fullOrgGateLine } from "./suite.ts";

// The `[full-org] GATE …` line is a STABLE contract the evals `convoy-doctor-canwork` cell greps to hard-gate
// the deterministic org-proof core (g1/cos_sup/sup_wk/graded_fix) while reading the flaky straddle advisory.
// These lock the exact wording + the pass|fail|skip vocabulary so a rename can't silently break the gate.
describe("fullOrgGateLine — the stable [full-org] GATE contract", () => {
  it("all gates pass → the canonical green line", () => {
    expect(fullOrgGateLine({ g1: true, cosSup: true, supWk: true, gradedFix: true, straddle: true })).toBe(
      "GATE g1=pass cos_sup=pass sup_wk=pass graded_fix=pass straddle=pass",
    );
  });

  it("a G1 boot failure → g1=fail with the rest fail + straddle skip (the early-return shape)", () => {
    expect(fullOrgGateLine({ g1: false, cosSup: false, supWk: false, gradedFix: false, straddle: null })).toBe(
      "GATE g1=fail cos_sup=fail sup_wk=fail graded_fix=fail straddle=skip",
    );
  });

  it("core green but the straddle flaked → core pass, straddle=fail (advisory, does not change the core tokens)", () => {
    expect(fullOrgGateLine({ g1: true, cosSup: true, supWk: true, gradedFix: true, straddle: false })).toBe(
      "GATE g1=pass cos_sup=pass sup_wk=pass graded_fix=pass straddle=fail",
    );
  });

  it("no committed fix to restart onto → straddle=skip (never attempted)", () => {
    expect(fullOrgGateLine({ g1: true, cosSup: true, supWk: false, gradedFix: false, straddle: null })).toBe(
      "GATE g1=pass cos_sup=pass sup_wk=fail graded_fix=fail straddle=skip",
    );
  });

  it("straddle is the ONLY skip-able field; the core is strictly pass|fail", () => {
    const line = fullOrgGateLine({ g1: true, cosSup: false, supWk: true, gradedFix: false, straddle: null });
    expect(line).toMatch(/^GATE g1=(pass|fail) cos_sup=(pass|fail) sup_wk=(pass|fail) graded_fix=(pass|fail) straddle=(pass|fail|skip)$/);
    expect(line).not.toMatch(/g1=skip|cos_sup=skip|sup_wk=skip|graded_fix=skip/);
  });
});

// ---------------------------------------------------------------------------
// The declare-then-reconcile invariant. `convoy add` is DECLARE-ONLY — it writes a catalog entry and
// launches nothing ("NOTHING launched — the catalog is desired state. Run `convoy up` to reconcile") — so
// any readiness check that declares an agent and then asserts it is LIVE (a registered pty session, a
// status poll, an inbox drain) MUST run `convoy up` in between. A check that doesn't fails by
// construction on every machine, and `runReadinessSuite` returns 0 only if EVERY check passes — so one
// such check reds a newcomer's very first `convoy doctor`.
//
// The checks themselves spawn real agents (minutes, real auth), so they can't be exercised in a unit
// test. This is a SOURCE-level guard instead: it reads suite.ts and holds the invariant structurally,
// which is the shape of bug that shipped — nobody was watching the declare→assert seam.
describe("readiness checks: every check that declares an agent also reconciles it (`up --once`)", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "suite.ts"), "utf8");

  /** The body of `export async function <name>(`, up to the next top-level `export ` declaration. */
  const bodyOf = (fn: string): string => {
    const start = src.indexOf(`export async function ${fn}(`);
    expect(start, `${fn} not found in suite.ts`).toBeGreaterThan(-1);
    const rest = src.slice(start + 1);
    const end = rest.indexOf("\nexport ");
    return end === -1 ? rest : rest.slice(0, end);
  };
  const declaresAgents = (body: string): boolean => /\["add",|"add", s\.role/.test(body);
  const RECONCILE = `runConvoy(box, ["up", box.net, "--once"])`;

  // Every check that declares agents. All FIVE were missing the reconcile; the four marked below are
  // fixed in PR #89 (which owns those exact hunks), so this PR only closes checkDevTask and the guard
  // carries a SHRINK-ONLY exception list. When #89 lands, delete the list — the guard then covers all
  // five and this seam can never silently reopen.
  const DECLARING_CHECKS = ["checkTmpNetwork", "checkDings", "checkStateExternalization", "checkExactlyOnce", "checkDevTask"];
  const RECONCILE_LANDS_IN_PR_89 = ["checkTmpNetwork", "checkDings", "checkStateExternalization", "checkExactlyOnce"];
  const covered = DECLARING_CHECKS.filter((c) => !RECONCILE_LANDS_IN_PR_89.includes(c));

  it.each(covered)("%s reconciles its declared agents with `convoy up --once`", (fn) => {
    const body = bodyOf(fn);
    expect(declaresAgents(body), `${fn} no longer declares agents — re-check this guard`).toBe(true);
    expect(body, `${fn} declares agents with \`convoy add\` but never reconciles them — it can only ever fail`).toContain(RECONCILE);
  });

  it.each(covered)("ACCEPTANCE: %s reconciles BEFORE it asserts liveness, never after", (fn) => {
    const body = bodyOf(fn);
    const up = body.indexOf(RECONCILE);
    // The first liveness assertion: a pty-session snapshot, or a status/inbox poll.
    const assertions = [body.indexOf("ptySessionNames(box.env)"), body.indexOf("pollUntil(")].filter((i) => i > -1);
    expect(up).toBeGreaterThan(-1);
    expect(assertions.length, `${fn} asserts no liveness — re-check this guard`).toBeGreaterThan(0);
    expect(up, `${fn} reconciles only AFTER it already asserted liveness`).toBeLessThan(Math.min(...assertions));
  });

  it("guards the guard: every name in the exception list is a real check that really does declare agents", () => {
    // Keeps the list from going stale into a vacuous pass (e.g. after a rename), and keeps it honest —
    // a name may only sit here because its reconcile lives in another PR, never to excuse a real gap.
    for (const fn of RECONCILE_LANDS_IN_PR_89) expect(declaresAgents(bodyOf(fn)), `${fn} does not declare agents`).toBe(true);
    expect(DECLARING_CHECKS.every((c) => declaresAgents(bodyOf(c)))).toBe(true);
    expect(covered).toEqual(["checkDevTask"]);
  });
});
