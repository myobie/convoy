/** Primitives for SOURCE-LEVEL guards — tests that read convoy's own source to hold an invariant that can't
 *  be exercised at runtime (a check that spawns real agents for minutes; a branch behind a TTY prompt).
 *
 *  Why this exists: a source guard is only as strong as its tokenizer. A guard that greps RAW text is
 *  satisfied by a COMMENTED-OUT occurrence — `// TODO: theCall() -- disabled` passes while the behavior is
 *  entirely gone. That is not a guard, it is a spell-checker for comments. Every guard in this repo greps
 *  `stripComments(src)` instead, so only real code can satisfy it.
 *
 *  It is a tokenizer and not a regex because the naive version breaks on our own source: `//` inside a
 *  string literal is not a comment, and a regex literal may contain quote characters — up.ts has
 *  `/ST_AGENT\s*=\s*"([^"]+)"/` — which a quote-counting scanner mis-reads as an unterminated string and
 *  then swallows the rest of the file, silently turning every downstream guard vacuous. */

const CODE = 0;
const COMMENT = 1;
const TEXT = 2; // string / template text / regex body — code-shaped chars in here must not be read as code

/** `/` starts a REGEX (not a division) when the preceding significant token can't end an expression. */
const REGEX_AFTER_CHAR = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "^", "~", "<", ">"]);
const REGEX_AFTER_WORD = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "case", "do", "else", "yield", "await"]);

/** Per-character classification of a TypeScript source: code, comment, or string/regex text. */
export function classify(src: string): Uint8Array {
  const out = new Uint8Array(src.length);
  // A stack so `${ … }` interpolations inside a template literal are classified as the CODE they are (and
  // their braces counted), while the surrounding template TEXT is not.
  const stack: Array<{ mode: "code" | "tmpl"; depth: number }> = [{ mode: "code", depth: 0 }];
  const top = (): { mode: "code" | "tmpl"; depth: number } => stack[stack.length - 1]!;
  let lastSig = ""; // last significant CODE character — drives the regex-vs-division call
  let lastWord = ""; // …and the last identifier, for `return /re/`
  let i = 0;

  const fill = (n: number, kind: number): void => {
    for (let k = 0; k < n && i < src.length; k++) out[i++] = kind;
  };

  while (i < src.length) {
    const c = src[i]!;
    const d = src[i + 1];

    if (top().mode === "tmpl") {
      if (c === "\\") {
        fill(2, TEXT);
        continue;
      }
      if (c === "`") {
        fill(1, TEXT);
        stack.pop();
        lastSig = "`";
        continue;
      }
      if (c === "$" && d === "{") {
        fill(2, TEXT);
        stack.push({ mode: "code", depth: 0 });
        lastSig = "{";
        continue;
      }
      fill(1, TEXT);
      continue;
    }

    // --- code mode ---
    if (c === "/" && d === "/") {
      while (i < src.length && src[i] !== "\n") out[i++] = COMMENT;
      continue;
    }
    if (c === "/" && d === "*") {
      fill(2, COMMENT);
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) out[i++] = COMMENT;
      fill(2, COMMENT);
      continue;
    }
    if (c === '"' || c === "'") {
      fill(1, TEXT);
      while (i < src.length && src[i] !== c) {
        if (src[i] === "\\") out[i++] = TEXT;
        if (i < src.length) out[i++] = TEXT;
      }
      fill(1, TEXT);
      lastSig = c;
      continue;
    }
    if (c === "`") {
      fill(1, TEXT);
      stack.push({ mode: "tmpl", depth: 0 });
      continue;
    }
    if (c === "/" && (REGEX_AFTER_CHAR.has(lastSig) || REGEX_AFTER_WORD.has(lastWord))) {
      fill(1, TEXT);
      let inClass = false;
      while (i < src.length) {
        const r = src[i]!;
        if (r === "\\") {
          fill(2, TEXT);
          continue;
        }
        if (r === "[") inClass = true;
        else if (r === "]") inClass = false;
        else if (r === "/" && !inClass) break;
        else if (r === "\n") break; // not a regex after all — bail rather than eat the file
        out[i++] = TEXT;
      }
      fill(1, TEXT);
      while (i < src.length && /[a-z]/.test(src[i]!)) out[i++] = TEXT; // flags
      lastSig = "/";
      continue;
    }
    if (c === "{") top().depth++;
    else if (c === "}") {
      if (top().depth === 0 && stack.length > 1) {
        fill(1, TEXT); // the `}` closing a `${ … }` interpolation
        stack.pop();
        lastSig = "`";
        continue;
      }
      top().depth--;
    }
    out[i] = CODE;
    if (!/\s/.test(c)) {
      lastSig = c;
      lastWord = /[A-Za-z]/.test(c) ? lastWord + c : "";
    }
    i++;
  }
  return out;
}

/** The source with every COMMENT span blanked (newlines kept, so line numbers still line up).
 *
 *  Grep THIS, never the raw source: it is what makes a guard un-defeatable by a comment. */
export function stripComments(src: string): string {
  const kind = classify(src);
  let out = "";
  for (let i = 0; i < src.length; i++) out += kind[i] === COMMENT ? (src[i] === "\n" ? "\n" : " ") : src[i];
  return out;
}

/** The body of `function <name>(…) { … }` — brace-matched, so it ends at the function's REAL closing brace
 *  rather than at the next `\nexport ` (which a reorder or a nested export silently breaks, quietly handing
 *  the guard the wrong text). Comments are stripped. Null when there is no such function. */
export function functionBody(src: string, name: string): string | null {
  const stripped = stripComments(src);
  const sig = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*[(<]`);
  const m = sig.exec(stripped);
  if (m === null) return null;
  const kind = classify(stripped);
  let open = -1;
  for (let i = m.index; i < stripped.length; i++) {
    if (stripped[i] === "{" && kind[i] === CODE) {
      open = i;
      break;
    }
  }
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < stripped.length; i++) {
    if (kind[i] !== CODE) continue;
    if (stripped[i] === "{") depth++;
    else if (stripped[i] === "}" && --depth === 0) return stripped.slice(open + 1, i);
  }
  return null;
}

/** Every `export async function <name>` in a source, in declaration order. */
export function exportedAsyncFunctions(src: string): string[] {
  const stripped = stripComments(src);
  const names: string[] = [];
  const re = /export\s+async\s+function\s+([A-Za-z0-9_$]+)\s*\(/g;
  for (let m = re.exec(stripped); m !== null; m = re.exec(stripped)) names.push(m[1]!);
  return names;
}
