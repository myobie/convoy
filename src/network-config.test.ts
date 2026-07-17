import { afterEach, describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { networkConfigPath, networkNameFromDir, readNetworkConfig, writeNetworkConfig } from "./network-config.ts";

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
