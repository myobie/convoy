import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS } from "./command-table.ts";
import { declaredRunNotice, liveForceRefusal, livenessAgentFile, passedDeclarationFlags, resolveRunAction, staleFlagsNote } from "./run.ts";
import { agentBusId } from "./reconcile.ts";

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

// ---- The decision table: what `run` does about what already exists ----

describe("resolveRunAction — the four states a `convoy run` can find, plus the one refusal", () => {
  it("not declared → declare (write the agent file, launch, attach): the first-run path", () => {
    expect(resolveRunAction({ declared: false, live: false, force: false })).toBe("declare");
  });

  it("ACCEPTANCE: declared but NOT live → RESUME, never a refusal — this is the whole point of declaring", () => {
    // #92's `run` refused an identity that collided with a declared agent, and `add` refuses a re-declare
    // without --force. Inheriting either would break the headline property: an agent's durable context
    // survives a restart, so re-running a name you already declared is the everyday path, not a collision.
    expect(resolveRunAction({ declared: true, live: false, force: false })).toBe("resume");
  });

  it("declared AND live → attach to the running session (never restart it and lose in-flight state)", () => {
    expect(resolveRunAction({ declared: true, live: true, force: false })).toBe("attach");
  });

  it("declared, not live, --force → redeclare with the flags given now, then launch", () => {
    expect(resolveRunAction({ declared: true, live: false, force: true })).toBe("redeclare");
  });

  it("declared AND live AND --force → refuse: relaunching would double-spawn on the same pinned session id", () => {
    expect(resolveRunAction({ declared: true, live: true, force: true })).toBe("refuse-live-force");
  });

  it("--force on an UNdeclared agent is simply the declare path (nothing to overwrite)", () => {
    expect(resolveRunAction({ declared: false, live: false, force: true })).toBe("declare");
  });
});

describe("liveForceRefusal — points at the verb that actually does what was asked", () => {
  it("names `convoy reload`, the existing kill+respawn verb, rather than growing a second way to do it", () => {
    const m = liveForceRefusal("fodfix");
    expect(m).toContain("convoy reload fodfix");
    expect(m).toContain("SECOND session");
  });

  it("tells the caller that dropping --force attaches to the running agent", () => {
    expect(liveForceRefusal("fodfix")).toContain("convoy run --identity fodfix");
  });
});

describe("staleFlagsNote — never silently ignore a flag that looks like it changed something", () => {
  it("names the ignored flags and how to actually apply them", () => {
    const n = staleFlagsNote("fodfix", ["--model", "--harness"]);
    expect(n).toContain("--model, --harness");
    expect(n).toContain("--force");
    expect(n).toContain("EXISTING declaration");
  });

  it("says nothing when no declaration flags were passed (the clean resume)", () => {
    expect(staleFlagsNote("fodfix", [])).toBeNull();
  });

  it("agrees in number so the sentence reads correctly for a single flag", () => {
    expect(staleFlagsNote("fodfix", ["--model"])).toContain("--model was ignored");
  });
});

describe("passedDeclarationFlags — distinguishes declaration flags from per-invocation ones", () => {
  it("picks up flags that describe the DECLARATION", () => {
    expect(passedDeclarationFlags(["run", "--identity", "x", "--model", "m", "--permanent"])).toEqual(["--model", "--permanent"]);
  });

  it("ignores flags that only steer THIS invocation — they are not part of the agent file", () => {
    // --network/--dry-run/--no-attach/--force change what this command does, not what the agent IS, so
    // passing them on a resume is not a silently-ignored configuration change.
    expect(passedDeclarationFlags(["run", "--network", "n", "--dry-run", "--no-attach", "--force"])).toEqual([]);
  });
});

describe("livenessAgentFile — the single point where `run` agrees with `up` about what is running", () => {
  const declared = { identity: "x", role: "worker" as const, host: "otherbox" };
  const fromArgs = { identity: "x", role: "worker" as const, host: "thisbox" };

  it("ACCEPTANCE: keys on the EXISTING declaration — `up` reconciles on `af.host`, so `run` must too", () => {
    // `buildDeclaration` ALWAYS populates host (--host ?? this machine), so keying on the args-built file
    // computes a this-machine bus id for an agent declared `host = otherbox` (catalog file arrived via
    // fabric sync). run would find nothing live and launch a DUPLICATE beside the real one.
    expect(livenessAgentFile(declared, fromArgs)).toBe(declared);
    expect(livenessAgentFile(declared, fromArgs).host).toBe("otherbox");
  });

  it("falls back to the args-built file only when nothing is declared yet (the first-run path)", () => {
    expect(livenessAgentFile(null, fromArgs)).toBe(fromArgs);
  });

  it("keys identically to reconcile's agentBusId for an explicitly-hosted agent", () => {
    const thisHost = "thisbox";
    expect(agentBusId(livenessAgentFile(declared, fromArgs), thisHost)).toBe(agentBusId(declared, thisHost));
    expect(agentBusId(livenessAgentFile(declared, fromArgs), thisHost)).toBe("otherbox.x");
  });
});

describe("declaredRunNotice — states the guarantees, the exact inverse of #92's disclaimer", () => {
  it("ACCEPTANCE: says detaching leaves the agent RUNNING (a pty session outlives its client)", () => {
    const n = declaredRunNotice("fodfix", "dev3.fodfix", "dev3.fodfix");
    expect(n).toContain("detaching leaves it RUNNING");
  });

  it("promises reconcile + respawn + durable context — the things an ad-hoc session could never have", () => {
    const n = declaredRunNotice("fodfix", "dev3.fodfix", "dev3.fodfix");
    expect(n).toContain("convoy up");
    expect(n).toContain("context/ survives a restart");
  });

  it("tells the caller how to get back in, by the same command they just ran", () => {
    expect(declaredRunNotice("fodfix", "dev3.fodfix", "dev3.fodfix")).toContain("convoy run --identity fodfix");
  });

  it("points decommissioning at `retired = true`, not at `convoy down` (which only stops the session)", () => {
    expect(declaredRunNotice("fodfix", "dev3.fodfix", "dev3.fodfix")).toContain("retired = true");
  });

  it("carries NO ad-hoc disclaimer — the superseded wording must not survive anywhere", () => {
    const n = declaredRunNotice("fodfix", "dev3.fodfix", "dev3.fodfix");
    expect(n).not.toContain("ad-hoc");
    expect(n).not.toContain("NOT a declared");
  });
});

// ---- The command table: `run` must present as `add` + launch + attach ----

describe("`run` in the command table", () => {
  const runCmd = COMMANDS.find((c) => c.name === "run");
  const addCmd = COMMANDS.find((c) => c.name === "add");
  const names = (c: typeof runCmd): string[] => (c?.flags ?? []).map((f) => f.name).sort();

  it("is declared, so dispatch accepts its flags and completions cover it", () => {
    expect(runCmd).toBeDefined();
  });

  it("ACCEPTANCE: `run` offers exactly `add`'s flags plus --no-attach — the two verbs cannot drift apart", () => {
    // The claim of this design is "run IS add, plus launch and attach". If the flag sets diverge, that
    // claim is false at the surface the user actually touches.
    expect(names(runCmd)).toEqual([...names(addCmd), "no-attach"].sort());
  });

  it("has --permanent now: a run-created agent is a real catalog member, so always-on is coherent", () => {
    expect(runCmd?.flags?.some((f) => f.name === "permanent")).toBe(true);
  });

  it("has --host, so a run-created agent can be owned by a named host like any declared one", () => {
    expect(runCmd?.flags?.some((f) => f.name === "host")).toBe(true);
  });

  it("drops --prefix: the declaration carries the host prefix, and an override would desync session from agent file", () => {
    expect(runCmd?.flags?.some((f) => f.name === "prefix")).toBe(false);
  });

  it("ACCEPTANCE: the help text no longer advertises the superseded ad-hoc semantics", () => {
    expect(runCmd?.desc).not.toMatch(/ad-hoc|not declared|not reconciled|not respawned/i);
    expect(runCmd?.desc).toMatch(/declare/i);
  });
});

// ---- End to end, through the real CLI ----

describe("`convoy run` end to end", () => {
  let home: string;
  const setup = (): string => {
    home = mkdtempSync(join(tmpdir(), "cvr-"));
    return home;
  };
  const teardown = (): void => rmSync(home, { recursive: true, force: true });
  const catalogOf = (h: string): string => join(h, "convoy", "default", "catalog");

  it("ACCEPTANCE: WRITES a catalog entry — the defining inversion of #92, which wrote none", () => {
    const h = setup();
    try {
      mkdirSync(catalogOf(h), { recursive: true });
      const r = cli(["run", "worker", "--identity", "fodfix", "--dir", h, "--no-attach", "--dry-run"], h);
      expect(r.rc).toBe(0);
      // --dry-run shows the agent file it WOULD write; the declaration is the point, so it must be visible.
      expect(r.out).toContain('identity = "fodfix"');
      expect(r.out).toContain("agent file");
    } finally {
      teardown();
    }
  });

  it("ACCEPTANCE: requires --identity — a generated name is the hashed-name problem that kills durable context", () => {
    const h = setup();
    try {
      const r = cli(["run", "worker", "--dir", h, "--dry-run"], h);
      expect(r.rc).toBe(2);
      expect(r.err).toContain("--identity is required");
      // and it must explain WHY, since #92 accepted the omission happily
      expect(r.err).toContain("context/");
    } finally {
      teardown();
    }
  });

  it("ACCEPTANCE: an --identity that is already DECLARED resumes it — #92 refused this outright (rc=2)", () => {
    const h = setup();
    try {
      const catalog = catalogOf(h);
      mkdirSync(catalog, { recursive: true });
      writeFileSync(join(catalog, "cos.toml"), 'identity = "cos"\nrole = "chief-of-staff"\nworkspace = "' + h + '"\n');
      const r = cli(["run", "--identity", "cos", "--dry-run", "--no-attach"], h);
      expect(r.rc).toBe(0);
      expect(r.out).toContain("resuming the declared agent");
      expect(r.err).not.toContain("already a DECLARED agent");
    } finally {
      teardown();
    }
  });

  it("a resume does NOT rewrite the declaration — the catalog is the source of truth once it exists", () => {
    const h = setup();
    try {
      const catalog = catalogOf(h);
      mkdirSync(catalog, { recursive: true });
      const file = join(catalog, "cos.toml");
      const original = 'identity = "cos"\nrole = "chief-of-staff"\nworkspace = "' + h + '"\n';
      writeFileSync(file, original);
      const r = cli(["run", "--identity", "cos", "--model", "claude-fable-5", "--dry-run", "--no-attach"], h);
      expect(r.rc).toBe(0);
      expect(readFileSync(file, "utf8")).toBe(original); // untouched
      expect(r.out).toContain("--model"); // and it said so, rather than silently dropping it
    } finally {
      teardown();
    }
  });

  it("resolves an explicitly-hosted declaration to ITS host, not this machine's", () => {
    const h = setup();
    try {
      const catalog = catalogOf(h);
      mkdirSync(catalog, { recursive: true });
      writeFileSync(join(catalog, "elsewhere.toml"), 'identity = "elsewhere"\nrole = "worker"\nhost = "otherbox"\nworkspace = "' + h + '"\n');
      // No --host passed: the declaration's host must still win for the session ref and the bus id.
      const r = cli(["run", "--identity", "elsewhere", "--dry-run", "--no-attach"], h);
      expect(r.rc).toBe(0);
      expect(r.out).toContain("otherbox.elsewhere");
      expect(r.out).not.toContain(`${hostname().split(".")[0]?.toLowerCase()}.elsewhere`);
    } finally {
      teardown();
    }
  });

  it("accepts --permanent, which #92 rejected (rc=2) as a contradiction for an undeclared session", () => {
    const h = setup();
    try {
      mkdirSync(catalogOf(h), { recursive: true });
      const r = cli(["run", "worker", "--identity", "always", "--dir", h, "--permanent", "--dry-run", "--no-attach"], h);
      expect(r.rc).toBe(0);
      expect(r.out).toContain('strategy = "permanent"');
    } finally {
      teardown();
    }
  });

  it("validates the identity against the bus grammar BEFORE writing to the synced catalog", () => {
    const h = setup();
    try {
      mkdirSync(catalogOf(h), { recursive: true });
      const r = cli(["run", "worker", "--identity", "Worker_Fix", "--dir", h, "--dry-run"], h);
      expect(r.rc).toBe(2);
      expect(readdirSync(catalogOf(h))).toEqual([]);
    } finally {
      teardown();
    }
  });

  it("refuses with no workspace, exactly as `add` does — run inherits add's validation wholesale", () => {
    const h = setup();
    try {
      mkdirSync(catalogOf(h), { recursive: true });
      const r = cli(["run", "worker", "--identity", "nodir", "--dry-run"], h);
      const add = cli(["add", "worker", "--identity", "nodir", "--dry-run"], h);
      expect(r.rc).toBe(1);
      expect(r.err).toContain("no workspace");
      expect(add.err).toContain("no workspace"); // same message, same code path
    } finally {
      teardown();
    }
  });

  it("rejects an unknown flag rather than silently ignoring it (rc=2), like every other convoy command", () => {
    const h = setup();
    try {
      expect(cli(["run", "--nope"], h).rc).toBe(2);
    } finally {
      teardown();
    }
  });

  it("rejects an unknown role", () => {
    const h = setup();
    try {
      const r = cli(["run", "wizard", "--identity", "x", "--dry-run"], h);
      expect(r.rc).toBe(2);
      expect(r.err).toContain("unknown role");
    } finally {
      teardown();
    }
  });
});

describe("the ad-hoc model is GONE, not merely unused", () => {
  const src = readFileSync(join(root, "src", "run.ts"), "utf8");

  it("ACCEPTANCE: run.ts exports no ad-hoc machinery — two models in the codebase is the thing being removed", () => {
    expect(src).not.toContain("export function generateAdHocIdentity");
    expect(src).not.toContain("export function adHocNotice");
    expect(src).not.toContain("export function isAdHocIdentity");
    expect(src).not.toContain("export const AD_HOC_PREFIX");
  });

  it("commands.ts no longer imports or mints an ad-hoc identity", () => {
    const cmds = readFileSync(join(root, "src", "commands.ts"), "utf8");
    expect(cmds).not.toContain("generateAdHocIdentity(");
    expect(cmds).not.toContain("adHocNotice(");
    expect(cmds).not.toContain("validateRunIdentity(");
  });
});
