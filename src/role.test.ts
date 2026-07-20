import { describe, it, expect } from "vitest";
import { isSpawner, parseRole, permanentByRole, permissionMode, personaBaseFilename, type Role } from "./role.ts";

describe("Role table (ported from Role.swift + AgentSpecTests)", () => {
  it("parses canonical names + aliases; rejects unknowns", () => {
    expect(parseRole("chief-of-staff")).toBe("chief-of-staff");
    expect(parseRole("cos")).toBe("chief-of-staff");
    expect(parseRole("spawner")).toBe("chief-of-staff");
    expect(parseRole("sup")).toBe("supervisor");
    expect(parseRole("wk")).toBe("worker");
    expect(parseRole("tm")).toBe("technical-manager");
    expect(parseRole("manager")).toBe("technical-manager");
    expect(parseRole("WORKER")).toBe("worker");
    expect(parseRole("nonsense")).toBeNull();
  });

  it("derives permission-mode from role (spawners bypass; workers auto)", () => {
    expect(permissionMode("chief-of-staff")).toBe("bypassPermissions");
    expect(permissionMode("supervisor")).toBe("bypassPermissions");
    expect(permissionMode("technical-manager")).toBe("bypassPermissions");
    expect(permissionMode("worker")).toBe("auto");
  });

  it("marks spawner-class roles", () => {
    const spawners: Role[] = ["chief-of-staff", "supervisor", "technical-manager"];
    for (const r of spawners) expect(isSpawner(r)).toBe(true);
    expect(isSpawner("worker")).toBe(false);
  });

  it("derives permanent-by-role: only the CoS", () => {
    expect(permanentByRole("chief-of-staff")).toBe(true);
    expect(permanentByRole("supervisor")).toBe(false);
    expect(permanentByRole("worker")).toBe(false);
    expect(permanentByRole("technical-manager")).toBe(false);
  });

  it("persona base filename", () => {
    expect(personaBaseFilename("worker")).toBe("worker.md");
    expect(personaBaseFilename("chief-of-staff")).toBe("chief-of-staff.md");
  });
});

describe("the agent spec's role names", () => {
  it("accepts `root` as the spec spells it, mapping to convoy's chief-of-staff", () => {
    // The published field table says `root` — a spec written to it must not be rejected outright.
    expect(parseRole("root")).toBe("chief-of-staff");
  });

  it("accepts every other role the spec names, verbatim", () => {
    for (const r of ["supervisor", "worker", "technical-manager"]) expect(parseRole(r)).toBe(r);
  });
});
