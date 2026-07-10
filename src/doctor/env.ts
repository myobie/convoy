// Cross-machine environment checks for the `convoy doctor --quick` preflight. Resilient onboarding = VERIFY
// every assumption about the machine (don't assume it matches ours) and fail loud + actionable, so a stranger
// on a different OS/setup either passes or gets a precise fix — never a cryptic failure at spawn time. Each
// function is pure / injectable so it's unit-testable without the real machine state.

import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult } from "../exec.ts";

export interface EnvCheck {
  ok: boolean | null; // true = ok, false = blocking, null = informational (never fails the gate)
  detail: string;
  fix?: string;
}

/** Node must be ≥ 23.6 — convoy strips TypeScript types at load via that release's native type-stripping (no
 *  build step), so an older Node can't even run the CLI. Parse defensively (odd version strings → don't crash). */
export function nodeVersionCheck(version: string = process.version): EnvCheck {
  const m = version.match(/^v?(\d+)\.(\d+)/);
  if (!m) return { ok: null, detail: `Node version unrecognized (${version}) — need ≥ 23.6` };
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const ok = major > 23 || (major === 23 && minor >= 6);
  if (ok) return { ok: true, detail: `Node ${version} (≥ 23.6 — type-stripping supported)` };
  return {
    ok: false,
    detail: `Node ${version} is too old — convoy needs ≥ 23.6 (it runs TypeScript directly via native type-stripping)`,
    fix: "upgrade Node to ≥ 23.6 (e.g. `nvm install 23` or your platform's installer), then re-run",
  };
}

/** git must be present + runnable — the readiness capstone commits a fix, and setup clones repos. Injectable
 *  runner so a test can simulate git-absent / git-present. */
export async function gitUsableCheck(runner: (cmd: string, args: string[]) => Promise<ExecResult>): Promise<EnvCheck> {
  const r = await runner("git", ["--version"]);
  if (r.ok && /git version/i.test(r.stdout)) return { ok: true, detail: r.stdout.trim() };
  return { ok: false, detail: "git is not usable (not installed or not on PATH)", fix: "install git (`xcode-select --install` on macOS, or your package manager), then re-run" };
}

/** The temp dir must be short enough that a doctor SANDBOX network path fits pty's unix-socket budget. pty's
 *  socket (`<net>/pty/<session>.ding.sock`) must fit the ~104-byte kernel limit; doctor builds sandboxes under
 *  TMPDIR, so a long TMPDIR (macOS `/var/folders/…` is already ~49 bytes) can push the socket over. We model the
 *  same `<TMPDIR>/cvd-<tag>-XXXXXX/n/pty` path makeSandbox builds and check it against the 70-byte net budget
 *  (which leaves room for the socket name). Varies by machine → check, don't assume. */
const NET_BUDGET = 70;
export function tmpdirSocketCheck(dir: string = tmpdir()): EnvCheck {
  // Representative sandbox net/pty path: mkdtemp adds `cvd-full-` + 6 random chars; `/n/pty` is the network root.
  const sampleNetPty = join(dir, "cvd-full-XXXXXX", "n", "pty");
  const bytes = Buffer.byteLength(sampleNetPty, "utf8");
  if (bytes <= NET_BUDGET) return { ok: true, detail: `TMPDIR fits (a sandbox socket path is ~${bytes}/${NET_BUDGET} bytes: ${dir})` };
  return {
    ok: false,
    detail: `TMPDIR is too long (${bytes} > ${NET_BUDGET} bytes for a sandbox socket path: ${dir}) — pty sockets won't fit the ~104-byte limit`,
    fix: "set TMPDIR to a shorter dir (e.g. `export TMPDIR=/tmp`), then re-run",
  };
}

/** OS — convoy targets macOS + Linux. Informational (never fails), but names the platform so a failure elsewhere
 *  is easy to attribute and so we're explicit that Windows isn't a supported target. */
export function osCheck(platform: NodeJS.Platform = process.platform): EnvCheck {
  if (platform === "darwin") return { ok: null, detail: "OS: macOS (darwin)" };
  if (platform === "linux") return { ok: null, detail: "OS: Linux" };
  return { ok: false, detail: `OS: ${platform} — convoy supports macOS + Linux; other platforms are untested`, fix: "run convoy on macOS or Linux" };
}
