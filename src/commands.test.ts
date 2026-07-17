import { afterEach, describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { agentForest, checkPtyRoot, existingPtyTomlIdentity, formatActivityAge, networkEnvExports, optValue, pathTooLongMessage, positionals, PTY_ROOT_MAX_BYTES, readAgentPresence, renderForest, resolveNetworkEnv, resolveNetworkRoot, shellQuote, shortHost, unknownFlag, type LocalInfo } from "./commands.ts";
import { convoyHome, defaultConvoyNetwork, isNetworkName, networkDirForName } from "./paths.ts";
import type { Agent } from "./bus.ts";

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

describe("defaultConvoyNetwork + named networks (convoy/<name>/, default 'default')", () => {
  const savedXdg = process.env["XDG_STATE_HOME"];
  afterEach(() => {
    if (savedXdg === undefined) delete process.env["XDG_STATE_HOME"];
    else process.env["XDG_STATE_HOME"] = savedXdg;
  });

  it("default network = <XDG_STATE_HOME>/convoy/default (named)", () => {
    process.env["XDG_STATE_HOME"] = "/xdg/state";
    expect(defaultConvoyNetwork()).toBe("/xdg/state/convoy/default");
  });
  it("falls back to ~/.local/state/convoy/default when XDG_STATE_HOME is unset", () => {
    delete process.env["XDG_STATE_HOME"];
    expect(defaultConvoyNetwork()).toBe(join(homedir(), ".local", "state", "convoy", "default"));
  });
  it("networkDirForName places a named network under the home: <home>/<name>", () => {
    process.env["XDG_STATE_HOME"] = "/x";
    expect(networkDirForName("myproj")).toBe("/x/convoy/myproj");
    expect(convoyHome()).toBe("/x/convoy");
  });
  it("isNetworkName: bare tokens are names, paths are not", () => {
    expect(isNetworkName("default")).toBe(true);
    expect(isNetworkName("my-net.2")).toBe(true);
    expect(isNetworkName("/tmp/n")).toBe(false);
    expect(isNetworkName("./n")).toBe(false);
    expect(isNetworkName("~/n")).toBe(false);
    expect(isNetworkName("../n")).toBe(false);
  });
  it("resolveNetworkRoot: a NAME resolves under home, a PATH is used as-is", () => {
    process.env["XDG_STATE_HOME"] = "/x";
    expect(resolveNetworkRoot("staging")).toBe("/x/convoy/staging");
    expect(resolveNetworkRoot("/tmp/explicit")).toBe("/tmp/explicit");
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
    const net = join(base, "convoy", "default");
    mkdirSync(net, { recursive: true }); // the default network exists (as it does on a real machine)
    process.env["XDG_STATE_HOME"] = base;
    delete process.env["ST_ROOT"];
    try {
      const r = resolveNetworkEnv([]);
      expect("root" in r).toBe(true);
      if ("root" in r) expect(r.root).toBe(net); // <XDG_STATE_HOME>/convoy/default, NOT ~/.local/state/smalltalk
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

describe("existingPtyTomlIdentity — the convoy-add clobber guard (silent data-loss footgun)", () => {
  it("reads the ST_AGENT (owning identity) from a dir's pty.toml", () => {
    const dir = mkdtempSync(join(tmpdir(), "convoy-owner-"));
    try {
      mkdirSync(join(dir, ".convoy"), { recursive: true });
      writeFileSync(join(dir, ".convoy", "pty.toml"), '[sessions.claude.env]\nST_AGENT = "other-claude"\n');
      expect(existingPtyTomlIdentity(dir)).toBe("other-claude");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is null when the dir has NO pty.toml (nothing to clobber → add proceeds)", () => {
    const dir = mkdtempSync(join(tmpdir(), "convoy-noowner-"));
    try {
      expect(existingPtyTomlIdentity(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is null for a pty.toml with no ST_AGENT (can't attribute → don't block)", () => {
    const dir = mkdtempSync(join(tmpdir(), "convoy-noagent-"));
    try {
      mkdirSync(join(dir, ".convoy"), { recursive: true });
      writeFileSync(join(dir, ".convoy", "pty.toml"), 'prefix = "x"\n');
      expect(existingPtyTomlIdentity(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("convoy ls --tree — spawn-parentage forest + remote section", () => {
  const A = (identity: string, status = "available"): Agent => ({ identity, status: status as never, name: null, lastActivity: null, inbox: null });

  it("agentForest: nests children under their spawner; cos-tier root first; non-local → remote", () => {
    const agents = [A("cos-claude"), A("sup-claude"), A("worker-claude"), A("app-apple-claude"), A("hetz-demo")];
    const local = new Map<string, LocalInfo>([
      ["cos-claude", { spawner: undefined, tier: "cos" }],
      ["sup-claude", { spawner: "cos-claude", tier: undefined }],
      ["worker-claude", { spawner: "sup-claude", tier: undefined }],
      ["app-apple-claude", { spawner: undefined, tier: undefined }], // no spawner → a root (flat, pre-#48)
      // hetz-demo has NO local session → remote
    ]);
    const { roots, remote } = agentForest(agents, local);
    expect(remote.map((a) => a.identity)).toEqual(["hetz-demo"]);
    expect(roots.map((r) => r.agent.identity)).toEqual(["cos-claude", "app-apple-claude"]); // cos-tier sorts first
    const cos = roots.find((r) => r.agent.identity === "cos-claude")!;
    expect(cos.children.map((c) => c.agent.identity)).toEqual(["sup-claude"]);
    expect(cos.children[0]!.children.map((c) => c.agent.identity)).toEqual(["worker-claude"]);
  });

  it("agentForest: a spawner that isn't a local agent → the child is a ROOT (Phase 1 has no cross-machine parent), never dropped", () => {
    const agents = [A("wk-claude")];
    const local = new Map<string, LocalInfo>([["wk-claude", { spawner: "hetz-sup", tier: undefined }]]);
    expect(agentForest(agents, local).roots.map((r) => r.agent.identity)).toEqual(["wk-claude"]);
  });

  it("renderForest: box-drawing tree (├─ / └─)", () => {
    const agents = [A("cos-claude"), A("a-claude"), A("b-claude")];
    const local = new Map<string, LocalInfo>([
      ["cos-claude", { spawner: undefined, tier: "cos" }],
      ["a-claude", { spawner: "cos-claude", tier: undefined }],
      ["b-claude", { spawner: "cos-claude", tier: undefined }],
    ]);
    expect(renderForest(agentForest(agents, local).roots)).toEqual([
      "cos-claude  available",
      "├─ a-claude  available",
      "└─ b-claude  available",
    ]);
  });

  it("formatActivityAge: just now / m / h / d (the remote liveness heuristic)", () => {
    expect(formatActivityAge(30_000)).toBe("just now");
    expect(formatActivityAge(3 * 60_000)).toBe("3m ago");
    expect(formatActivityAge(2 * 3_600_000)).toBe("2h ago");
    expect(formatActivityAge(5 * 24 * 3_600_000)).toBe("5d ago");
    expect(formatActivityAge(-1)).toBe("just now");
  });
});

describe("cross-machine liveness (item 2) — readAgentPresence + shortHost", () => {
  it("readAgentPresence: reads status MTIME + host from <root>/<id>/{status,host}", () => {
    const root = mkdtempSync(join(tmpdir(), "convoy-pres-"));
    try {
      mkdirSync(join(root, "hetz-codex"), { recursive: true });
      writeFileSync(join(root, "hetz-codex", "status"), "available\n");
      writeFileSync(join(root, "hetz-codex", "host"), "hetz.example.com\n");
      const p = readAgentPresence(root, "hetz-codex");
      expect(typeof p.statusMtime).toBe("number");
      expect(p.statusMtime).toBeGreaterThan(0);
      expect(p.host).toBe("hetz.example.com"); // trimmed
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("readAgentPresence: null statusMtime / null host when the files are absent (pre-rollout, graceful)", () => {
    const root = mkdtempSync(join(tmpdir(), "convoy-pres2-"));
    try {
      mkdirSync(join(root, "bare"), { recursive: true }); // dir exists, no status/host files
      expect(readAgentPresence(root, "bare")).toEqual({ statusMtime: null, host: null });
      expect(readAgentPresence(root, "nope")).toEqual({ statusMtime: null, host: null }); // no dir at all
      expect(readAgentPresence(null, "x")).toEqual({ statusMtime: null, host: null }); // no root
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("shortHost: first dot-label, lowercased (for display + same-host comparison)", () => {
    expect(shortHost("hetz.example.com")).toBe("hetz");
    expect(shortHost("silber")).toBe("silber");
    expect(shortHost("HETZ.local")).toBe("hetz");
    expect(shortHost("  hetz  ")).toBe("hetz");
  });
});
