import { describe, it, expect } from "vitest";
import { checkPtyRoot, pathTooLongMessage, PTY_ROOT_MAX_BYTES } from "./commands.ts";

describe("PTY_ROOT path-length validation (FIX 1)", () => {
  it("accepts a short absolute network path", () => {
    const r = checkPtyRoot("/tmp/net");
    expect(r.ptyRoot).toBe("/tmp/net/pty");
    expect(r.ok).toBe(true);
    expect(r.bytes).toBe("/tmp/net/pty".length);
  });

  it("rejects a path whose <network>/pty exceeds 90 bytes", () => {
    const deep = "/" + "a".repeat(120);
    const r = checkPtyRoot(deep);
    expect(r.ok).toBe(false);
    expect(r.bytes).toBe(deep.length + "/pty".length);
  });

  it("boundary: exactly 90 bytes passes, 91 fails", () => {
    const at90 = "/" + "a".repeat(85); // + "/pty" = 90 chars/bytes
    const over = "/" + "a".repeat(86); // + "/pty" = 91
    expect(checkPtyRoot(at90).bytes).toBe(PTY_ROOT_MAX_BYTES);
    expect(checkPtyRoot(at90).ok).toBe(true);
    expect(checkPtyRoot(over).bytes).toBe(PTY_ROOT_MAX_BYTES + 1);
    expect(checkPtyRoot(over).ok).toBe(false);
  });

  it("measures BYTES not chars (multi-byte utf-8 counts extra)", () => {
    // "é" is 2 bytes in UTF-8; a 46-char path with one é is 47 bytes.
    const p = "/" + "é" + "a".repeat(44); // 46 chars → 47 bytes, + "/pty" = 51 bytes
    const r = checkPtyRoot(p);
    expect(r.bytes).toBe(Buffer.byteLength(p + "/pty", "utf8"));
    expect(r.bytes).toBeGreaterThan((p + "/pty").length);
  });

  it("message matches the requested wording", () => {
    expect(pathTooLongMessage(131)).toBe(
      "PTY_ROOT path is 131 bytes, must be 90 or fewer — pick a shorter network location.",
    );
  });
});
