import { describe, it, expect } from "vitest";
import { formatVersion } from "./cli.ts";

describe("formatVersion (convoy --version → <semver>+<short-sha>)", () => {
  it("appends +<sha> when a git sha is available", () => {
    expect(formatVersion("0.2.0-ts.0", "abc1234")).toBe("0.2.0-ts.0+abc1234");
  });
  it("omits the sha when null (installed package / not a git checkout)", () => {
    expect(formatVersion("0.2.0-ts.0", null)).toBe("0.2.0-ts.0");
  });
});
