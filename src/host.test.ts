import { describe, it, expect } from "vitest";
import type { SessionInfo } from "@myobie/pty/client";
import { commandFingerprint } from "./flapping-cap.ts";
import { commandHashOf, gone, isPermanent, logicalId, processAlive, toSupervised } from "./host.ts";

function info(over: Partial<SessionInfo> & { tags?: Record<string, string> } = {}): SessionInfo {
  const { tags, ...rest } = over;
  return {
    name: over.name ?? "abc123",
    socketPath: "/tmp/s.sock",
    pid: 42,
    status: over.status ?? "running",
    metadata: {
      command: "sleep",
      args: ["100000"],
      displayCommand: "sleep 100000",
      cwd: "/agents/convoy",
      createdAt: "2026-07-07T00:00:00.000Z",
      tags: tags ?? { role: "worker", strategy: "permanent", ptyfile: "/agents/convoy/pty.toml", "ptyfile.session": "claude" },
      ...(over.status === "exited" ? { exitedAt: "2026-07-07T00:01:00.000Z" } : {}),
    },
    ...rest,
  };
}

describe("host projections (ported from Host.swift / SupervisedSession)", () => {
  it("toSupervised maps the typed metadata (no JSON reparse)", () => {
    const s = toSupervised(info({ name: "x", status: "exited" }));
    expect(s.name).toBe("x");
    expect(s.command).toBe("sleep");
    expect(s.args).toEqual(["100000"]);
    expect(s.status).toBe("exited");
    expect(s.exitedAt).toEqual(new Date("2026-07-07T00:01:00.000Z"));
    expect(s.tags["strategy"]).toBe("permanent");
  });

  it("isPermanent reads the strategy tag", () => {
    expect(isPermanent(toSupervised(info()))).toBe(true);
    expect(isPermanent(toSupervised(info({ tags: { role: "worker" } })))).toBe(false);
  });

  it("gone uses pty's isGone (exited/vanished gone, running alive)", () => {
    expect(gone(toSupervised(info({ status: "running" })))).toBe(false);
    expect(gone(toSupervised(info({ status: "exited" })))).toBe(true);
    expect(gone(toSupervised(info({ status: "vanished" })))).toBe(true);
  });

  it("logicalId is <agent-dir>/<session-key> from the ptyfile tags; falls back to the pty id", () => {
    expect(logicalId(toSupervised(info()))).toBe("convoy/claude");
    expect(logicalId(toSupervised(info({ name: "raw", tags: { role: "worker" } })))).toBe("raw");
  });

  it("commandHashOf matches the shared fingerprint", () => {
    const s = toSupervised(info());
    expect(commandHashOf(s)).toBe(commandFingerprint("sleep", ["100000"]));
    expect(commandHashOf(s)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("processAlive (the adopt-alive liveness probe)", () => {
  it("true for the running process, false for null / invalid / dead pids", () => {
    expect(processAlive(process.pid)).toBe(true); // we are, definitionally, alive
    expect(processAlive(null)).toBe(false);
    expect(processAlive(0)).toBe(false);
    expect(processAlive(-1)).toBe(false);
    expect(processAlive(2147483646)).toBe(false); // a pid that (almost certainly) isn't running
  });

  it("toSupervised carries the pid through from SessionInfo", () => {
    expect(toSupervised(info({ pid: 4242 })).pid).toBe(4242);
    expect(toSupervised(info({ pid: null })).pid).toBeNull();
  });
});
