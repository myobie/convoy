import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { catalogDir } from "./agent-file.ts";
import { newAgentSpecPath, pathDefaults, readCatalog } from "./catalog.ts";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** A network dir with a catalog holding the given files, keyed by path relative to `catalog/`. */
function net(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "convoy-catalog-"));
  roots.push(d);
  for (const [rel, text] of Object.entries(files)) {
    const p = join(catalogDir(d), rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  return d;
}

describe("readCatalog — discovery slurps the tree", () => {
  it("finds specs at any depth, in every format, and reads identity from CONTENT not the filename", () => {
    const d = net({
      "flat.toml": `identity = "alpha"\nrole = "worker"\nsupervisor = "cos"\n`,
      "silber/beta/agent.kdl": `identity "beta"\nrole "worker"\nsupervisor "cos"\n`,
      "a/b/c/anything.json": JSON.stringify({ identity: "gamma", role: "worker", supervisor: "cos" }),
    });
    const { entries, errors } = readCatalog(d);
    expect(errors).toEqual([]);
    // `flat.toml` declares `alpha` — the filename stem is NOT the identity.
    expect(entries.map((e) => e.af.identity).sort()).toEqual(["alpha", "beta", "gamma"]);
  });

  it("skips non-spec files instead of reporting them as malformed agents", () => {
    const d = net({
      "README.md": "not a spec",
      "shared.toml": `# a fragment, no identity/role\nsome_key = "value"\n`,
      "notes.json": JSON.stringify({ unrelated: true }),
      "real.toml": `identity = "alpha"\nrole = "worker"\nsupervisor = "cos"\n`,
    });
    const { entries, errors } = readCatalog(d);
    expect(errors).toEqual([]);
    expect(entries).toHaveLength(1);
  });

  it("returns empty for a network with no catalog yet, rather than throwing", () => {
    const d = mkdtempSync(join(tmpdir(), "convoy-catalog-"));
    roots.push(d);
    expect(readCatalog(d)).toEqual({ entries: [], errors: [], warnings: [] });
  });

  it("skips ONE malformed spec without wedging the rest of the reconcile", () => {
    const d = net({
      "good.toml": `identity = "alpha"\nrole = "worker"\nsupervisor = "cos"\n`,
      "bad.toml": `identity = "beta"\n`, // no role
    });
    const { entries, errors } = readCatalog(d);
    expect(entries.map((e) => e.af.identity)).toEqual(["alpha"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toMatch(/role/);
  });

  it("rejects an invalid identity AT DISCOVERY, so a bad name cannot ride the synced catalog silently", () => {
    const d = net({ "x.toml": `identity = "worker_fodfix"\nrole = "worker"\n` });
    const { entries, errors } = readCatalog(d);
    expect(entries).toEqual([]);
    expect(errors[0]?.error).toMatch(/worker-fodfix/);
  });

  it("reports a duplicate identity rather than letting two files fight over one agent", () => {
    const d = net({
      "a.toml": `identity = "alpha"\nrole = "worker"\nsupervisor = "cos"\n`,
      "b/alpha/agent.toml": `identity = "alpha"\nrole = "worker"\nsupervisor = "cos"\n`,
    });
    const { entries, errors } = readCatalog(d);
    expect(entries).toHaveLength(1);
    expect(errors[0]?.error).toMatch(/duplicate identity "alpha"/);
  });
});

describe("path segments supply DEFAULTS; content wins", () => {
  it("fills host from the path when the file is silent", () => {
    const d = net({ "silber/alpha/agent.toml": `identity = "alpha"\nrole = "worker"\nsupervisor = "cos"\n` });
    const { entries, warnings } = readCatalog(d);
    expect(entries[0]?.af.host).toBe("silber");
    expect(warnings.filter((w) => w.warning.includes("host"))).toEqual([]);
  });

  it("prefers the file over the path and WARNS on a mismatch, rather than erroring or silently obeying the path", () => {
    const d = net({ "silber/alpha/agent.toml": `identity = "beta"\nrole = "worker"\nsupervisor = "cos"\nhost = "other"\n` });
    const { entries, warnings } = readCatalog(d);
    expect(entries[0]?.af.identity).toBe("beta");
    expect(entries[0]?.af.host).toBe("other");
    expect(warnings.map((w) => w.warning).join("\n")).toMatch(/path says identity "alpha".*declares "beta"/s);
    expect(warnings.map((w) => w.warning).join("\n")).toMatch(/path says host "silber".*declares "other"/s);
  });

  it("treats a role-named directory as grouping, not an identity claim", () => {
    const d = net({ "workers/alpha/agent.toml": `identity = "alpha"\nrole = "worker"\nsupervisor = "cos"\n` });
    expect(readCatalog(d).warnings).toEqual([]);
  });

  it("warns when a non-root agent has no supervisor — it has no escalation path", () => {
    const d = net({ "a.toml": `identity = "alpha"\nrole = "worker"\n` });
    const { entries, warnings } = readCatalog(d);
    expect(entries).toHaveLength(1); // parsed, not rejected — existing catalogs predate the field
    expect(warnings[0]?.warning).toMatch(/no `supervisor`/);
  });
});

describe("pathDefaults", () => {
  it("reads the two segments nearest the file, and nothing from a flat layout", () => {
    expect(pathDefaults("/c", "/c/silber/fabric/agent.toml")).toEqual({ host: "silber", identity: "fabric" });
    expect(pathDefaults("/c", "/c/fabric.toml")).toEqual({});
    expect(pathDefaults("/c", "/c/fabric/agent.toml")).toEqual({ identity: "fabric" });
  });
});

describe("newAgentSpecPath — convoy authors the spec's recommended layout", () => {
  it("writes catalog/<host>/<identity>/agent.toml", () => {
    expect(newAgentSpecPath("/n", "silber", "fabric")).toBe(join("/n", "catalog", "silber", "fabric", "agent.toml"));
  });
});
