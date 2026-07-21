import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogDir } from "./agent-file.ts";
import { readCatalog } from "./catalog.ts";
import { stRootOf } from "./paths.ts";
import { executeRename, planRename, resolveIdentity, TOMBSTONE_FILE, tombstoneTarget } from "./rename.ts";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const HOST = "testhost";

/** A network with `old` declared and a populated bus folder — context, decisions, mail, archive, status. */
function net(identity = "old", opts?: { bus?: boolean }): string {
  const d = mkdtempSync(join(tmpdir(), "convoy-rename-"));
  roots.push(d);
  mkdirSync(catalogDir(d), { recursive: true });
  writeFileSync(join(catalogDir(d), `${identity}.toml`), `identity = "${identity}"\nrole = "worker"\nsupervisor = "cos"\nhost = "${HOST}"\n`);
  if (opts?.bus !== false) {
    const member = join(stRootOf(d), `${HOST}.${identity}`);
    mkdirSync(join(member, "context", "decisions"), { recursive: true });
    mkdirSync(join(member, "archive"), { recursive: true });
    mkdirSync(join(member, "inbox"), { recursive: true });
    writeFileSync(join(member, "context", "now.md"), "the durable work-state");
    writeFileSync(join(member, "context", "decisions", "0001-x.md"), "a decision");
    writeFileSync(join(member, "archive", "old-mail.md"), "archived");
    writeFileSync(join(member, "inbox", "1234-abcdef.md"), "IN FLIGHT");
    writeFileSync(join(member, "status"), "available");
  }
  return d;
}

const busDir = (d: string, id: string): string => join(stRootOf(d), `${HOST}.${id}`);

describe("convoy rename — the durable half moves, not just the name", () => {
  it("moves context/, context/decisions/, archive/, inbox/ and status to the new identity", () => {
    const d = net();
    expect(executeRename(d, "old", "new", { host: HOST }).errors).toEqual([]);
    const to = busDir(d, "new");
    expect(readFileSync(join(to, "context", "now.md"), "utf8")).toBe("the durable work-state");
    expect(existsSync(join(to, "context", "decisions", "0001-x.md"))).toBe(true);
    expect(existsSync(join(to, "archive", "old-mail.md"))).toBe(true);
    expect(readFileSync(join(to, "status"), "utf8")).toBe("available");
  });

  it("carries IN-FLIGHT mail — a message in the inbox at rename time is delivered under the new name", () => {
    // This is why rename is a MOVE and not a re-create: the mail needs no special handling.
    const d = net();
    executeRename(d, "old", "new", { host: HOST });
    expect(readFileSync(join(busDir(d, "new"), "inbox", "1234-abcdef.md"), "utf8")).toBe("IN FLIGHT");
    expect(existsSync(join(busDir(d, "old"), "inbox"))).toBe(false);
  });

  it("moves the CATALOG entry too, so desired state and durable state agree", () => {
    const d = net();
    executeRename(d, "old", "new", { host: HOST });
    const ids = readCatalog(d).entries.map((e) => e.af.identity);
    expect(ids).toEqual(["new"]);
    expect(existsSync(join(catalogDir(d), "old.toml"))).toBe(false);
  });

  it("uses the HOST-PREFIXED bus folder — renaming the bare name would move nothing and claim success", () => {
    const d = net();
    executeRename(d, "old", "new", { host: HOST });
    // The folder that existed was `<host>.old`; if rename looked for a bare `old` it would find nothing.
    expect(existsSync(busDir(d, "new"))).toBe(true);
    expect(existsSync(join(stRootOf(d), "new"))).toBe(false);
  });
});

describe("the tombstone — what it actually guarantees", () => {
  it("leaves a redirect at the old identity that convoy can follow", () => {
    const d = net();
    executeRename(d, "old", "new", { host: HOST });
    expect(tombstoneTarget(busDir(d, "old"))).toBe("new");
    expect(resolveIdentity(d, "old", HOST)).toBe("new");
  });

  it("follows a CHAIN of renames, and terminates on a cycle rather than hanging a reconcile", () => {
    const d = net();
    executeRename(d, "old", "mid", { host: HOST });
    executeRename(d, "mid", "new", { host: HOST });
    expect(resolveIdentity(d, "old", HOST)).toBe("new");
    // A hand-made cycle must not spin forever.
    writeFileSync(join(busDir(d, "new"), TOMBSTONE_FILE), "old\n");
    expect(typeof resolveIdentity(d, "old", HOST)).toBe("string");
  });

  it("stays INVISIBLE to the bus: no inbox/archive/status beside it, so `st agents` cannot list the old name", () => {
    // smalltalk lists a folder only when it has inbox/, archive/, or status. A tombstone that carried any
    // of them would resurrect the renamed-away agent in every listing on the network.
    const d = net();
    executeRename(d, "old", "new", { host: HOST });
    const left = readdirSync(busDir(d, "old"));
    expect(left).toEqual([TOMBSTONE_FILE]);
    for (const n of ["inbox", "archive", "status"]) expect(left).not.toContain(n);
  });

  it("does not free the old name — declaring it again would collide with the tombstone", () => {
    const d = net();
    executeRename(d, "old", "new", { host: HOST });
    // The old bus folder still exists (as a tombstone), so re-declaring `old` is not a clean slate.
    expect(existsSync(busDir(d, "old"))).toBe(true);
  });
});

describe("rename refuses rather than corrupting", () => {
  it("validates the NEW name against the same grammar as a fresh declaration", () => {
    const d = net();
    expect(planRename(d, "old", "new_name", { host: HOST }).errors.join()).toMatch(/new-name/);
  });

  it("refuses to rename onto an identity that is already declared", () => {
    const d = net();
    writeFileSync(join(catalogDir(d), "taken.toml"), `identity = "taken"\nrole = "worker"\nsupervisor = "cos"\nhost = "${HOST}"\n`);
    expect(planRename(d, "old", "taken", { host: HOST }).errors.join()).toMatch(/already declared/);
  });

  it("refuses to MERGE two agents' durable state when both bus folders exist", () => {
    const d = net();
    mkdirSync(join(busDir(d, "new"), "context"), { recursive: true });
    expect(planRename(d, "old", "new", { host: HOST }).errors.join()).toMatch(/refusing to merge/);
  });

  it("refuses a rename of an agent that is not declared", () => {
    const d = net();
    expect(planRename(d, "ghost", "new", { host: HOST }).errors.join()).toMatch(/no agent "ghost"/);
  });

  it("refuses to rewrite a spec in a format convoy reads but cannot write", () => {
    const d = net("old", { bus: false });
    rmSync(join(catalogDir(d), "old.toml"));
    writeFileSync(join(catalogDir(d), "old.kdl"), `identity "old"\nrole "worker"\nsupervisor "cos"\nhost "${HOST}"\n`);
    expect(planRename(d, "old", "new", { host: HOST }).errors.join()).toMatch(/reads but does not write/);
  });

  it("rejects renaming an identity to itself", () => {
    const d = net();
    expect(planRename(d, "old", "old", { host: HOST }).errors.join()).toMatch(/same identity/);
  });
});

describe("rename is re-runnable after a partial failure", () => {
  it("completes a rename whose bus half already happened", () => {
    const d = net();
    executeRename(d, "old", "new", { host: HOST });
    // Simulate the catalog half having been lost: put the old entry back.
    writeFileSync(join(catalogDir(d), "old.toml"), `identity = "old"\nrole = "worker"\nsupervisor = "cos"\nhost = "${HOST}"\n`);
    rmSync(join(catalogDir(d), "new.toml"), { force: true });
    const r = executeRename(d, "old", "new", { host: HOST });
    expect(r.errors).toEqual([]);
    expect(r.alreadyDone).toBe(true);
    expect(readCatalog(d).entries.map((e) => e.af.identity)).toEqual(["new"]);
  });

  it("renames an agent that has no bus folder yet — declared but never launched", () => {
    const d = net("old", { bus: false });
    const r = executeRename(d, "old", "new", { host: HOST });
    expect(r.errors).toEqual([]);
    expect(readCatalog(d).entries.map((e) => e.af.identity)).toEqual(["new"]);
  });
});
