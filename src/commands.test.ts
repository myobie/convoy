import { afterEach, describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { checkPtyRoot, networkEnvExports, optValue, pathTooLongMessage, positionals, PTY_ROOT_MAX_BYTES, resolveNetworkEnv, resolveNetworkRoot, shellQuote, unknownFlag } from "./commands.ts";
import { defaultConvoyNetwork } from "./paths.ts";

describe("arg parsing: --flag=value form (silent-default trap)", () => {
  it("optValue reads both `--name value` and `--name=value`", () => {
    expect(optValue(["--harness", "codex"], "--harness")).toBe("codex");
    expect(optValue(["--harness=codex"], "--harness")).toBe("codex"); // was null → silently defaulted
    expect(optValue(["--identity=abc-1"], "--identity")).toBe("abc-1");
    expect(optValue(["--identity"], "--identity")).toBeNull(); // flag with no value
    expect(optValue(["role"], "--identity")).toBeNull();
  });
  it("positionals skips inline `--flag=value` without eating the next token", () => {
    expect(positionals(["worker", "--harness=codex", "--identity", "x"])).toEqual(["worker"]);
    expect(positionals(["worker", "--mcp", "extra"])).toEqual(["worker", "extra"]); // bool eats nothing
    expect(positionals(["worker", "--network", "/n"])).toEqual(["worker"]); // value flag eats /n
  });
});

describe("unknownFlag (reject silently-ignored flags — footgun #3)", () => {
  const bool = ["--mcp", "--permanent", "--dry-run"];
  const value = ["--identity", "--harness", "--transport", "--network", "--persona", "--dir", "--prefix"];
  it("flags an unrecognized flag (e.g. --no-hooks accepted rc=0 but ignored)", () => {
    expect(unknownFlag(["worker", "--identity", "x", "--no-hooks"], bool, value)).toBe("--no-hooks");
    expect(unknownFlag(["--bogus", "y", "--identity", "z"], bool, value)).toBe("--bogus");
  });
  it("accepts every recognized flag (bool + value, space + = forms) → null", () => {
    expect(unknownFlag(["worker", "--identity", "x", "--mcp", "--dry-run", "--harness", "codex"], bool, value)).toBeNull();
    expect(unknownFlag(["--harness=codex", "--identity=x", "--permanent"], bool, value)).toBeNull();
  });
  it("does not mistake a value token for an unknown flag", () => {
    // --network's value could itself start with '-' only if quoted; normal values are skipped
    expect(unknownFlag(["worker", "--network", "/tmp/n", "--identity", "wk"], bool, value)).toBeNull();
  });
});

describe("resolveNetworkRoot (no-leak: pty scope follows the bus scope)", () => {
  const saved = process.env["ST_ROOT"];
  afterEach(() => {
    if (saved === undefined) delete process.env["ST_ROOT"];
    else process.env["ST_ROOT"] = saved;
  });

  it("--network wins over ST_ROOT", () => {
    process.env["ST_ROOT"] = "/isolated";
    expect(resolveNetworkRoot("/explicit")).toBe("/explicit");
  });
  it("falls back to ST_ROOT when no --network (so the sidecar isn't left in the global pty root)", () => {
    process.env["ST_ROOT"] = "/isolated";
    expect(resolveNetworkRoot(null)).toBe("/isolated");
  });
  it("falls back to the convoy DEFAULT when neither --network nor ST_ROOT is set (its own default, not st's global root)", () => {
    delete process.env["ST_ROOT"];
    expect(resolveNetworkRoot(null)).toBe(defaultConvoyNetwork());
  });
});

describe("defaultConvoyNetwork (convoy's own default network location)", () => {
  const savedXdg = process.env["XDG_STATE_HOME"];
  afterEach(() => {
    if (savedXdg === undefined) delete process.env["XDG_STATE_HOME"];
    else process.env["XDG_STATE_HOME"] = savedXdg;
  });

  it("respects XDG_STATE_HOME → <XDG_STATE_HOME>/convoy", () => {
    process.env["XDG_STATE_HOME"] = "/xdg/state";
    expect(defaultConvoyNetwork()).toBe("/xdg/state/convoy");
  });
  it("falls back to ~/.local/state/convoy when XDG_STATE_HOME is unset", () => {
    delete process.env["XDG_STATE_HOME"];
    expect(defaultConvoyNetwork()).toBe(join(homedir(), ".local", "state", "convoy"));
  });
  it("is FLAT — the default IS <state>/convoy, never a /convoy/default subdir (named nets = separate thread)", () => {
    process.env["XDG_STATE_HOME"] = "/x";
    expect(defaultConvoyNetwork()).toBe("/x/convoy");
    expect(defaultConvoyNetwork().endsWith("/convoy/default")).toBe(false);
  });
});

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

describe("convoy env / shell — network env exports (footgun-proof targeting)", () => {
  it("shellQuote is POSIX-eval-safe, incl. spaces + embedded single quotes", () => {
    expect(shellQuote("/a/b")).toBe("'/a/b'");
    expect(shellQuote("/a b/c")).toBe("'/a b/c'"); // spaces safe inside the quotes
    expect(shellQuote("it's")).toBe("'it'\\''s'"); // embedded single quote escaped
  });

  it("networkEnvExports emits ST_ROOT + PTY_ROOT and UNSETS ST_AGENT for a human shell", () => {
    expect(networkEnvExports("/net/convoy", "/net/convoy/pty", null)).toEqual([
      "export ST_ROOT='/net/convoy'",
      "export PTY_ROOT='/net/convoy/pty'",
      "unset ST_AGENT",
    ]);
  });

  it("networkEnvExports SETS ST_AGENT when acting-as an identity", () => {
    expect(networkEnvExports("/net/convoy", "/net/convoy/pty", "convoy-claude")[2]).toBe("export ST_AGENT='convoy-claude'");
  });

  it("resolveNetworkEnv derives {root, ptyRoot=<root>/pty} from a REAL network dir (never hardcoded)", () => {
    const dir = mkdtempSync(join(tmpdir(), "convoy-env-"));
    try {
      const r = resolveNetworkEnv([dir]);
      expect("root" in r).toBe(true);
      if ("root" in r) {
        expect(r.root).toBe(dir);
        expect(r.ptyRoot).toBe(join(dir, "pty")); // <ST_ROOT>/pty per the isolation model
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolveNetworkEnv fails LOUD (not silently-wrong) on a nonexistent dir", () => {
    expect("error" in resolveNetworkEnv(["/no/such/network/xyz"])).toBe(true);
  });

  it("resolveNetworkEnv resolves the convoy DEFAULT when no arg + no ST_ROOT (footgun closed — not the global root, no longer a hard error)", () => {
    const savedXdg = process.env["XDG_STATE_HOME"];
    const savedRoot = process.env["ST_ROOT"];
    const base = mkdtempSync(join(tmpdir(), "convoy-xdg-"));
    const net = join(base, "convoy");
    mkdirSync(net, { recursive: true }); // the default network exists (as it does on a real machine)
    process.env["XDG_STATE_HOME"] = base;
    delete process.env["ST_ROOT"];
    try {
      const r = resolveNetworkEnv([]);
      expect("root" in r).toBe(true);
      if ("root" in r) expect(r.root).toBe(net); // <XDG_STATE_HOME>/convoy, NOT ~/.local/state/smalltalk
    } finally {
      if (savedXdg === undefined) delete process.env["XDG_STATE_HOME"];
      else process.env["XDG_STATE_HOME"] = savedXdg;
      if (savedRoot !== undefined) process.env["ST_ROOT"] = savedRoot;
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("resolveNetworkEnv errors when the resolved default doesn't exist yet (fresh machine, pre-init)", () => {
    const savedXdg = process.env["XDG_STATE_HOME"];
    const savedRoot = process.env["ST_ROOT"];
    process.env["XDG_STATE_HOME"] = "/no/such/xdg/state/xyz"; // <that>/convoy will not exist
    delete process.env["ST_ROOT"];
    try {
      expect("error" in resolveNetworkEnv([])).toBe(true);
    } finally {
      if (savedXdg === undefined) delete process.env["XDG_STATE_HOME"];
      else process.env["XDG_STATE_HOME"] = savedXdg;
      if (savedRoot !== undefined) process.env["ST_ROOT"] = savedRoot;
    }
  });
});
