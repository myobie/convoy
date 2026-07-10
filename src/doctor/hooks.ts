// Compact-readiness of the PreCompact hook convoy wires. Non-spawning + prod-untouched, so it lives in the
// doctor PREFLIGHT gate (not the spawning suite).
//
// Why this exists: Claude Code runs the PreCompact hook under the REAL macOS /bin/bash (3.2.57). A hook that
// fails to PARSE there fail-CLOSES — compaction is blocked, which wedges the whole session AND, because the
// hook is shared, every agent on the network at once. That exact failure (a heredoc nested in $(), which
// bash 3.2 can't parse) took the network's /compact down. smalltalk's #80 fixed it by splitting the hook
// into a trivially-parse-safe fail-open shim (pre-compact.sh) + a sibling pre-compact.impl.sh that does the
// real work under `|| true`. convoy POINTS each agent at the shared hooks dir (it never copies), so once
// #80 landed there every convoy-spawned agent inherited the fix — and this check proves it stuck.
//
// The three assertions mirror exactly what smalltalk ran to verify #80:
//   1. STRUCTURAL — both files present (catches a half-wired / old single-file install);
//   2. PARSE-SAFE — both parse under `/bin/bash -n` (the impl check is the one that catches the heredoc);
//   3. FAIL-OPEN — the shim, run beside a DELIBERATELY BROKEN impl in a throwaway dir, still exits 0 — proof
//      a FUTURE parse/logic break in the impl can never re-block /compact. Never touches the real files.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { run } from "../exec.ts";

export interface HookHealth {
  ok: boolean;
  detail: string;
  fix?: string;
}

/** Resolve + health-check the PreCompact hook in the shared smalltalk hooks dir (the one convoy wires). */
export async function compactHookHealth(smalltalkDir: string): Promise<HookHealth> {
  const hooks = join(smalltalkDir, "examples", "claude-code", "hooks");
  const shim = join(hooks, "pre-compact.sh");
  const impl = join(hooks, "pre-compact.impl.sh");

  // 1) STRUCTURAL — #80 made this a two-file hook. A shim with no sibling impl silently skips the flush.
  if (!existsSync(shim)) return { ok: false, detail: `PreCompact hook missing (${shim})`, fix: "reinstall smalltalk's Claude Code hooks — without pre-compact.sh /compact has no state flush" };
  if (!existsSync(impl)) return { ok: false, detail: "PreCompact shim present but its sibling pre-compact.impl.sh is MISSING (a half-installed #80 hook)", fix: `install pre-compact.impl.sh next to pre-compact.sh in ${hooks} — the shim finds no impl and silently skips the flush` };

  // 2) PARSE-SAFE under the REAL macOS /bin/bash 3.2 (never a modern `bash`), which Claude Code uses for hooks.
  for (const p of [shim, impl]) {
    const parse = await run("/bin/bash", ["-n", p]);
    if (!parse.ok) {
      const first = parse.stderr.trim().split("\n")[0] || "parse error";
      return { ok: false, detail: `${basename(p)} does NOT parse under /bin/bash 3.2 (${first})`, fix: "the bash-3.2 parse-close class that blocks /compact network-wide — update smalltalk's hooks to the fail-open shim (#80)" };
    }
  }

  // 3) FAIL-OPEN — copy the shim beside a DELIBERATELY BROKEN impl and require exit 0. This is the definitive,
  // non-invasive proof (exactly how smalltalk verified #80): even if the impl parse-closes, the shim runs it
  // under `|| true` and exits 0 unconditionally, so /compact can never be blocked. Runs in a throwaway dir
  // with no identity → zero writes, prod untouched.
  const t = mkdtempSync(join(tmpdir(), "cvd-pc-"));
  try {
    const probeShim = join(t, "pre-compact.sh");
    writeFileSync(probeShim, readFileSync(shim, "utf8"));
    // An unterminated heredoc-in-$() — the worst case the shim must survive (this is the class that wedged us).
    writeFileSync(join(t, "pre-compact.impl.sh"), "stub=$(cat <<E\ndeliberately broken heredoc in $()\n");
    const failOpen = await run("/bin/bash", [probeShim], { env: { ...process.env, ST_AGENT: "", ST_IDENTITY: "", ST_BIN: "" }, input: "" });
    if (!failOpen.ok) return { ok: false, detail: `PreCompact hook is NOT fail-open — it exited ${failOpen.status} beside a broken impl, so a logic break can BLOCK /compact`, fix: "the shim must run its impl under `|| true` and exit 0 unconditionally — update to the #80 fail-open shim" };
  } finally {
    rmSync(t, { recursive: true, force: true });
  }

  return { ok: true, detail: "PreCompact hook parse-safe (/bin/bash 3.2) + fail-open (survives a broken impl), shim + impl both present" };
}
