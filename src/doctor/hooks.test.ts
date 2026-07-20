import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactHookHealth, hooksNotLocated } from "./hooks.ts";

describe("hooksNotLocated — a can't-LOCATE is an honest WARN, never a false 'NOT found' (Nathan's bar)", () => {
  it("state is null (WARN), non-blocking, and the message asserts NO absence — it says 'couldn't verify' + how to", () => {
    const leg = hooksNotLocated();
    expect(leg.state).toBeNull(); // WARN, NOT false (a red hard-fail asserting absence)
    expect(leg.blocking).toBe(false); // never fails the doctor's rc on a can't-verify
    expect(leg.detail).toMatch(/couldn't LOCATE|not proof/i); // honest: it does not claim they're missing
    expect(leg.detail).toMatch(/SMALLTALK_DIR/); // tells the user how to verify
    expect(leg.detail).toMatch(/ST_BIN/); // names the off-PATH wiring (the Johannes cause)
    expect(leg.detail).not.toMatch(/\bNOT found\b/); // must not assert the false absence the old check did
  });
});

// The real fail-open shim we ship-by-reference (convoy points agents at smalltalk's copy). We reproduce its
// exact bytes here so the test doesn't depend on the smalltalk repo being checked out at a fixed path.
const GOOD_SHIM = [
  "#!/bin/bash",
  'impl="$(dirname "$0")/pre-compact.impl.sh"',
  'if [ -r "$impl" ]; then',
  '  /bin/bash "$impl" "$@" || true',
  "fi",
  "exit 0",
  "",
].join("\n");
const GOOD_IMPL = ["#!/bin/bash", "set -uo pipefail", "exit 0", ""].join("\n");
// The bash-3.2 killer: a heredoc nested inside $(). Parses fine on modern bash, fail-CLOSES on /bin/bash 3.2.
const UNPARSEABLE_IMPL = ["#!/bin/bash", 'x=$(cat <<E', "unterminated heredoc in a command substitution", ""].join("\n");
// A shim that PROPAGATES its impl's failure (the pre-#80 shape) — not fail-open.
const FAILCLOSED_SHIM = ['#!/bin/bash', 'impl="$(dirname "$0")/pre-compact.impl.sh"', '/bin/bash "$impl"', 'exit $?', ""].join("\n");

describe("compactHookHealth — the /compact-readiness preflight check", () => {
  let root: string;
  let hooks: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cvd-hooks-test-"));
    hooks = join(root, "examples", "claude-code", "hooks");
    mkdirSync(hooks, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const write = (name: string, body: string): void => writeFileSync(join(hooks, name), body);

  it("passes a healthy #80 two-file hook (shim + impl, parse-safe, fail-open)", async () => {
    write("pre-compact.sh", GOOD_SHIM);
    write("pre-compact.impl.sh", GOOD_IMPL);
    const r = await compactHookHealth(root);
    expect(r.ok).toBe(true);
  });

  it("fails when the shim is missing entirely", async () => {
    const r = await compactHookHealth(root);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/missing/i);
  });

  it("fails a half-installed #80 hook (shim present, sibling impl missing)", async () => {
    write("pre-compact.sh", GOOD_SHIM);
    const r = await compactHookHealth(root);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/impl\.sh is MISSING/);
  });

  it("catches the bash-3.2 heredoc-in-$() that wedged the network (impl parse error)", async () => {
    write("pre-compact.sh", GOOD_SHIM);
    write("pre-compact.impl.sh", UNPARSEABLE_IMPL);
    const r = await compactHookHealth(root);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/does NOT parse/);
  });

  it("catches a fail-CLOSED shim that propagates a broken impl's failure", async () => {
    // Shim parses fine + impl parses fine, but the shim isn't fail-open: our broken-impl probe must reject it.
    write("pre-compact.sh", FAILCLOSED_SHIM);
    write("pre-compact.impl.sh", GOOD_IMPL);
    const r = await compactHookHealth(root);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/NOT fail-open/);
  });
});
