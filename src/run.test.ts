import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isValidIdentity } from "./agent-spec.ts";
import { COMMANDS } from "./command-table.ts";
import { AD_HOC_PREFIX, adHocNotice, generateAdHocIdentity, isAdHocIdentity, validateRunIdentity } from "./run.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bin = join(root, "bin", "convoy");

/** Run the real CLI against a throwaway network. Never touches a live root: XDG_STATE_HOME is a temp dir,
 *  so `resolveNetworkRoot` lands under it (see paths.ts), and ST_ROOT/PTY_ROOT are scrubbed so an ambient
 *  value from the operator's shell cannot select a production root (the DQ5 footgun). */
function cli(args: string[], home: string): { rc: number; out: string; err: string } {
  const r = spawnSync(process.execPath, [bin, ...args], {
    encoding: "utf8",
    env: { ...process.env, XDG_STATE_HOME: home, ST_ROOT: "", PTY_ROOT: "" },
  });
  return { rc: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

describe("ad-hoc identity generation", () => {
  it("mints `run-<random>` — the prefix is what makes a session visibly undeclared in `pty ls` / `st agents`", () => {
    const id = generateAdHocIdentity(() => 0.123456789);
    expect(id.startsWith(AD_HOC_PREFIX)).toBe(true);
    expect(isAdHocIdentity(id)).toBe(true);
  });

  it("produces an identity the bus grammar accepts — a name convoy mints must be one smalltalk can bind", () => {
    // #88 item 2's failure ordering: a name that launches cleanly and is then rejected by the bus is the
    // worst case. A GENERATED name has no operator to blame, so it must be valid by construction.
    for (let i = 0; i < 200; i++) {
      expect(isValidIdentity(generateAdHocIdentity())).toBe(true);
    }
  });

  it("stays short, so the ding socket path fits its budget", () => {
    // pty binds `<PTY_ROOT>/<prefix>.<identity>.ding.sock` against a limited sun_path. A generated name
    // must not be what pushes a network over that edge.
    expect(generateAdHocIdentity().length).toBeLessThanOrEqual(12);
  });

  it("is RANDOM, not a counter — a counter re-derives and would hand a restart a stranger's context (#88 item 6)", () => {
    // The whole reason a generated name is tolerable here: `run-<random>` never recurs, so the silent
    // inherit-someone-else's-`now.md` failure is impossible rather than merely discouraged.
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(generateAdHocIdentity());
    expect(seen.size).toBeGreaterThan(490);
  });

  it("respects an injected random source, so the generator is testable without stubbing globals", () => {
    let n = 0;
    const seq = (): number => [0.111111, 0.222222, 0.333333][n++ % 3]!;
    const a = generateAdHocIdentity(seq);
    n = 0;
    expect(generateAdHocIdentity(seq)).toBe(a);
  });
});

describe("validateRunIdentity", () => {
  it("rejects a name the bus grammar would refuse", () => {
    expect(validateRunIdentity("Worker_Fix", [])).toContain("invalid identity");
  });

  it("REFUSES to reuse a declared agent's identity — an ad-hoc session must never open a declared agent's bus folder", () => {
    // The mirror image of #88 item 6: reading a stranger's durable context, arrived at from the other
    // direction. A declared agent that is merely DOWN right now still owns its context/.
    const problem = validateRunIdentity("cos", ["cos", "fabric"]);
    expect(problem).toContain("already a DECLARED agent");
    expect(problem).toContain("convoy up");
  });

  it("accepts a fresh, well-formed name", () => {
    expect(validateRunIdentity("scratch", ["cos"])).toBeNull();
  });
});

describe("adHocNotice", () => {
  it("names every property the session does NOT have, so nobody reads it as equivalent to a declared one", () => {
    const notice = adHocNotice("run-abc123", "dev3.run-abc123", "worker");
    expect(notice).toContain("NOT a declared catalog member");
    expect(notice).toMatch(/respawn|recover/);
    expect(notice).toContain("no durable context");
    expect(notice).toContain("dev3.run-abc123");
  });

  it("points at the declared path — the counter-pressure against `run` quietly becoming the default", () => {
    expect(adHocNotice("run-abc123", "dev3.run-abc123", "worker")).toContain("convoy add");
  });
});

describe("`run` in the command table", () => {
  const run = COMMANDS.find((c) => c.name === "run");

  it("is declared, so dispatch accepts its flags and completions cover it", () => {
    expect(run).toBeDefined();
  });

  it("has NO --permanent flag: a permanent ad-hoc session is a contradiction — nothing declares it, so nothing can bring it back", () => {
    expect(run?.flags?.some((f) => f.name === "permanent")).toBe(false);
  });

  it("offers --config-dir, the account selection the launcher aliases it replaces actually used", () => {
    expect(run?.flags?.some((f) => f.name === "config-dir")).toBe(true);
  });
});

describe("`convoy run` end to end", () => {
  let home: string;
  const setup = (): string => {
    home = mkdtempSync(join(tmpdir(), "convoy-run-"));
    return home;
  };
  const teardown = (): void => rmSync(home, { recursive: true, force: true });

  it("writes NO catalog entry — the defining property: an ad-hoc session is not a declared member", () => {
    const h = setup();
    try {
      const net = join(h, "convoy", "default");
      const catalog = join(net, "catalog");
      mkdirSync(catalog, { recursive: true });
      const r = cli(["run", "--dry-run", "--dir", h], h);
      expect(readdirSync(catalog)).toEqual([]);
      expect(r.out).toContain("ad-hoc session");
    } finally {
      teardown();
    }
  });

  it("prints the contract disclosure on every launch, not behind a flag", () => {
    const h = setup();
    try {
      const r = cli(["run", "--dry-run", "--dir", h], h);
      expect(r.out).toContain("NOT a declared catalog member");
      expect(r.out).toContain("convoy add");
    } finally {
      teardown();
    }
  });

  it("refuses an --identity that collides with a declared agent (rc=2), before doing anything", () => {
    const h = setup();
    try {
      const catalog = join(h, "convoy", "default", "catalog");
      mkdirSync(catalog, { recursive: true });
      writeFileSync(join(catalog, "cos.toml"), 'identity = "cos"\nrole = "chief-of-staff"\n');
      const r = cli(["run", "--identity", "cos", "--dry-run", "--dir", h], h);
      expect(r.rc).toBe(2);
      expect(r.err).toContain("already a DECLARED agent");
    } finally {
      teardown();
    }
  });

  it("rejects an unknown flag rather than silently ignoring it (rc=2), like every other convoy command", () => {
    const h = setup();
    try {
      const r = cli(["run", "--nope"], h);
      expect(r.rc).toBe(2);
      expect(r.err).toContain("unrecognized flag");
    } finally {
      teardown();
    }
  });

  it("rejects --permanent: respawn semantics are not available to an undeclared session", () => {
    const h = setup();
    try {
      const r = cli(["run", "--permanent", "--dry-run"], h);
      expect(r.rc).toBe(2);
    } finally {
      teardown();
    }
  });

  it("rejects an unknown role", () => {
    const h = setup();
    try {
      const r = cli(["run", "wizard", "--dry-run"], h);
      expect(r.rc).toBe(2);
      expect(r.err).toContain("unknown role");
    } finally {
      teardown();
    }
  });
});

describe("adHocNotice — the declared-path suggestion", () => {
  it("suggests a PLACEHOLDER name, never the generated one: a meaningless declared name is what breaks continuity", () => {
    const notice = adHocNotice("run-b3ur0v", "dev3.run-b3ur0v", "worker");
    expect(notice).toContain("<a-meaningful-name>");
    expect(notice).not.toContain("--identity b3ur0v");
  });

  it("carries the actual role into the suggestion, so the suggested command is runnable as printed", () => {
    expect(adHocNotice("run-x1", "dev3.run-x1", "supervisor")).toContain("convoy add supervisor");
  });

  it("does not claim a per-launch identity when the operator named the session explicitly", () => {
    const named = adHocNotice("scratch", "dev3.scratch", "worker");
    expect(named).not.toContain("minted per launch");
    expect(named).toContain("NOT a declared catalog member");
  });
});
