import test from "node:test";
import assert from "node:assert/strict";
import { format } from "../src/format.js";

// GREEN suite — the ghost stays latent because only the FIRST test reads the defaults; every later test
// fully overrides every option, so none of them observes the shared-default mutation. A correct fix keeps
// all of these green AND survives the added regression test (a default-format AFTER a custom call).
test("default formatting", () => {
  assert.equal(format("hi"), "[ hi ]");
});

test("custom prefix and suffix (full override)", () => {
  assert.equal(format("hi", { prefix: "<", suffix: ">", pad: 1 }), "< hi >");
});

test("custom everything (full override)", () => {
  assert.equal(format("go", { prefix: "(", suffix: ")", pad: 2 }), "(  go  )");
});
