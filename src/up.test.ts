import { describe, it, expect, afterEach } from "vitest";
import { crashDingTargets, resolveRoot, workerCrashed } from "./up.ts";
import { PtyHost, type SupervisedSession } from "./host.ts";
import { networkDirForName } from "./paths.ts";

const sess = (name: string, tags: Record<string, string>): SupervisedSession => ({ name, cwd: null, command: "", args: [], status: "running" as never, pid: null, exitedAt: null, exitCode: null, tags });
// Test resolver: read the bus id from a plain "busId" tag (the real one reads ST_AGENT out of the pty.toml).
const resolve = (s: SupervisedSession): string | null => s.tags["busId"] ?? null;

describe("crashDingTargets — cos + the crashed one's spawner (NOT the whole permanent crew)", () => {
  const cos = sess("cos", { "ptyfile.session": "claude", strategy: "permanent", "convoy.tier": "cos", busId: "cos-claude" });
  // Unrelated repo-owner agents — long-lived, so they run --permanent, but they are NOT orchestrators.
  const appApple = sess("app-apple", { "ptyfile.session": "claude", strategy: "permanent", busId: "app-apple-claude" });
  const evals = sess("evals", { "ptyfile.session": "claude", strategy: "permanent", busId: "evals-claude" });
  const sup = sess("sup", { "ptyfile.session": "claude", strategy: "permanent", busId: "sup-claude" });

  it("ACCEPTANCE: a worker crash pages ONLY cos + the worker's spawner — NOT unrelated permanent agents (Nathan's bug)", () => {
    const crashed = sess("wk", { "ptyfile.session": "claude", busId: "crashtest", "convoy.spawner": "sup-claude" });
    const targets = crashDingTargets(crashed, [cos, sup, appApple, evals, crashed], [], resolve).sort();
    expect(targets).toEqual(["cos-claude", "sup-claude"]); // app-apple-claude / evals-claude NOT paged
    expect(targets).not.toContain("app-apple-claude");
  });

  it("dings ONLY cos when the crashed worker has no spawner tag (human-spawned → cos backstop only)", () => {
    const crashed = sess("wk", { "ptyfile.session": "claude", busId: "crashtest" }); // no convoy.spawner
    expect(crashDingTargets(crashed, [cos, appApple, crashed], [], resolve)).toEqual(["cos-claude"]);
  });

  it("dedups when the spawner IS cos (cos spawned it directly) → a single cos ding", () => {
    const crashed = sess("wk", { "ptyfile.session": "claude", busId: "crashtest", "convoy.spawner": "cos-claude" });
    expect(crashDingTargets(crashed, [cos, crashed], [], resolve)).toEqual(["cos-claude"]);
  });

  it("adds --notify ids, dedups, and NEVER self-dings the crasher (even if it is the cos-tier)", () => {
    // cos itself crashes: excluded from its own ding despite being cos-tier; notify still delivered + deduped.
    expect(crashDingTargets(cos, [cos], ["extra", "cos-claude", "cos-claude"], resolve).sort()).toEqual(["extra"]);
  });

  it("skips an unresolvable cos-tier session (never dings a null/empty target)", () => {
    const cosNoBus = sess("cos2", { "ptyfile.session": "claude", "convoy.tier": "cos" }); // no busId → resolve() null
    const crashed = sess("wk", { "ptyfile.session": "claude", busId: "crashtest", "convoy.spawner": "sup-claude" });
    expect(crashDingTargets(crashed, [cos, cosNoBus, sup, crashed], [], resolve).sort()).toEqual(["cos-claude", "sup-claude"]);
  });
});

describe("resolveRoot + PtyHost — pin PTY_ROOT to the target network's own registry (the by-name / no-arg launch-0 bug)", () => {
  // PtyHost's constructor MUTATES process.env.PTY_ROOT (it pins the network's pty registry) — save/restore the
  // whole set so one test's pin never leaks into the next.
  const saved = { PTY_ROOT: process.env["PTY_ROOT"], CONVOY_NETWORK: process.env["CONVOY_NETWORK"], ST_ROOT: process.env["ST_ROOT"], XDG_STATE_HOME: process.env["XDG_STATE_HOME"] };
  const restore = (k: keyof typeof saved): void => {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  };
  afterEach(() => (Object.keys(saved) as (keyof typeof saved)[]).forEach(restore));

  it("resolveRoot: a NAME resolves under convoy's home, a PATH is used as-is", () => {
    process.env["XDG_STATE_HOME"] = "/x";
    expect(resolveRoot("default")).toBe("/x/convoy/default");
    expect(resolveRoot("staging")).toBe("/x/convoy/staging");
    expect(resolveRoot("/tmp/explicit")).toBe("/tmp/explicit");
  });

  it("resolveRoot: no arg falls back to CONVOY_NETWORK (set by `convoy env`/`shell`) over ST_ROOT", () => {
    process.env["CONVOY_NETWORK"] = "/net/dir";
    process.env["ST_ROOT"] = "/net/dir/smalltalk";
    expect(resolveRoot(undefined)).toBe("/net/dir");
  });

  it("resolveRoot: the up.ts defaultRoot() twin of the catalog footgun — no CONVOY_NETWORK, ST_ROOT=<net>/smalltalk → <net> (strips the bus-root segment)", () => {
    delete process.env["CONVOY_NETWORK"];
    process.env["ST_ROOT"] = "/net/dir/smalltalk";
    expect(resolveRoot(undefined)).toBe("/net/dir"); // NOT /net/dir/smalltalk — else up reads catalog/pty from the bus-root subtree
  });

  it("ACCEPTANCE: a bogus ambient PTY_ROOT is OVERRIDDEN — `convoy up default` (by NAME) pins PTY_ROOT to the network's OWN pty dir", () => {
    // Repro of cos's migration bug: the shell has a stale/foreign PTY_ROOT; running up by name must retarget it.
    process.env["XDG_STATE_HOME"] = "/x";
    process.env["PTY_ROOT"] = "/some/bogus/foreign/pty";
    const root = resolveRoot("default"); // the by-NAME path — was left unresolved + PtyHost got null before the fix
    new PtyHost(root); // constructing the host is what pins PTY_ROOT (as `up`/`down` do)
    expect(process.env["PTY_ROOT"]).toBe(`${networkDirForName("default")}/pty`); // network's own registry, NOT the bogus value
    expect(process.env["PTY_ROOT"]).not.toBe("/some/bogus/foreign/pty");
  });

  it("ACCEPTANCE: the no-arg default (`convoy up`) also re-pins a bogus ambient PTY_ROOT to CONVOY_NETWORK's pty dir", () => {
    process.env["CONVOY_NETWORK"] = "/net/dir";
    process.env["PTY_ROOT"] = "/some/bogus/foreign/pty";
    new PtyHost(resolveRoot(undefined));
    expect(process.env["PTY_ROOT"]).toBe("/net/dir/pty");
  });

  it("REGRESSION GUARD: the OLD shape `new PtyHost(null)` leaves the ambient PTY_ROOT unpinned (the bug the fix closes)", () => {
    // Before the fix, up/down passed `opts.network ?? null` → null for the default → PtyHost skipped pinning →
    // host.sessions() read this stale value → reconcile launched 0 against the wrong registry.
    process.env["PTY_ROOT"] = "/some/bogus/foreign/pty";
    new PtyHost(null);
    expect(process.env["PTY_ROOT"]).toBe("/some/bogus/foreign/pty"); // NOT re-pinned — exactly the failure mode
  });
});

describe("workerCrashed — the worker negative-control gate (crash → ding, clean exit → silent)", () => {
  it("a nonzero exit is a crash (dings)", () => {
    expect(workerCrashed("exited", 1)).toBe(true);
    expect(workerCrashed("exited", 137)).toBe(true); // OOM-kill signal
  });
  it("a CLEAN exit (code 0) is NOT a crash (stays silent) — the hard negative control", () => {
    expect(workerCrashed("exited", 0)).toBe(false);
  });
  it("a hard 'vanished' death (no exit record) is a crash", () => {
    expect(workerCrashed("vanished", null)).toBe(true);
  });
  it("a NULL exit (daemon wrote no exit code — a no-record death) is a crash — defense-in-depth", () => {
    // NB: an OOM of the AGENT process itself records 137 via pty ≥ #72 (convoy execs the harness → direct child) and
    // is caught by the nonzero leg above — see the Case A/B note on workerCrashed. This null leg guards a genuine
    // no-record exit; the only uncaught OOM is a reaped-grandchild (Case B), which is an OS-level follow-up.
    expect(workerCrashed("exited", null)).toBe(true);
  });
  it("no exit code + still running is not a crash", () => {
    expect(workerCrashed("running", null)).toBe(false);
  });
});
