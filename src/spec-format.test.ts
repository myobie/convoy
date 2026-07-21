import { describe, expect, it } from "vitest";
import { asArray, decodeSpecText, formatOfPath, kdlToPlain } from "./spec-format.ts";

// The spec's claim is "KDL, JSON, and TOML with identical semantics". That is only true if the three
// decode to the SAME object, so the equivalence itself is the test — not three separate parser tests.

describe("decodeSpecText — three formats, one canonical object", () => {
  const TOML = `
identity   = "fabric-claude"
role       = "worker"
supervisor = "cos"
host       = "silber"
workspace  = "/repos/fabric"
retired    = false

[env]
CLAUDE_CONFIG_DIR = "$HOME/.claude-fabric"

[pty.agent]
command = "exec claude"
tags    = { role = "agent" }

[pty.agent.env]
ST_AGENT = "silber.fabric-claude"

[pty.ding]
command = "st ding silber.fabric"
`;

  const JSON_TEXT = JSON.stringify({
    identity: "fabric-claude",
    role: "worker",
    supervisor: "cos",
    host: "silber",
    workspace: "/repos/fabric",
    retired: false,
    env: { CLAUDE_CONFIG_DIR: "$HOME/.claude-fabric" },
    pty: {
      agent: { command: "exec claude", tags: { role: "agent" }, env: { ST_AGENT: "silber.fabric-claude" } },
      ding: { command: "st ding silber.fabric" },
    },
  });

  const KDL = `
identity "fabric-claude"
role "worker"
supervisor "cos"
host "silber"
workspace "/repos/fabric"
retired #false

env {
  CLAUDE_CONFIG_DIR "$HOME/.claude-fabric"
}

pty "agent" {
  command "exec claude"
  tags role="agent"
  env {
    ST_AGENT "silber.fabric-claude"
  }
}

pty "ding" {
  command "st ding silber.fabric"
}
`;

  it("decodes TOML, JSON, and KDL to structurally identical documents", () => {
    const toml = decodeSpecText(TOML, "toml");
    const json = decodeSpecText(JSON_TEXT, "json");
    const kdl = decodeSpecText(KDL, "kdl");
    expect(json).toEqual(toml);
    expect(kdl).toEqual(toml);
  });

  it("preserves booleans as booleans in every format (retired=false must not become truthy)", () => {
    for (const [text, fmt] of [[TOML, "toml"], [JSON_TEXT, "json"], [KDL, "kdl"]] as const) {
      expect(decodeSpecText(text, fmt)["retired"]).toBe(false);
    }
  });

  it("rejects a non-table top level rather than silently yielding an empty spec", () => {
    expect(() => decodeSpecText("[1,2]", "json")).toThrow(/expected a table/);
  });

  it("tags the format in parse errors so a bad file names its own language", () => {
    expect(() => decodeSpecText("{{{", "json")).toThrow(/invalid json/);
    expect(() => decodeSpecText("identity = ", "toml")).toThrow(/invalid toml/);
  });
});

describe("kdlToPlain — the node→table mapping the spec leaves implicit", () => {
  it("maps a node with one argument and children to a NAMED SUB-TABLE (the [pty.<name>] shape)", () => {
    expect(kdlToPlain(`pty "agent" { command "x" }`)).toEqual({ pty: { agent: { command: "x" } } });
  });

  it("merges repeated named nodes into one table, so two pty blocks are two tasks not two documents", () => {
    expect(kdlToPlain(`pty "a" { command "1" }\npty "b" { command "2" }`)).toEqual({
      pty: { a: { command: "1" }, b: { command: "2" } },
    });
  });

  it("collapses repeated anonymous nodes to an array (the [[render.file]] shape)", () => {
    expect(kdlToPlain(`render { file dest="a" from="x"\n file dest="b" from="y" }`)).toEqual({
      render: { file: [{ dest: "a", from: "x" }, { dest: "b", from: "y" }] },
    });
  });

  it("reads properties as a table (tags role=\"agent\")", () => {
    expect(kdlToPlain(`tags role="agent" "st.network"="$CONVOY_NET"`)).toEqual({
      tags: { role: "agent", "st.network": "$CONVOY_NET" },
    });
  });

  it("treats a bare node as a set flag, so `retired` means retired", () => {
    expect(kdlToPlain(`retired`)).toEqual({ retired: true });
  });
});

describe("formatOfPath", () => {
  it("recognises the three spec extensions and nothing else", () => {
    expect(formatOfPath("/c/a.toml")).toBe("toml");
    expect(formatOfPath("/c/a.kdl")).toBe("kdl");
    expect(formatOfPath("/c/a.json")).toBe("json");
    expect(formatOfPath("/c/a.yaml")).toBeNull();
    expect(formatOfPath("/c/README")).toBeNull();
  });
});

describe("asArray — one-or-many without a per-format branch", () => {
  it("reads a single table and a list of tables the same way", () => {
    expect(asArray({ dest: "a" })).toEqual([{ dest: "a" }]);
    expect(asArray([{ dest: "a" }, { dest: "b" }])).toEqual([{ dest: "a" }, { dest: "b" }]);
    expect(asArray(undefined)).toEqual([]);
    expect(asArray("nope")).toEqual([]);
  });
});

describe("the PUBLISHED spec's own examples parse", () => {
  // The spec's examples are not structurally identical to each other: its KDL nests everything under an
  // `agent "<identity>"` node while its JSON and TOML are flat, and its JSON says `ptys` where the others
  // say `pty`. Convoy accepts both spellings rather than picking a winner, so a catalog written against
  // any published example works. These tests pin that, and would fail loudly if the spec converged.
  const SPEC_KDL = `
agent "fabric-claude" {
  role       "worker"
  supervisor "cos"
  host       "silber"
  workspace  "/repos/fabric"
  transport  "ding"
  retired   #false
  prefix    "silber.fabric"

  pty "agent" {
    id      "silber.fabric-claude"
    command #"exec claude --permission-mode bypassPermissions 'cold-start: run boot ritual, then stand by'"#
    cwd     "."
    tags role="agent" "st.network"="$CONVOY_NET"
    env {
      ST_AGENT "silber.fabric-claude"
      ST_ROOT  "$CONVOY_NET/smalltalk"
    }
  }
}
`;

  it("unwraps the spec's `agent \"<identity>\"` KDL node into the flat shape its TOML uses", () => {
    const d = decodeSpecText(SPEC_KDL, "kdl");
    expect(d["identity"]).toBe("fabric-claude");
    expect(d["role"]).toBe("worker");
    expect(d["supervisor"]).toBe("cos");
    expect(d["retired"]).toBe(false);
    expect((d["pty"] as Record<string, Record<string, unknown>>)["agent"]?.["cwd"]).toBe(".");
  });

  it("reads a KDL raw string command without mangling its embedded quotes", () => {
    const pty = decodeSpecText(SPEC_KDL, "kdl")["pty"] as Record<string, Record<string, unknown>>;
    expect(pty["agent"]?.["command"]).toBe("exec claude --permission-mode bypassPermissions 'cold-start: run boot ritual, then stand by'");
  });

  it("still accepts FLAT kdl, so neither spelling is locked out while the spec settles", () => {
    expect(decodeSpecText(`identity "fabric"\nrole "worker"\n`, "kdl")["identity"]).toBe("fabric");
  });

  it("leaves a bare `agent { … }` node alone rather than inventing an identity", () => {
    expect(decodeSpecText(`agent {\n  role "worker"\n}`, "kdl")["identity"]).toBeUndefined();
  });
});
