import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseFile, personasDir, personasInstalled, PERSONAS_REPO } from "./personas.ts";

const saved = process.env["CONVOY_PERSONAS_DIR"];
const dirs: string[] = [];
function tmpPersonas(withFiles: string[] = []): string {
  const d = mkdtempSync(join(tmpdir(), "convoy-personas-"));
  dirs.push(d);
  process.env["CONVOY_PERSONAS_DIR"] = d;
  for (const f of withFiles) writeFileSync(join(d, f), "# persona\n");
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (saved === undefined) delete process.env["CONVOY_PERSONAS_DIR"];
  else process.env["CONVOY_PERSONAS_DIR"] = saved;
});

describe("Personas (ported from PersonasTests.swift)", () => {
  it("personasDir honors CONVOY_PERSONAS_DIR", () => {
    const d = tmpPersonas();
    expect(personasDir()).toBe(d);
  });

  it("baseFile returns the role file when present, else null", () => {
    tmpPersonas(["worker.md"]);
    expect(baseFile("worker")).toMatch(/worker\.md$/);
    expect(baseFile("chief-of-staff")).toBeNull();
  });

  it("personasInstalled uses chief-of-staff.md as the sentinel", () => {
    tmpPersonas([]);
    expect(personasInstalled()).toBe(false);
    tmpPersonas(["chief-of-staff.md"]);
    expect(personasInstalled()).toBe(true);
  });

  it("clones the public personas repo (no auth needed)", () => {
    expect(PERSONAS_REPO).toBe("https://github.com/compoundingtech/personas.git");
  });
});
