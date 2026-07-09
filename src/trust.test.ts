import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeConfigPath, pretrustDir } from "./trust.ts";

describe("pretrustDir (Claude Code workspace-trust pre-accept)", () => {
  const savedHome = process.env["HOME"];
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "convoy-trust-"));
    process.env["HOME"] = home;
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  const readConfig = () => JSON.parse(readFileSync(claudeConfigPath(), "utf8"));

  it("creates ~/.claude.json and marks the folder trusted when none exists", () => {
    expect(pretrustDir("/repos/cos")).toBe(true);
    const cfg = readConfig();
    expect(cfg.projects["/repos/cos"].hasTrustDialogAccepted).toBe(true);
    expect(cfg.projects["/repos/cos"].hasCompletedProjectOnboarding).toBe(true);
  });

  it("merges into an existing config without clobbering other projects or fields", () => {
    writeFileSync(
      claudeConfigPath(),
      JSON.stringify({
        someTopLevel: 42,
        projects: {
          "/other": { hasTrustDialogAccepted: true, lastCost: 1.23 },
          "/repos/cos": { allowedTools: ["Bash"], lastSessionId: "abc" },
        },
      }),
    );
    expect(pretrustDir("/repos/cos")).toBe(true);
    const cfg = readConfig();
    expect(cfg.someTopLevel).toBe(42); // top-level preserved
    expect(cfg.projects["/other"]).toEqual({ hasTrustDialogAccepted: true, lastCost: 1.23 }); // untouched
    expect(cfg.projects["/repos/cos"].allowedTools).toEqual(["Bash"]); // existing fields preserved
    expect(cfg.projects["/repos/cos"].lastSessionId).toBe("abc");
    expect(cfg.projects["/repos/cos"].hasTrustDialogAccepted).toBe(true); // trust added
  });

  it("is idempotent when already trusted", () => {
    expect(pretrustDir("/repos/cos")).toBe(true);
    const first = readFileSync(claudeConfigPath(), "utf8");
    expect(pretrustDir("/repos/cos")).toBe(true);
    expect(readFileSync(claudeConfigPath(), "utf8")).toBe(first); // no rewrite when nothing changes
  });

  it("keys a non-existent path on its plain absolute form (realpath fallback)", () => {
    pretrustDir("/repos/../repos/cos/."); // not on disk → falls back to resolve() → /repos/cos
    expect(Object.keys(readConfig().projects)).toContain("/repos/cos");
  });

  it("keys on the REAL path — resolves symlinks (the path Claude Code looks up)", () => {
    const real = join(home, "realrepo");
    const link = join(home, "linkrepo");
    mkdirSync(real);
    symlinkSync(real, link);
    expect(pretrustDir(link)).toBe(true);
    const keys = Object.keys(readConfig().projects);
    expect(keys).toContain(realpathSync(real)); // trusted under the resolved real path
    expect(keys).not.toContain(link); // NOT the symlinked literal path
  });
});
