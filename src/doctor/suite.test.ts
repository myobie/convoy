import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fullOrgGateLine } from "./suite.ts";
import { exportedAsyncFunctions, functionBody, stripComments } from "../source-guard.ts";

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
// status poll, an inbox drain) MUST reconcile in between. A check that doesn't fails by construction on
// every machine, and `runReadinessSuite` returns 0 only if EVERY check passes — so one such check reds a
// newcomer's very first `convoy doctor`.
//
// The checks themselves spawn real agents (minutes, real auth), so they can't be exercised in a unit test.
// This is a SOURCE-level guard instead. Two properties make it an actual guard rather than a grep:
//
//   1. DERIVED, not hardcoded. The set of declaring checks is read out of suite.ts. A hardcoded list can
//      only ever guard the checks someone remembered to list — a NEW declare-then-assert check, or one
//      that starts declaring agents later, is invisible to it. (`checkFullOrg` was exactly that: a sixth
//      declaring check absent from the hardcoded list.)
//   2. COMMENT-STRIPPED. A guard that greps raw source is satisfied by
//      `// TODO: runConvoy(box, ["up", box.net, "--once"]) -- disabled` — the reconcile fully deleted, the
//      guard fully green. Everything below reads `stripComments(src)`; see src/source-guard.ts.
describe("readiness checks: every check that declares an agent also reconciles it before asserting liveness", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "suite.ts"), "utf8");

  const bodyOf = (fn: string): string => {
    const b = functionBody(src, fn);
    expect(b, `${fn} not found in suite.ts`).not.toBeNull();
    return b!;
  };
  /** Does this check DECLARE agents? (`convoy add` — the catalog write that launches nothing.) */
  const declaresAgents = (body: string): boolean => /\["add",|"add", s\.role/.test(body);

  // The two ways a check legitimately reconciles its declarations. `up --once` is a single reconcile pass;
  // `backgroundUp` is a persistent hosting `convoy up` held for the length of the check (checkFullOrg, which
  // must keep hosting while the org spawns its own reports). Both LAUNCH declared agents — that is the
  // invariant. A check that does neither can only ever fail.
  const RECONCILE_ONCE = `runConvoy(box, ["up", box.net, "--once"])`;
  const RECONCILE_BACKGROUND = `backgroundUp(box)`;
  const reconcileAt = (body: string): number => {
    const hits = [body.indexOf(RECONCILE_ONCE), body.indexOf(RECONCILE_BACKGROUND)].filter((i) => i > -1);
    return hits.length === 0 ? -1 : Math.min(...hits);
  };
  /** The first assertion that an agent is LIVE: a pty-session snapshot, or a status/inbox poll. */
  const livenessAt = (body: string): number => {
    const hits = [body.indexOf("ptySessionNames(box.env)"), body.indexOf("pollUntil(")].filter((i) => i > -1);
    return hits.length === 0 ? -1 : Math.min(...hits);
  };

  // DERIVED from suite.ts — every exported `check*` whose body declares agents. Nothing is hardcoded, so a
  // new declaring check is covered the moment it is written.
  const DECLARING_CHECKS = exportedAsyncFunctions(src)
    .filter((n) => n.startsWith("check"))
    .filter((n) => declaresAgents(bodyOf(n)));

  // The ONLY excuse: the check's reconcile is a hunk owned by PR #89, which this PR deliberately does not
  // duplicate. Names of CHECKS, never a reason to tolerate a real gap. SHRINK-ONLY — when #89 lands, empty
  // it and the guard covers every declaring check. (Deleting it must STRENGTHEN this guard, never break it;
  // the assertions below are written so that it does.)
  const RECONCILE_LANDS_IN_PR_89 = ["checkTmpNetwork", "checkDings", "checkStateExternalization", "checkExactlyOnce"];
  const covered = DECLARING_CHECKS.filter((c) => !RECONCILE_LANDS_IN_PR_89.includes(c));

  it("the derivation is not vacuous: suite.ts really does have declaring checks, and it found checkDevTask", () => {
    // If the scan ever returns nothing (a rename, a refactor, a broken tokenizer) every `it.each` below
    // silently becomes zero test cases — a guard that passes because it ran nothing. This is the backstop.
    expect(DECLARING_CHECKS.length).toBeGreaterThanOrEqual(5);
    expect(DECLARING_CHECKS).toContain("checkDevTask");
    expect(covered.length).toBeGreaterThan(0);
    expect(covered).toContain("checkDevTask"); // the check THIS PR fixes is always under guard
  });

  it("derives checks the old hardcoded list missed — checkFullOrg declares agents and is now covered", () => {
    expect(DECLARING_CHECKS).toContain("checkFullOrg");
    expect(covered).toContain("checkFullOrg");
  });

  it.each(covered)("%s reconciles the agents it declares", (fn) => {
    const body = bodyOf(fn);
    expect(declaresAgents(body), `${fn} no longer declares agents — re-check this guard`).toBe(true);
    expect(reconcileAt(body), `${fn} declares agents with \`convoy add\` but never reconciles them (\`up --once\` or a background \`convoy up\`) — it can only ever fail`).toBeGreaterThan(-1);
  });

  it.each(covered)("ACCEPTANCE: %s reconciles BEFORE it asserts liveness, never after", (fn) => {
    const body = bodyOf(fn);
    expect(livenessAt(body), `${fn} asserts no liveness — re-check this guard`).toBeGreaterThan(-1);
    // Absence is -1, which would sail past a bare `toBeLessThan(liveness)` — this assertion must never pass
    // because there is NOTHING to order.
    expect(reconcileAt(body), `${fn} never reconciles at all — nothing to order`).toBeGreaterThan(-1);
    expect(reconcileAt(body), `${fn} reconciles only AFTER it already asserted liveness`).toBeLessThan(livenessAt(body));
  });

  it("guards the guard: every excused name is a real declaring check, and the list excuses NOTHING else", () => {
    for (const fn of RECONCILE_LANDS_IN_PR_89) {
      expect(DECLARING_CHECKS, `${fn} is excused but is not a declaring check in suite.ts — stale name`).toContain(fn);
    }
    // TRIPWIRE: the excuse list names CHECKS. It must never be used to launder the reconcile itself away.
    expect(RECONCILE_LANDS_IN_PR_89).not.toContain(RECONCILE_ONCE);
    expect(RECONCILE_LANDS_IN_PR_89).not.toContain(RECONCILE_BACKGROUND);
    // SHRINK-ONLY, stated as a property rather than a snapshot: the excuse list may only ever contain the
    // four #89 names. Deleting it (as #89's merger should) keeps this green and widens `covered` to all
    // declaring checks — the previous `expect(covered).toEqual(["checkDevTask"])` snapshot BROKE on exactly
    // that deletion, so the PR's own instruction red the suite it shipped.
    for (const fn of RECONCILE_LANDS_IN_PR_89) {
      expect(["checkTmpNetwork", "checkDings", "checkStateExternalization", "checkExactlyOnce"]).toContain(fn);
    }
  });

  it("ACCEPTANCE: a COMMENTED-OUT reconcile does not satisfy this guard (the way the shipped guard was defeated)", () => {
    // The exact defeat, run against the guard's own predicates: a check whose reconcile is a comment must
    // read as NOT reconciled. A raw-text guard passes this source; this one must not.
    const defeated = `
export async function checkFake(): Promise<CheckResult> {
  for (const s of tiers) { await runConvoy(box, ["add", s.role, "--identity", s.id]); }
  // TODO: runConvoy(box, ["up", box.net, "--once"]) -- disabled
  const ok = await pollUntil(async () => true, 1000);
  return { name, pass: ok };
}`;
    expect(defeated).toContain(RECONCILE_ONCE); // a raw grep is satisfied…
    const body = functionBody(defeated, "checkFake")!;
    expect(declaresAgents(body)).toBe(true); // …it IS a declaring check…
    expect(reconcileAt(body)).toBe(-1); // …and the guard correctly sees NO reconcile.
  });

  it("ACCEPTANCE: a comment mentioning the reconcile above the liveness poll does not satisfy the ORDERING check", () => {
    const late = `
export async function checkFake(): Promise<CheckResult> {
  await runConvoy(box, ["add", "worker", "--identity", "x"]);
  // reconcile: runConvoy(box, ["up", box.net, "--once"]) happens below
  const ok = await pollUntil(async () => true, 1000);
  await runConvoy(box, ["up", box.net, "--once"]);
  return { name, pass: ok };
}`;
    const body = functionBody(late, "checkFake")!;
    expect(reconcileAt(body)).toBeGreaterThan(livenessAt(body)); // reconciles only AFTER asserting → caught
  });

  it("the guard reads real code: a genuine reconcile IS accepted (negative control)", () => {
    const good = `
export async function checkFake(): Promise<CheckResult> {
  await runConvoy(box, ["add", "worker", "--identity", "x"]);
  await runConvoy(box, ["up", box.net, "--once"]);
  const ok = await pollUntil(async () => true, 1000);
  return { name, pass: ok };
}`;
    const body = functionBody(good, "checkFake")!;
    expect(reconcileAt(body)).toBeGreaterThan(-1);
    expect(reconcileAt(body)).toBeLessThan(livenessAt(body));
  });

  it("stripComments is actually applied to suite.ts (the guard's input is code, not prose)", () => {
    expect(stripComments(src).length).toBe(src.length); // blanked in place, offsets preserved
    expect(bodyOf("checkDevTask")).not.toContain("DECLARE-ONLY"); // …the explanatory comment is gone
  });
});
