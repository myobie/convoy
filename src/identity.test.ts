import { describe, expect, it } from "vitest";
import { isAgent } from "@compoundingtech/smalltalk";
import { isValidIdentity } from "./agent-spec.ts";
import { COUNTER_STEMS, counterContextRefusal, counterStem, identityByteBudget, identityErrors, isDeclarableIdentity, SUN_PATH_MAX } from "./identity.ts";

describe("identityErrors — one grammar, owned by the bus", () => {
  it("ACCEPTANCE (exact repro): worker_fodfix declared cleanly and was rejected by the bus", () => {
    // The defect this module exists to close. Convoy's own regex still says yes; the bus says no.
    expect(isValidIdentity("worker_fodfix")).toBe(true);
    expect(isAgent("worker_fodfix")).toBe(false);
    // Declare-time validation now agrees with the bus, and names the fix.
    expect(identityErrors("worker_fodfix")[0]).toMatch(/worker-fodfix/);
  });

  it("agrees with smalltalk on every name, rather than approximating it", () => {
    // Whatever the bus accepts, convoy accepts; whatever it rejects, convoy rejects. No second opinion.
    const names = ["fabric", "fabric-claude", "a.b.c", "x1", "worker_fodfix", "Worker", "worker-", "a..b", "-lead", "status", "inbox", "agents", ""];
    for (const n of names) {
      expect(isDeclarableIdentity(n), n).toBe(isAgent(n));
    }
  });

  it("rejects reserved bus names that would collide with an agent's own subfolders", () => {
    for (const n of ["inbox", "archive", "status", "resources", "agents"]) {
      expect(identityErrors(n).length, n).toBeGreaterThan(0);
    }
  });

  it("reports an empty identity as empty rather than as a charset problem", () => {
    expect(identityErrors("")).toEqual(["identity is empty"]);
  });

  it("scopes uniqueness to the network", () => {
    expect(identityErrors("fabric", { existing: ["fabric"] })).toHaveLength(1);
    expect(identityErrors("fabric", { existing: ["other"] })).toHaveLength(0);
  });
});

describe("identity length — derived from pty's socket, not a taste bound", () => {
  it("budgets exactly what pty leaves after PTY_ROOT, the prefix, and the .ding.sock suffix", () => {
    const root = "/n/pty";
    const prefix = "silber";
    const budget = identityByteBudget(root, prefix);
    // The longest path convoy can produce for this identity must fit pty's limit exactly at the boundary.
    const at = "x".repeat(budget);
    expect(Buffer.byteLength(`${root}/${prefix}.${at}.ding.sock`)).toBe(SUN_PATH_MAX);
    expect(identityErrors(at, { ptyRoot: root, prefix })).toHaveLength(0);
    expect(identityErrors(`${at}x`, { ptyRoot: root, prefix })).toHaveLength(1);
  });

  it("gives a network on a longer path a smaller budget (the bound is contextual)", () => {
    expect(identityByteBudget("/n/pty", "h")).toBeGreaterThan(identityByteBudget("/very/long/network/path/pty", "h"));
  });

  it("normalises a trailing slash the way path.join does, so the budget is not off by one", () => {
    expect(identityByteBudget("/n/pty/", "h")).toBe(identityByteBudget("/n/pty", "h"));
  });

  it("skips the length check when no network context is available rather than guessing a bound", () => {
    expect(identityErrors("a".repeat(200))).toHaveLength(0);
  });
});

describe("counter discriminators — convoy declines to seed, which is a default not an invariant", () => {
  it("recognises a counter under every role name and alias", () => {
    for (const stem of COUNTER_STEMS) expect(counterStem(`${stem}-1`), stem).toBe(stem);
    expect(counterStem("worker-12")).toBe("worker");
    expect(counterStem("wk-3")).toBe("wk");
  });

  it("sees through the harness suffix — worker-2-claude is still a counter", () => {
    expect(counterStem("worker-2-claude")).toBe("worker");
    expect(counterStem("worker-2-codex")).toBe("worker");
  });

  it("leaves MEANINGFUL discriminators alone — a named thing with a number is a name", () => {
    for (const n of ["fabric-2", "convoy", "fabric-claude", "triage-bot-7", "wk"]) {
      expect(counterStem(n), n).toBeNull();
      expect(counterContextRefusal(n), n).toBeNull();
    }
  });

  it("explains the inheritance failure it narrows, not just that it refused", () => {
    const msg = counterContextRefusal("worker-2");
    expect(msg).toMatch(/re-derives per parent lifetime/);
    expect(msg).toMatch(/context\/now\.md/);
  });

  it("is honest that it is a DEFAULT, not an invariant — the bus creates the dir on demand", () => {
    // Convoy can decline to seed context/; it cannot stop `st context write` from mkdir -p'ing it.
    // The message must not imply a guarantee convoy is not in a position to make (DELTA-005).
    const msg = counterContextRefusal("worker-2") ?? "";
    expect(msg).toMatch(/the bus still would on demand/);
  });

  it("does not make a counter-named identity undeclarable — only its durable context/ is refused", () => {
    // A short-lived counter-named agent is fine. What is refused is giving it MEMORY it can misattribute.
    expect(isDeclarableIdentity("worker-2")).toBe(true);
  });
});
