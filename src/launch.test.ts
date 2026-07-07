import { describe, it, expect } from "vitest";
import { claudeCommand, dingCommand } from "./launch.ts";

describe("native launch command builders", () => {
  it("claudeCommand: unattended auto-poker + `exec claude … --resume <sid>` (the resume fix)", () => {
    const c = claudeCommand("wk1-claude", "auto", "sid-123");
    expect(c).toContain("exec claude --permission-mode auto --resume sid-123");
    expect((c.match(/pty send wk1-claude --seq key:return/g) ?? []).length).toBe(4); // 4 auto-pokes
    expect(c.startsWith("(")).toBe(true); // poker runs in a background subshell before exec
  });

  it("dingCommand: the `st ding` sidecar (st stays a runtime binary, spawned not imported)", () => {
    expect(dingCommand("wk1", "wk1-claude")).toBe("st ding wk1-claude --identity wk1");
  });
});
