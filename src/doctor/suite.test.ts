import { describe, it, expect } from "vitest";
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
