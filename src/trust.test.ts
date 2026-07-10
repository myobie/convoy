import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeConfigPath, codexConfigPath, pretrustDir, pretrustDirs, pretrustDirsCodex } from "./trust.ts";

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

  // ---- pretrustDirs: the batch primitive behind `convoy pretrust` / convoy-up up-scope pre-trust ----

  it("batch: marks EVERY dir trusted + onboarded in one write (the multi-spawn race fix)", () => {
    const dirs = ["a", "b", "c"].map((n) => {
      const d = join(home, n);
      mkdirSync(d);
      return d;
    });
    const { trusted, failed } = pretrustDirs(dirs);
    expect(failed).toEqual([]);
    expect(trusted.length).toBe(3);
    const projects = readConfig().projects;
    for (const d of dirs) {
      const e = projects[realpathSync(d)];
      expect(e.hasTrustDialogAccepted).toBe(true);
      expect(e.hasCompletedProjectOnboarding).toBe(true);
    }
  });

  it("batch: merges — an earlier project's trust survives a later batch (no lost-update)", () => {
    const a = join(home, "a");
    mkdirSync(a);
    pretrustDirs([a]);
    const b = join(home, "b");
    mkdirSync(b);
    pretrustDirs([b]);
    const projects = readConfig().projects;
    expect(projects[realpathSync(a)].hasTrustDialogAccepted).toBe(true); // NOT dropped by b's write
    expect(projects[realpathSync(b)].hasTrustDialogAccepted).toBe(true);
  });

  it("batch: --config-dir target writes <configDir>/.claude.json, leaving the ambient config untouched", () => {
    const a = join(home, "a");
    mkdirSync(a);
    const cfgDir = join(home, "cfg");
    mkdirSync(cfgDir);
    pretrustDirs([a], cfgDir);
    const relocated = JSON.parse(readFileSync(join(cfgDir, ".claude.json"), "utf8"));
    expect(relocated.projects[realpathSync(a)].hasTrustDialogAccepted).toBe(true);
    // the ambient ~/.claude.json was never created for this
    expect(() => readConfig()).toThrow();
  });
});

describe("pretrustDirsCodex (codex ~/.codex/config.toml directory-trust pre-accept)", () => {
  const savedHome = process.env["HOME"];
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "convoy-codex-trust-"));
    process.env["HOME"] = home;
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  const readCfg = (): string => readFileSync(codexConfigPath(), "utf8");
  const hasTrustBlock = (dir: string): boolean => readCfg().includes(`[projects."${realpathSync(dir)}"]\ntrust_level = "trusted"`);

  it("creates ~/.codex/config.toml and appends a trusted block per dir, keyed on realpath", () => {
    const a = join(home, "a");
    const b = join(home, "b");
    mkdirSync(a);
    mkdirSync(b);
    const { trusted, failed } = pretrustDirsCodex([a, b]);
    expect(failed).toEqual([]);
    expect(trusted.length).toBe(2);
    expect(hasTrustBlock(a)).toBe(true);
    expect(hasTrustBlock(b)).toBe(true);
  });

  it("APPENDS — preserves existing config content + comments (no full-TOML rewrite)", () => {
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(codexConfigPath(), '# my settings\nmodel = "gpt-5"\n\n[projects."/other"]\ntrust_level = "trusted"\n');
    const a = join(home, "a");
    mkdirSync(a);
    pretrustDirsCodex([a]);
    const txt = readCfg();
    expect(txt).toContain("# my settings"); // comment preserved
    expect(txt).toContain('model = "gpt-5"'); // setting preserved
    expect(txt).toContain('[projects."/other"]'); // prior project preserved
    expect(hasTrustBlock(a)).toBe(true); // new one appended
  });

  it("is idempotent — a second run adds no duplicate block", () => {
    const a = join(home, "a");
    mkdirSync(a);
    pretrustDirsCodex([a]);
    const first = readCfg();
    pretrustDirsCodex([a]);
    expect(readCfg()).toBe(first); // header already present → nothing appended
  });
});
