import { afterEach, describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { networkConfigPath, networkNameFromDir, readNetworkConfig, writeNetworkConfig } from "./network-config.ts";
import { cutWorktree } from "./commands.ts";

describe("network-config (<net>/convoy.toml)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function tmp(): string {
    const d = mkdtempSync(join(tmpdir(), "convoy-cfg-"));
    dirs.push(d);
    return d;
  }

  it("networkConfigPath + networkNameFromDir", () => {
    expect(networkConfigPath("/x/convoy/default")).toBe("/x/convoy/default/convoy.toml");
    expect(networkNameFromDir("/x/convoy/staging")).toBe("staging");
  });

  it("write + read round-trips the name (+ megarepo when present)", () => {
    const d = tmp();
    writeNetworkConfig(d, { name: "default" });
    expect(existsSync(networkConfigPath(d))).toBe(true);
    expect(readNetworkConfig(d)).toEqual({ name: "default" });

    writeNetworkConfig(d, { name: "big", megarepo: "/repos/mono" });
    expect(readNetworkConfig(d)).toEqual({ name: "big", megarepo: "/repos/mono" });
  });

  it("read is null when the file is missing or nameless", () => {
    const d = tmp();
    expect(readNetworkConfig(d)).toBeNull(); // no file yet
    writeNetworkConfig(d, { name: "" }); // nameless is invalid
    expect(readNetworkConfig(d)).toBeNull();
  });
});

describe("cutWorktree (megarepo → <net>/worktrees/<id> git worktree)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("cuts a worktree off a megarepo on branch convoy/<id>, and is idempotent", async () => {
    const base = mkdtempSync(join(tmpdir(), "convoy-mega-"));
    dirs.push(base);
    const megarepo = join(base, "mono");
    const git = (...a: string[]): void => void execFileSync("git", a, { cwd: megarepo });
    mkdirSync(megarepo, { recursive: true });
    execFileSync("git", ["init", "-q", megarepo]);
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    execFileSync("git", ["-C", megarepo, "commit", "--allow-empty", "-qm", "init"]);

    const wt = join(base, "net", "worktrees", "wk-claude");
    const r = await cutWorktree(megarepo, wt, "wk-claude");
    expect(r).toEqual({ ok: true, branch: "convoy/wk-claude" });
    expect(existsSync(join(wt, ".git"))).toBe(true); // a real worktree
    // the worktree is checked out on the convoy/<id> branch
    const branch = execFileSync("git", ["-C", wt, "rev-parse", "--abbrev-ref", "HEAD"]).toString().trim();
    expect(branch).toBe("convoy/wk-claude");
    // idempotent — a second cut on the existing dir is a no-op success
    expect(await cutWorktree(megarepo, wt, "wk-claude")).toEqual({ ok: true, branch: "convoy/wk-claude" });
  });

  it("errors (ok:false) when the megarepo is not a git repo", async () => {
    const base = mkdtempSync(join(tmpdir(), "convoy-nomega-"));
    dirs.push(base);
    const r = await cutWorktree(join(base, "not-a-repo"), join(base, "wt"), "x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("git worktree add");
  });
});
