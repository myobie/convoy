import { afterEach, describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus, isLive } from "./bus.ts";

// Lay agents out on the bus the way @myobie/coord's reader discovers them: a per-agent dir that is
// "agent-shaped" (has an inbox/ or archive/) with an optional `status` file. Inbox counts only count
// valid-grammar message files (<ms-ts>-<rand6>.md), mirroring smalltalk's own bus-reader fixtures.
function putAgent(root: string, id: string, state?: string): void {
  mkdirSync(join(root, id, "inbox"), { recursive: true });
  if (state !== undefined) writeFileSync(join(root, id, "status"), state);
}
function putInbox(root: string, id: string, name: string, body = "x"): void {
  writeFileSync(join(root, id, "inbox", name), body);
}

describe("Bus.agents — backed by @myobie/coord createBusReader (no st shell-out)", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });
  function tmpRoot(): string {
    const r = mkdtempSync(join(tmpdir(), "convoy-bus-"));
    roots.push(r);
    return r;
  }

  it("returns the base shape mapped to convoy Agent (status + name; lastActivity/inbox null)", async () => {
    const root = tmpRoot();
    putAgent(root, "cos", "busy");
    putAgent(root, "wk1", "available");
    const agents = await new Bus(root).agents();
    expect(agents.map((a) => a.identity).sort()).toEqual(["cos", "wk1"]);
    const cos = agents.find((a) => a.identity === "cos")!;
    expect(cos.status).toBe("busy");
    expect(cos.name).toBeNull();
    expect(cos.lastActivity).toBeNull(); // base shape → null convoy-side (only enrich carries it)
    expect(cos.inbox).toBeNull();
  });

  it("enrich fills the inbox count + a numeric lastActivity", async () => {
    const root = tmpRoot();
    putAgent(root, "wk1", "available");
    putInbox(root, "wk1", "1784198000000-aaaaaa.md");
    putInbox(root, "wk1", "1784198000010-bbbbbb.md");
    const [wk] = await new Bus(root).agents(true);
    expect(wk!.inbox).toBe(2);
    expect(typeof wk!.lastActivity).toBe("number");
  });

  it("adopts st's status semantics: a missing status file reads offline, not unknown", async () => {
    const root = tmpRoot();
    putAgent(root, "ghost"); // agent-shaped (has inbox/) but no status file
    const agents = await new Bus(root).agents();
    expect(agents.find((a) => a.identity === "ghost")?.status).toBe("offline");
  });

  it("fail-soft: a nonexistent root reads as no agents (as the old st shell-out returned [])", async () => {
    expect(await new Bus("/no/such/convoy/root/xyz").agents()).toEqual([]);
  });

  it("isLive matches the live rollup (available/busy/away/dnd live; offline/unknown not)", () => {
    for (const s of ["available", "busy", "away", "dnd"] as const) expect(isLive(s)).toBe(true);
    expect(isLive("offline")).toBe(false);
    expect(isLive("unknown")).toBe(false);
  });
});
