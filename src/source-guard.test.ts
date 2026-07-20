import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classify, exportedAsyncFunctions, functionBody, stripComments } from "./source-guard.ts";

const here = dirname(fileURLToPath(import.meta.url));

// A source guard that greps RAW text is defeated by a comment — that is the whole reason this module exists,
// so it is the first thing tested. Every case below is a way a "guard" can be made vacuous while the code it
// claims to protect is gone.
describe("stripComments — a guard must not be satisfiable by a comment", () => {
  it("ACCEPTANCE: a commented-out call does NOT survive (the attack that defeated the shipped doctor guard)", () => {
    const src = `
      // TODO: runConvoy(box, ["up", box.net, "--once"]) -- disabled
      const x = 1;
    `;
    expect(src).toContain('runConvoy(box, ["up", box.net, "--once"])'); // a raw grep is satisfied…
    expect(stripComments(src)).not.toContain("runConvoy"); // …the stripped source is not.
  });

  it("a block-commented call does not survive either", () => {
    expect(stripComments(`/* runConvoy(box, ["up"]) */ const x = 1;`)).not.toContain("runConvoy");
  });

  it("a trailing comment after real code strips, but the real code stays", () => {
    const s = stripComments(`await realCall(); // await realCall() again`);
    expect(s).toContain("await realCall();");
    expect(s.match(/realCall/g)).toHaveLength(1);
  });

  it("keeps the source line-aligned so guard failures still point at the right place", () => {
    const src = "a();\n// gone\nb();\n";
    expect(stripComments(src).split("\n")).toHaveLength(src.split("\n").length);
    expect(stripComments(src).split("\n")[2]).toBe("b();");
  });
});

// The naive tokenizer breaks on convoy's own source and fails OPEN (it eats the rest of the file, so every
// downstream guard silently passes on empty text). These are the shapes that actually occur in src/.
describe("classify — the shapes that break a naive scanner (a broken scanner = a vacuous guard)", () => {
  it("a regex literal containing QUOTE characters does not open a string (up.ts busIdOf's ST_AGENT regex)", () => {
    const src = `const m = s.match(/ST_AGENT\\s*=\\s*"([^"]+)"/);\nconst keep = realCall();`;
    expect(stripComments(src)).toContain("realCall()"); // …not swallowed as string text
    const kind = classify(src);
    expect(kind[src.indexOf("realCall")]).toBe(0); // CODE
  });

  it("`//` inside a string is not a comment", () => {
    expect(stripComments(`const u = "https://example.com/x"; const keep = 1;`)).toContain("https://example.com/x");
  });

  it("`//` inside a template literal is not a comment", () => {
    expect(stripComments("const u = `https://x`; const keep = 1;")).toContain("https://x");
  });

  it("a comment marker inside a string does not comment out the code after it", () => {
    expect(stripComments(`const s = "/* not a comment */"; realCall();`)).toContain("realCall()");
  });

  it("an apostrophe inside a double-quoted string does not desync the scanner", () => {
    expect(stripComments(`const s = "don't"; realCall();`)).toContain("realCall()");
  });
});

describe("functionBody — brace-matched, so a guard reads the RIGHT function", () => {
  const src = `
export async function alpha(): Promise<void> {
  const nested = { a: 1 };
  if (x) { call("alpha-only"); }
}
export async function beta(): Promise<void> {
  call("beta-only");
}
`;
  it("stops at the function's real closing brace, not at the next export", () => {
    expect(functionBody(src, "alpha")).toContain("alpha-only");
    expect(functionBody(src, "alpha")).not.toContain("beta-only");
  });

  it("does not miscount braces that live inside strings or template literals", () => {
    const s = `export async function f(): Promise<void> {\n  const a = "}";\n  const b = \`\${x}\`;\n  call("inside");\n}\nconst after = 1;`;
    expect(functionBody(s, "f")).toContain("inside");
    expect(functionBody(s, "f")).not.toContain("after");
  });

  it("returns null for a function that does not exist (a guard must FAIL, never silently pass, on a rename)", () => {
    expect(functionBody(src, "gamma")).toBeNull();
  });

  it("strips comments from the body it returns", () => {
    expect(functionBody(`export async function f() {\n // ghost();\n real();\n}`, "f")).not.toContain("ghost");
  });
});

describe("exportedAsyncFunctions — derives the check list instead of hardcoding it", () => {
  it("finds every exported async function, in order", () => {
    expect(exportedAsyncFunctions(`export async function a() {}\nexport function b() {}\nexport async function c() {}`)).toEqual(["a", "c"]);
  });

  it("ignores one that exists only in a comment", () => {
    expect(exportedAsyncFunctions(`// export async function ghost() {}\nexport async function real() {}`)).toEqual(["real"]);
  });

  it("reads convoy's real doctor suite (the guard's actual input) and finds the readiness checks", () => {
    const src = readFileSync(join(here, "doctor", "suite.ts"), "utf8");
    const checks = exportedAsyncFunctions(src).filter((n) => n.startsWith("check"));
    expect(checks).toContain("checkDevTask");
    expect(checks).toContain("checkFullOrg");
    expect(checks.length).toBeGreaterThan(4);
  });
});
