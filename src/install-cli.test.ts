import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultBinDir, dirOnPath, installClis, pathHint, toolSources } from "./install-cli.ts";

describe("toolSources", () => {
  it("resolves st + pty from sibling repos, convoy from its own bin", () => {
    const s = toolSources("/x/y/convoy");
    expect(s.convoy).toBe("/x/y/convoy/bin/convoy");
    expect(s.st).toBe("/x/y/smalltalk/bin/st");
    expect(s.pty).toBe("/x/y/pty/bin/pty");
  });
});

describe("defaultBinDir / dirOnPath / pathHint (portable, env-driven)", () => {
  it("defaultBinDir honors CONVOY_BIN_DIR, else ~/.local/bin", () => {
    expect(defaultBinDir({ CONVOY_BIN_DIR: "/opt/bin" })).toBe("/opt/bin");
    expect(defaultBinDir({ HOME: "/home/x" })).toBe("/home/x/.local/bin");
  });
  it("dirOnPath matches an exact PATH segment", () => {
    expect(dirOnPath("/home/x/.local/bin", { PATH: "/usr/bin:/home/x/.local/bin:/bin" })).toBe(true);
    expect(dirOnPath("/home/x/.local/bin", { PATH: "/usr/bin:/bin" })).toBe(false);
    expect(dirOnPath("/home/x/.local", { PATH: "/home/x/.local/bin" })).toBe(false); // not a prefix match
  });
  it("pathHint is shell-specific (never assumes zsh)", () => {
    expect(pathHint("/b", { SHELL: "/usr/bin/fish" })).toMatch(/fish_add_path/);
    expect(pathHint("/b", { SHELL: "/bin/zsh" })).toMatch(/zshrc/);
    expect(pathHint("/b", { SHELL: "/bin/bash" })).toMatch(/bashrc/);
    expect(pathHint("/b", {})).toMatch(/export PATH/); // unknown shell → generic
  });
});

describe("installClis (symlink into a writable bin dir)", () => {
  let root: string; // fake "parent" holding convoy + smalltalk + pty siblings
  let convoyRoot: string;
  let binDir: string;
  const mkBin = (repo: string, tool: string): void => {
    const dir = join(root, repo, "bin");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, tool), "#!/bin/sh\n");
  };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "convoy-install-"));
    convoyRoot = join(root, "convoy");
    binDir = join(root, "bin");
    mkBin("convoy", "convoy");
    mkBin("smalltalk", "st");
    mkBin("pty", "pty");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("symlinks all three tools into binDir and reports ok", () => {
    const r = installClis(convoyRoot, binDir, { PATH: binDir });
    expect(r.ok).toBe(true);
    expect(r.linked.sort()).toEqual(["convoy", "pty", "st"]);
    for (const t of ["convoy", "st", "pty"]) {
      const link = join(binDir, t);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(toolSources(convoyRoot)[t as "convoy"]);
    }
    expect(r.onPath).toBe(true);
  });

  it("is idempotent — a second run rewrites nothing and still reports linked", () => {
    installClis(convoyRoot, binDir);
    const r = installClis(convoyRoot, binDir);
    expect(r.ok).toBe(true);
    expect(r.linked.sort()).toEqual(["convoy", "pty", "st"]);
  });

  it("replaces a STALE symlink (pointing elsewhere) with the correct source", () => {
    mkdirSync(binDir, { recursive: true });
    symlinkSync("/nowhere/convoy", join(binDir, "convoy"));
    const r = installClis(convoyRoot, binDir);
    expect(readlinkSync(join(binDir, "convoy"))).toBe(join(convoyRoot, "bin", "convoy"));
    expect(r.ok).toBe(true);
  });

  it("reports a missing source (sibling not cloned) without failing the others", () => {
    rmSync(join(root, "pty"), { recursive: true, force: true });
    const r = installClis(convoyRoot, binDir);
    expect(r.ok).toBe(false);
    expect(r.missingSources.map((m) => m.tool)).toEqual(["pty"]);
    expect(r.linked.sort()).toEqual(["convoy", "st"]); // the others still linked
  });

  it("REFUSES to clobber a real (non-symlink) file already at the target", () => {
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "st"), "my own st binary\n");
    const r = installClis(convoyRoot, binDir);
    expect(r.ok).toBe(false);
    expect(r.conflicts.map((c) => c.tool)).toEqual(["st"]);
    expect(existsSync(join(binDir, "st"))).toBe(true);
    expect(lstatSync(join(binDir, "st")).isSymbolicLink()).toBe(false); // left as the real file
  });

  it("onPath reflects the passed env's PATH", () => {
    const r = installClis(convoyRoot, binDir, { PATH: "/usr/bin:/bin" });
    expect(r.onPath).toBe(false);
    expect(r.pathHint).toBeTruthy();
  });
});
