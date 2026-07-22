// Ported 1:1 from Tests/ConvoyKitTests/FlappingCapTests.swift (which ported pty's gc-flapping.test.ts).
// These pin the §5 flapping-cap contract convoy implements verbatim — the highest-fidelity port.

import { describe, it, expect } from "vitest";
import {
  classify,
  classifyFailedAttempt,
  clearParkForFreshSupervisor,
  commandFingerprint,
  FLAPPING_STATUS,
  effectiveLimit,
  effectiveWindow,
  emptyStrategyTags,
  parseStrategyTags,
  TAG,
  writtenTags,
  type Decision,
  type StrategyTags,
} from "./flapping-cap.ts";

const t0 = new Date(1_000_000 * 1000);
const HASH_A = "aaaaaaaaaaaaaaaa";
const HASH_B = "bbbbbbbbbbbbbbbb";
const WINDOW = 60;
const LIMIT = 3;

function tags(over: Partial<StrategyTags> = {}): StrategyTags {
  return { ...emptyStrategyTags(), ...over };
}
function run(t: StrategyTags, exitedAt: Date | null, currentHash = HASH_A, now = new Date(t0.getTime() + 1000_000)): Decision {
  return classify({ session: "wk1", exitedAt, tags: t, currentHash, window: WINDOW, limit: LIMIT, now });
}
const at = (secs: number) => new Date(t0.getTime() + secs * 1000);

describe("FlappingCap classifier", () => {
  it("1. first respawn: no prior state → respawn, counter 0, stamps hash + last-respawn-at", () => {
    const now = at(500);
    const d = run(tags(), null, HASH_A, now);
    expect(d.kind).toBe("respawn");
    if (d.kind !== "respawn") return;
    expect(d.tags.consecutiveFastFails).toBe(0);
    expect(d.tags.commandHash).toBe(HASH_A);
    expect(d.tags.lastRespawnAt).toEqual(now);
    expect(d.tags.status).toBeNull();
  });

  it("2. fast fail increments the counter", () => {
    const d = run(tags({ consecutiveFastFails: 1, lastRespawnAt: t0, commandHash: HASH_A }), at(10));
    expect(d.kind).toBe("respawn");
    if (d.kind === "respawn") expect(d.tags.consecutiveFastFails).toBe(2);
  });

  it("3. reaching the limit flaps (no respawn) + emits event; last-respawn-at preserved", () => {
    const d = run(tags({ consecutiveFastFails: 2, lastRespawnAt: t0, commandHash: HASH_A }), at(5));
    expect(d.kind).toBe("flap");
    if (d.kind !== "flap") return;
    expect(d.tags.status).toBe("flapping");
    expect(d.tags.consecutiveFastFails).toBe(3);
    expect(d.tags.lastRespawnAt).toEqual(t0); // flap preserves the last attempt's stamp
    expect(d.event.counter).toBe(3);
    expect(d.event.limit).toBe(3);
    expect(d.event.window).toBe(60);
    expect(d.event.type).toBe("session_flapping");
  });

  it("4. flapping + unchanged command → skip", () => {
    const d = run(tags({ consecutiveFastFails: 3, lastRespawnAt: t0, commandHash: HASH_A, status: "flapping" }), at(5));
    expect(d.kind).toBe("skip");
  });

  it("5. flapping + command changed → reset + respawn (counter 0, status cleared)", () => {
    const d = run(tags({ consecutiveFastFails: 9, lastRespawnAt: t0, commandHash: HASH_A, status: "flapping" }), at(5), HASH_B);
    expect(d.kind).toBe("respawn");
    if (d.kind !== "respawn") return;
    expect(d.tags.consecutiveFastFails).toBe(0);
    expect(d.tags.status).toBeNull();
    expect(d.tags.commandHash).toBe(HASH_B);
  });

  it("6. slow fail resets the counter to 0", () => {
    const d = run(tags({ consecutiveFastFails: 2, lastRespawnAt: t0, commandHash: HASH_A }), at(120));
    expect(d.kind).toBe("respawn");
    if (d.kind === "respawn") expect(d.tags.consecutiveFastFails).toBe(0);
  });

  it("7. §5.6.1 manual kill of a long-lived agent is a SLOW fail (not a flap footgun)", () => {
    const d = run(tags({ consecutiveFastFails: 2, lastRespawnAt: t0, commandHash: HASH_A }), at(3600));
    expect(d.kind).toBe("respawn");
    if (d.kind === "respawn") expect(d.tags.consecutiveFastFails).toBe(0);
  });

  it("8. window boundary: lived == window is a SLOW fail (< window is fast)", () => {
    const d = run(tags({ consecutiveFastFails: 2, lastRespawnAt: t0, commandHash: HASH_A }), at(60));
    expect(d.kind).toBe("respawn");
    if (d.kind === "respawn") expect(d.tags.consecutiveFastFails).toBe(0);
  });

  it("9. unknown exit time → not a fast fail (conservative reset)", () => {
    const d = run(tags({ consecutiveFastFails: 2, lastRespawnAt: t0, commandHash: HASH_A }), null);
    expect(d.kind).toBe("respawn");
    if (d.kind === "respawn") expect(d.tags.consecutiveFastFails).toBe(0);
  });

  it("10. effective-threshold precedence: per-session tag > CLI global > default", () => {
    expect(effectiveWindow(10, 30)).toBe(10);
    expect(effectiveWindow(null, 30)).toBe(30);
    expect(effectiveWindow(null, null)).toBe(60);
    expect(effectiveLimit(5, 2)).toBe(5);
    expect(effectiveLimit(null, 2)).toBe(2);
    expect(effectiveLimit(null, null)).toBe(3);
  });

  it("11. command fingerprint: 16 lowercase hex, deterministic, sensitive to args", () => {
    const a = commandFingerprint("claude", ["--resume", "x"]);
    const b = commandFingerprint("claude", ["--resume", "x"]);
    const c = commandFingerprint("claude", ["--resume", "y"]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toHaveLength(16);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it("12. wire-format round-trip (spec §8.1): parse ⇄ writtenTags, ISO shape, string int", () => {
    const now = new Date(1_783_446_612_345); // ms with .345 fraction
    const t = tags({ consecutiveFastFails: 2, lastRespawnAt: now, commandHash: HASH_A, status: "flapping" });
    const w = writtenTags(t);
    expect(w[TAG.consecutive]).toBe("2");
    expect(w[TAG.commandHash]).toBe(HASH_A);
    expect(w[TAG.status]).toBe("flapping");
    expect(w[TAG.lastRespawn]).toMatch(/\.\d{3}Z$/); // ISO with ms fraction + Z
    const re = parseStrategyTags(w);
    expect(re.consecutiveFastFails).toBe(2);
    expect(re.commandHash).toBe(HASH_A);
    expect(re.status).toBe("flapping");
    expect(re.lastRespawnAt?.getTime()).toBe(now.getTime());
  });

  it("13. absent tags parse to sane defaults (counter 0, no status)", () => {
    const t = parseStrategyTags({});
    expect(t.consecutiveFastFails).toBe(0);
    expect(t.status).toBeNull();
    expect(t.commandHash).toBeNull();
    expect(t.lastRespawnAt).toBeNull();
  });
});

// convoy#82 — the failed-ATTEMPT cap. `classify` infers a fast fail from the leaf's exit record, which is
// structurally blind when the spawn never happened: the reproduction showed the counter pinned at 0/3 across
// unbounded reconcile cycles, because with no new leaf `exitedAt` stayed EARLIER than `lastRespawnAt` and the
// interval went negative. These pin the attempt-counting that closes that hole.
describe("classifyFailedAttempt — a recovery attempt that never produced a leaf (convoy#82)", () => {
  const runFailed = (t: StrategyTags, now = t0): Decision =>
    classifyFailedAttempt({ session: "wk1", tags: t, currentHash: HASH_A, window: WINDOW, limit: LIMIT, now });

  it("REGRESSION: the exit-record classifier cannot see a failed spawn — counter stays 0 forever", () => {
    // The convoy#82 shape: the death is OLDER than the last respawn attempt, so the interval is negative.
    // classify() reads that as "not a fast fail" and resets to 0 — every tick, unboundedly. This documents
    // WHY the attempt-based cap exists; it is the behaviour that made the defect silent.
    const dead = tags({ lastRespawnAt: at(500), consecutiveFastFails: 0 });
    const d = run(dead, at(100)); // exitedAt EARLIER than lastRespawnAt
    expect(d.kind).toBe("respawn");
    if (d.kind === "respawn") expect(d.tags.consecutiveFastFails).toBe(0); // ← never advances
  });

  it("ACCEPTANCE: counts the attempt itself, so a manifest that cannot spawn ADVANCES the cap", () => {
    const d = runFailed(tags({ consecutiveFastFails: 0 }));
    expect(d.kind).toBe("respawn");
    if (d.kind === "respawn") expect(d.tags.consecutiveFastFails).toBe(1);
  });

  it("ACCEPTANCE: PARKS at the limit instead of retrying forever — the defect's core symptom", () => {
    const d = runFailed(tags({ consecutiveFastFails: LIMIT - 1 }));
    expect(d.kind).toBe("flap");
    if (d.kind === "flap") {
      expect(d.tags.status).toBe(FLAPPING_STATUS);
      expect(d.event.counter).toBe(LIMIT);
      expect(d.event.limit).toBe(LIMIT);
    }
  });

  it("never returns `skip` — the caller relies on always persisting an advanced counter", () => {
    for (let n = 0; n < LIMIT + 2; n++) expect(runFailed(tags({ consecutiveFastFails: n })).kind).not.toBe("skip");
  });

  it("stamps lastRespawnAt + the command hash on a retry, so the NEXT real leaf is measurable", () => {
    const now = at(900);
    const d = runFailed(tags({ consecutiveFastFails: 0 }), now);
    if (d.kind === "respawn") {
      expect(d.tags.lastRespawnAt).toEqual(now);
      expect(d.tags.commandHash).toBe(HASH_A);
      expect(d.tags.status).toBeNull();
    }
  });

  it("reuses the SAME cap as a crash loop — a park is clearable by the one existing operator gesture", () => {
    // Parked state is byte-identical in shape to a crash-loop park, so `--rm strategy.status` clears either.
    const parked = runFailed(tags({ consecutiveFastFails: LIMIT - 1 }));
    if (parked.kind === "flap") expect(writtenTags(parked.tags)[TAG.status]).toBe(FLAPPING_STATUS);
  });
});

describe("clearParkForFreshSupervisor — a fresh foreground `convoy up` restores the FULL fleet (parking-recovery)", () => {
  it("ACCEPTANCE: a PARKED member is un-parked — status cleared AND the counter zeroed (relaunchable again)", () => {
    // The reproduced bug: an outage drives the cap to its limit → the agent parks → and a fresh supervisor,
    // reading the persisted `status=flapping`, would `skip` it forever. A deliberate bring-up must not inherit
    // that. Both fields reset: clearing status alone is not enough — a counter still at the cap re-parks on
    // the very next fast fail.
    const cleared = clearParkForFreshSupervisor(tags({ status: FLAPPING_STATUS, consecutiveFastFails: LIMIT }));
    expect(cleared).not.toBeNull();
    expect(cleared?.status).toBeNull();
    expect(cleared?.consecutiveFastFails).toBe(0);
  });

  it("resets a NON-parked member with prior fails too — 'regardless of prior fail count' (Nathan mandate)", () => {
    const cleared = clearParkForFreshSupervisor(tags({ status: null, consecutiveFastFails: LIMIT - 1 }));
    expect(cleared?.consecutiveFastFails).toBe(0);
    expect(cleared?.status).toBeNull();
  });

  it("is a NO-OP for a clean member (no park, counter 0) — the caller writes no tag needlessly", () => {
    expect(clearParkForFreshSupervisor(tags({ status: null, consecutiveFastFails: 0 }))).toBeNull();
  });

  it("preserves the rest of the strategy state — only status + counter are touched", () => {
    const before = tags({ status: FLAPPING_STATUS, consecutiveFastFails: LIMIT, commandHash: HASH_A, lastRespawnAt: at(500), fastFailLimitOverride: 5, fastFailWindowOverride: 120 });
    const cleared = clearParkForFreshSupervisor(before);
    expect(cleared?.commandHash).toBe(HASH_A);
    expect(cleared?.lastRespawnAt).toEqual(at(500));
    expect(cleared?.fastFailLimitOverride).toBe(5);
    expect(cleared?.fastFailWindowOverride).toBe(120);
  });

  it("the written tags drop the park status and carry a zeroed counter (what up() persists to disk)", () => {
    const cleared = clearParkForFreshSupervisor(tags({ status: FLAPPING_STATUS, consecutiveFastFails: LIMIT }));
    const written = writtenTags(cleared!);
    expect(written[TAG.status]).toBeUndefined(); // no park written — up() also REMOVES the on-disk status tag
    expect(written[TAG.consecutive]).toBe("0");
  });
});
