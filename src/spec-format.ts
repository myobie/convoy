// FORMAT-AGNOSTIC DECODING for the agent spec (https://github.com/compoundingtech/agent-spec).
//
// The spec says KDL, TOML, and JSON have IDENTICAL SEMANTICS. The only way to guarantee that is to make
// the format a decoding detail: each format decodes to the SAME plain-object shape, and exactly one
// downstream path (parseAgentFile in agent-file.ts) applies field semantics and validation. There is no
// per-format field handling anywhere above this module — a format that reaches `decodeSpecText` and
// produces the canonical object is fully supported by definition.
//
// TOML and JSON map to plain objects natively. KDL does not: it is a node/argument/property language,
// not a key/value one, so the spec's TOML examples imply a KDL mapping that the spec does not yet write
// down. `kdlToPlain` below IS that mapping, chosen so the three formats round-trip to the same object.

import { parse as kdlParse } from "@bgotink/kdl";
import { parse as tomlParse } from "smol-toml";

/** The three interchange formats, keyed by file extension (without the dot). */
export const SPEC_FORMATS = ["kdl", "toml", "json"] as const;
export type SpecFormat = (typeof SPEC_FORMATS)[number];

/** The file extensions discovery slurps — `catalog/**\/*.{kdl,toml,json}`. */
export const SPEC_EXTENSIONS: readonly string[] = SPEC_FORMATS.map((f) => `.${f}`);

/** The format a path declares, or null when the extension isn't a spec format. */
export function formatOfPath(path: string): SpecFormat | null {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = path.slice(dot + 1).toLowerCase();
  return (SPEC_FORMATS as readonly string[]).includes(ext) ? (ext as SpecFormat) : null;
}

/** A decoded spec document — a plain object, before any field semantics are applied. */
export type SpecDoc = Record<string, unknown>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** KDL → the canonical plain object. The mapping, by node shape:
 *
 *  | KDL                                  | canonical                            | TOML equivalent          |
 *  | ------------------------------------ | ------------------------------------ | ------------------------ |
 *  | `identity "fabric"`                  | `{identity: "fabric"}`               | `identity = "fabric"`    |
 *  | `retired #true`                      | `{retired: true}`                    | `retired = true`         |
 *  | `tags role="agent"`                  | `{tags: {role: "agent"}}`            | `tags = {role="agent"}`  |
 *  | `env { A "1"; B "2" }`               | `{env: {A: "1", B: "2"}}`            | `[env]`                  |
 *  | `pty "agent" { command "x" }`        | `{pty: {agent: {command: "x"}}}`     | `[pty.agent]`            |
 *  | `file dest="a"` (repeated)           | `{file: [{dest:"a"}, …]}`            | `[[render.file]]`        |
 *
 *  The load-bearing rule is the fifth row: a node with ONE unnamed argument AND children treats that
 *  argument as a NAME SEGMENT, which is what makes `pty "agent" { … }` mean `[pty.agent]`. Without it,
 *  the spec's own `[pty.<name>]` blocks would have no KDL spelling and the "identical semantics" claim
 *  would be false for the one construct the spec cares most about.
 *
 *  Repeated sibling nodes of the same name collapse to an ARRAY, which is how `[[render.file]]` spells
 *  in KDL. A name that appears once stays scalar; this is the same ambiguity TOML has between `[x]` and
 *  `[[x]]`, and it is resolved the same way — by what the consuming field expects (see `asArray`). */
export function kdlToPlain(text: string): SpecDoc {
  const doc = kdlParse(text);
  return unwrapAgentNode(nodesToPlain(doc.nodes as readonly KdlNode[]));
}

/** The published spec writes KDL as `agent "fabric-claude" { role "worker" … }` — the identity is the
 *  node's positional argument and every other field nests inside — while its JSON and TOML examples are
 *  FLAT (`identity` is an ordinary key at the top level). Those are not the same document shape, so the
 *  "identical meaning" claim does not survive a literal reading of the examples.
 *
 *  Rather than pick a winner, both spellings are accepted: a lone top-level `agent` node is unwrapped into
 *  the flat form, and flat KDL (`identity "fabric-claude"` at the top level) parses directly. Whichever the
 *  spec settles on, catalogs written against either survive. */
function unwrapAgentNode(doc: SpecDoc): SpecDoc {
  const agent = doc["agent"];
  if (Object.keys(doc).length !== 1 || !isPlainObject(agent)) return doc;
  // `agent "x" { … }` maps to `{agent: {x: {…}}}` by the named-segment rule; a bare `agent { … }` has no
  // identity to lift and is passed through as-is.
  const names = Object.keys(agent);
  const only = names[0];
  const body = only === undefined ? undefined : agent[only];
  if (names.length !== 1 || !isPlainObject(body)) return doc;
  return { identity: only, ...body };
}

// Structural subset of @bgotink/kdl's AST that this mapping reads. Declared locally rather than imported
// so a parser upgrade that widens the AST cannot silently change the mapping.
interface KdlEntry {
  name: { name: string } | null;
  value: { value: unknown };
}
interface KdlNode {
  name: { name: string };
  entries: readonly KdlEntry[];
  children: { nodes: readonly KdlNode[] } | null;
}

function nodesToPlain(nodes: readonly KdlNode[]): SpecDoc {
  const out: SpecDoc = {};
  for (const node of nodes) {
    const key = node.name.name;
    const value = nodeValue(node);
    if (!(key in out)) {
      out[key] = value;
      continue;
    }
    // Repeated sibling → array (the `[[render.file]]` shape). Merge object-valued repeats of a NAMED
    // node (`pty "a" {…}` then `pty "b" {…}`) into one table instead, so both spellings of a table of
    // tables work: repeated named nodes, or one node with named children.
    const prev = out[key];
    if (isPlainObject(prev) && isPlainObject(value) && namedSegment(node) !== null) {
      out[key] = { ...prev, ...value };
    } else {
      out[key] = Array.isArray(prev) ? [...prev, value] : [prev, value];
    }
  }
  return out;
}

/** The name segment of a node: its single unnamed string argument when it also has children. */
function namedSegment(node: KdlNode): string | null {
  if (node.children === null) return null;
  const args = node.entries.filter((e) => e.name === null);
  if (args.length !== 1) return null;
  const v = args[0]?.value.value;
  return typeof v === "string" ? v : null;
}

function nodeValue(node: KdlNode): unknown {
  const args = node.entries.filter((e) => e.name === null).map((e) => e.value.value);
  const props: SpecDoc = {};
  for (const e of node.entries) if (e.name !== null) props[e.name.name] = e.value.value;

  if (node.children !== null) {
    const children = nodesToPlain(node.children.nodes);
    const body = { ...props, ...children };
    const segment = namedSegment(node);
    // `pty "agent" { … }` → { agent: {…} }: the argument names a sub-table.
    if (segment !== null) return { [segment]: body };
    return body;
  }
  // No children: props alone are a table (`tags role="agent"`), args alone are a scalar or list.
  if (Object.keys(props).length > 0) return args.length > 0 ? { ...props, _args: args } : props;
  if (args.length === 0) return true; // a bare node is a set flag (`retired` == `retired #true`)
  if (args.length === 1) return args[0];
  return args;
}

/** Decode spec text in `format` to the canonical plain object. Throws with a format-tagged message. */
export function decodeSpecText(text: string, format: SpecFormat): SpecDoc {
  let decoded: unknown;
  try {
    decoded = format === "kdl" ? kdlToPlain(text) : format === "toml" ? tomlParse(text) : JSON.parse(text);
  } catch (e) {
    throw new Error(`invalid ${format}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isPlainObject(decoded)) throw new Error(`invalid ${format}: expected a table at the top level`);
  return decoded;
}

/** Read a value that may be written as a single table or a list of tables (`[x]` vs `[[x]]`, and the KDL
 *  once-vs-repeated ambiguity) as a list. Non-tables are dropped. */
export function asArray(v: unknown): Record<string, unknown>[] {
  if (Array.isArray(v)) return v.filter(isPlainObject);
  return isPlainObject(v) ? [v] : [];
}
