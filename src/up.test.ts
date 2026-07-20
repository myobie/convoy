import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crashDingTargets, emitWrites, makeEmit, resolveRoot, workerCrashed } from "./up.ts";
import { functionBody } from "./source-guard.ts";
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

describe("emitWrites — one supervisor log line, printed ONCE (the doubled-log bug)", () => {
  const obj = { type: "up", network: "/n" };
  const human = "hosting /n (reconcile every 30s, cap 3 fails / 60s)";

  it("ACCEPTANCE: without --json the human line appears EXACTLY ONCE across both streams", () => {
    // Repro of the bug: `convoy up` writes both streams to the same terminal, so a human line emitted to
    // stderr AND stdout printed twice — every reconcile line doubled.
    const w = emitWrites(obj, human, false);
    const all = [...w.stderr, ...w.stdout];
    expect(all.filter((l) => l.includes(human))).toHaveLength(1);
  });

  it("without --json the human line goes to stderr and stdout stays EMPTY", () => {
    expect(emitWrites(obj, human, false)).toEqual({ stderr: [`${human}\n`], stdout: [] });
  });

  it("with --json stdout carries the JSONL record and stderr still carries the human line (once)", () => {
    const w = emitWrites(obj, human, true);
    expect(w.stderr).toEqual([`${human}\n`]);
    expect(w.stdout).toEqual([`${JSON.stringify(obj)}\n`]);
    expect(JSON.parse(w.stdout[0]!)).toEqual(obj); // stdout stays a parseable JSONL stream
    expect(w.stdout[0]).not.toContain(human); // ...never the human text
  });

  it("every line is newline-terminated on both streams (JSONL framing)", () => {
    for (const json of [true, false]) {
      const w = emitWrites(obj, human, json);
      for (const l of [...w.stderr, ...w.stdout]) expect(l.endsWith("\n")).toBe(true);
    }
  });
});

// The tests above cover the DECISION (`emitWrites`). They do not cover the WIRING — the code that actually
// pushes those strings at the two streams — and the wiring is where the doubled-log bug lived. With the
// wiring inline in `up()` it was unreachable from a test: restoring the bug verbatim (write `human` to
// stderr AND stdout) left the suite byte-identical AND `tsc` clean, so the exact defect this fixes could be
// reintroduced with nothing to catch it. `makeEmit` exists to close that: it IS the wiring, and it takes
// its sinks so a test can drive the real emitter and count what each stream received.
describe("makeEmit — the WIRING: what actually reaches each stream (the doubled-log bug lived HERE)", () => {
  const obj = { type: "up", network: "/n" };
  const human = "hosting /n (reconcile every 30s, cap 3 fails / 60s)";
  const capture = (json: boolean): { out: string[]; err: string[] } => {
    const out: string[] = [];
    const err: string[] = [];
    makeEmit(
      json,
      (s) => out.push(s),
      (s) => err.push(s),
    )(obj, human);
    return { out, err };
  };

  it("ACCEPTANCE: without --json the emitter puts the human line on the streams EXACTLY ONCE in total", () => {
    // The bug, stated as the user saw it: both streams land on the same terminal, so a human line written
    // to each printed every supervisor line twice. This fails if the wiring is reverted to writing both.
    const { out, err } = capture(false);
    expect([...out, ...err].filter((l) => l.includes(human))).toHaveLength(1);
  });

  it("ACCEPTANCE: without --json NOTHING at all reaches stdout", () => {
    expect(capture(false).out).toEqual([]);
    expect(capture(false).err).toEqual([`${human}\n`]);
  });

  it("with --json stdout receives the JSONL record and ONLY that; the human line stays on stderr, once", () => {
    const { out, err } = capture(true);
    expect(out).toEqual([`${JSON.stringify(obj)}\n`]);
    expect(out[0]).not.toContain(human);
    expect(err).toEqual([`${human}\n`]);
    expect([...out, ...err].filter((l) => l.includes(human))).toHaveLength(1);
  });

  it("routes to the two sinks independently — a stdout sink never receives a stderr write", () => {
    // Guards the swap: wiring stderr's lines into the stdout sink is the other way to reopen this.
    const { out, err } = capture(true);
    for (const l of out) expect(l).not.toContain(human);
    for (const l of err) expect(l).toBe(`${human}\n`);
  });
});

// …and the last hop: that `up()` actually USES that emitter rather than re-inlining its own writes. This is
// the only part of the seam a runtime test can't reach (`up()` acquires a host lock, shells out to pty and
// fabric, and then loops), so it is held structurally — against COMMENT-STRIPPED source, so it cannot be
// satisfied by a comment. See src/source-guard.ts.
describe("up() wiring: the supervisor log goes through makeEmit, never straight at stdout", () => {
  const body = functionBody(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "up.ts"), "utf8"), "up");

  it("up() is found (a rename must fail this guard, not silently vacate it)", () => {
    expect(body).not.toBeNull();
  });

  it("ACCEPTANCE: up() binds its emitter with makeEmit", () => {
    expect(body, "up() no longer routes its log lines through makeEmit — the doubled-log seam is reopened").toContain("makeEmit(json)");
  });

  it("ACCEPTANCE: up() never writes to stdout directly — stdout is the JSONL stream, owned by emitWrites", () => {
    // The bug verbatim was `process.stdout.write(json ? … : \`${human}\n\`)` inline in up(). Any direct
    // stdout write in up() is that seam reopening, whatever it writes.
    expect(body, "up() writes to process.stdout directly — the human line must only ever reach stdout via emitWrites/--json").not.toContain("process.stdout.write");
  });
});
