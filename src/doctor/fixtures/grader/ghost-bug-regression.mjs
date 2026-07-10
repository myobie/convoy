// HELD-OUT, mutation-valid grader for the ghost-bug dev-task check. Takes a repo path (argv[2]), imports
// its src/format.js, and asserts the bug is FIXED: a default-format call AFTER a custom call must be
// untouched. On the buggy src (`Object.assign(defaultOptions, options)` mutates the shared default) the
// custom call corrupts the defaults, so the later default call is wrong -> exit 1. On a correct non-mutating
// fix -> exit 0. This is ungameable: it targets exactly the call INTERACTION the fixture's own green suite
// deliberately never exercises, and it lives OUTSIDE the repo (the worker never sees it), so the worker
// can't tune to it. The check runs this against BOTH the worker's repo (must pass) and the pristine buggy
// fixture (must fail) — proving the fix is real AND the grader actually detects the bug (mutation-valid).
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import assert from "node:assert/strict";

const repo = process.argv[2];
if (!repo) {
  console.error("usage: node ghost-bug-regression.mjs <repo-path>");
  process.exit(2);
}

let format;
try {
  ({ format } = await import(pathToFileURL(join(repo, "src", "format.js")).href));
} catch (e) {
  console.error(`FAIL: could not import ${join(repo, "src", "format.js")}: ${e.message}`);
  process.exit(1);
}

// Corrupt-then-observe: a custom call first (mutates the shared default IFF the bug is present), THEN a
// plain default call that must still produce the default formatting.
format("warm", { prefix: "<", suffix: ">", pad: 3 });
try {
  assert.equal(format("hi"), "[ hi ]", "defaults must survive a preceding custom call");
  // And overrides must still work after the fix (didn't just hard-code the defaults).
  assert.equal(format("ok", { prefix: "(", suffix: ")", pad: 2 }), "(  ok  )", "overrides must still apply");
  console.log("PASS: ghost bug fixed — defaults survive a custom call, overrides still apply");
  process.exit(0);
} catch (e) {
  console.error(`FAIL: ghost bug present — ${e.message}`);
  process.exit(1);
}
