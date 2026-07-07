# convoy → TypeScript — port plan (milestone M0)

**Decision (Nathan, via cos):** the convoy **CLI + core port from Swift to TypeScript** (Node/ESM,
matching pty `@myobie/pty` and smalltalk `@myobie/coord`). The macOS app stays Swift and **splits to a
separate `convoy-macos` repo**. This is a **PORT of a proven design** — the Swift build validated the
whole thing live (FlappingCap algorithm, reconcile/respawn loop, `convoy.pid` lock, launch derivation,
TCC-anchoring, 15/15 e2e, capstone 6/0) — **not a redesign.** Portability is the reason: Node runs on
Johannes's Linux box; the Swift was a shortcut to share code with the Mac app, and the app is a
secondary add-on.

**Why TS is strictly better here (beyond portability):** it dissolves the Swift/TS boundary that forced
every awkward seam in the Swift version —
- pty integration becomes **native** (`@myobie/pty/client`: `spawnDaemon`/`listSessions`/`readMetadata`
  /`updateTags`/`appendEventSync`/`isGone`/`readPtyFile`) instead of shelling `pty … --json` and parsing.
- launch-absorb becomes a **direct import** of smalltalk's launch helpers (no `st __launch-core`
  subprocess bridge — that whole plan is obviated).
- §5.5 manual-reset can be **event-driven** (subscribe to pty `tag_change` via `EventFollower`) →
  sub-second, vs the Swift reconcile-tick poll.

---

## 1. Runtime convention (verified against pty + smalltalk)

- **Node ESM, TS run via type-stripping.** Node **v25.8** is installed (native `.ts` execution; stable
  since 23.6). smalltalk exports its lib as **source `.ts`** (`exports["."] → src/index.ts`) and runs
  examples with `node --experimental-strip-types` → **convoy matches: write `.ts`, run directly, no
  build step to run.** `bin/convoy` = `#!/usr/bin/env node` shim → `src/cli.ts` (like pty's `bin/pty`).
  - *One thing to confirm with Nathan/pty:* pty **compiles** to `dist` (`tsc`) and publishes JS;
    smalltalk runs **`.ts` directly**. I lean **direct-`.ts` (smalltalk-style)** — simpler, node-native,
    no dist step — with `tsc --noEmit` for typecheck only. Confirm before M1 (it's a one-line bin diff).
- **Tests: vitest** (both pty and smalltalk use it).
- **TOML: `smol-toml`** (pty's dep) for reading `pty.toml` (`readPtyFile` native).
- **CLI dispatch: hand-rolled `process.argv`** switch, like pty's `src/cli.ts` (no heavyweight arg lib).
  convoy's flag surface is modest; a small typed parser keeps it ecosystem-consistent.
- **Package:** `@myobie/convoy`, `"type": "module"`, `bin: { convoy: "./bin/convoy" }`.

## 2. Module breakdown — Swift → TS

Legend: **[1:1]** proven logic + wire-format, port verbatim · **[native]** same behavior, rewritten to
use the ecosystem lib (removes shell-out/parse code) · **[move]** leaves convoy for convoy-macos.

### Core (Swift `ConvoyKit/` → TS `src/`)
| Swift | TS | Kind | Notes |
| --- | --- | --- | --- |
| `FlappingCap.swift` | `src/flapping-cap.ts` | **[1:1]** | The §5 classifier + frozen §8.1 wire-formats + `commandFingerprint`. Highest-fidelity; the 13 tests port exactly. TS `crypto` for the SHA-256 prefix. |
| `Role.swift` | `src/role.ts` | **[1:1]** | role → permission-mode / permanent / persona table + aliases. |
| `HostLock.swift` | `src/host-lock.ts` | **[1:1]** | `<root>/convoy.pid` + the one clear warning. `process.kill(pid, 0)` liveness probe. |
| `AgentSpec.swift` | `src/agent-spec.ts` | **[1:1] + [native]** | Derivation (permission/permanent/transport/persona) is 1:1; the *launch orchestration* goes native (below). Includes the `--permanent` override. |
| `Host.swift` (PtyHost/SupervisedSession) | `src/host.ts` | **[native]** | Replace shelling `pty list/tag/restart/kill` with `@myobie/pty/client` — typed `SessionMetadata` (exitedAt, tags), `updateTags`, `spawnDaemon`, `isGone`. No JSON re-parsing. |
| `Bus.swift` | `src/bus.ts` | **[native]** | Network members/status. Shell `st` initially (works today); migrate to `@myobie/coord` lib calls as smalltalk exposes them (its `index.ts` exports only `VERSION` today). |
| `Personas.swift` | `src/personas.ts` | **[1:1]** | clone/resolve the personas repo (git + fs). |
| `Shell.swift` | `src/exec.ts` (tiny) | **[native]** | Mostly eliminated — native libs replace most shell-outs; keep a small `execFile` helper for residual `st`/`git`. |
| launch (`AgentSpec.stLaunchArgs/dryRun/launch`) | `src/launch.ts` | **[native]** | **The absorb.** Import smalltalk's launch helpers directly (`installPersona`, `buildPtyToml`, `installDingBus`, `cmdInit`, `buildClaude/CodexCommand`, session-id bootstrap) — no `st launch` shell-out, **no `st __launch-core` bridge**. Needs smalltalk to export them (smalltalk-claude offered); until then, shell `st launch` as a stopgap. |

### CLI (Swift `convoy/Commands/` → TS `src/commands/`)
`ls · doctor · init · add · remove · cos · up · personas` → one `.ts` each, dispatched from
`src/cli.ts`. **`app` → moves to convoy-macos.**
- **`up.ts` is the load-bearing port** (reconcile loop + signals + `--json` events + HostLock +
  FlappingCap). Cleaner in TS: native pty client for list/respawn/tags; optional `EventFollower` for
  sub-second §5.5. Preserve the exact event schema (`identity`=logical id, `session`=pty id, the frozen
  `session_flapping` payload) so the capstone binds unchanged.

## 3. What's genuinely new vs carried over
- **Carried 1:1 (port verbatim, guarded by ported tests):** FlappingCap + wire-formats, Role, HostLock,
  AgentSpec derivation, Personas, the reconcile-loop control flow, the event schema.
- **Native rewrites (behavior identical, less code):** Host/pty (→ client API), Bus (→ st/coord),
  launch (→ smalltalk helpers).
- **New/better in TS:** event-driven §5.5 (EventFollower); typed pty metadata (no JSON reparse);
  `readPtyFile` via smol-toml; single node toolchain across convoy/pty/smalltalk.

## 4. Test strategy — the guardrails (why this port is low-risk)
The behavior is pinned by **language-agnostic** guardrails, so the TS binary is verified against the
proven Swift behavior:
1. **Commit the A–G broad e2e FIRST** as `scripts/e2e-convoy-up.sh` (binary-driven; my ad-hoc 15/15
   live proof → a permanent guardrail). Green on the Swift binary now; guards the TS binary later.
2. **`scripts/demo-smoke.sh`** — reuse AS-IS (takes the binary path) against the TS `convoy`.
3. **evals capstone** (st-evals) — point `CONVOY_BIN` at the TS binary; same acceptance test
   (coordinate the re-run with evals-claude once it boots).
4. **Port the 31 unit tests to vitest** — FlappingCap **13 exactly** (the classifier spec), AgentSpec
   11, Personas 4, Pty→host 3.
- **Bar:** port until `e2e-convoy-up.sh` + `demo-smoke.sh` + the capstone + the ported unit tests all
  PASS against the TS binary — the same bar the Swift build cleared.

## 5. Milestones (build order; report each)
- **M0 — this plan.** ✅ posting now.
- **M1 — guardrail + scaffold.** Commit `scripts/e2e-convoy-up.sh` (green on Swift). Scaffold the TS
  package (ESM, tsconfig, vitest, `bin/convoy` shim, `src/cli.ts` skeleton). Confirm runtime
  (direct-`.ts` vs dist) with Nathan/pty. Extract the Swift app to `convoy-macos` so the repo goes
  cleanly CLI-only (see §6).
- **M2 — pure core.** `flapping-cap.ts` + `role.ts` + `host-lock.ts` + wire-formats + their vitest
  tests (FlappingCap 13 exactly). No I/O; highest fidelity.
- **M3 — native pty/st.** `host.ts` (→ `@myobie/pty/client`) + `bus.ts` (→ st) + `exec.ts`.
- **M4 — launch absorb + the easy commands.** `agent-spec.ts` + `launch.ts` (import smalltalk helpers;
  coordinate exposure) + `add/cos/init/remove/ls/doctor/personas`.
- **M5 — `convoy up`.** The reconcile loop + events + signals + `--permanent` + HostLock.
- **M6 — guardrails green.** `e2e-convoy-up.sh` + `demo-smoke.sh` + ported unit tests + capstone all
  pass against the TS binary.
- **M7 — cutover.** TS `convoy` becomes the shipped/installed binary (swap `~/.local/bin/convoy`).

## 6. macOS split → `convoy-macos` (private)
- **New private repo `convoy-macos`:** `ConvoyApp` (menubar, HostController), Swift-Bundler packaging,
  `sign.sh`, `Info.plist`. convoy repo becomes **CLI-only**.
- **Shared contract = on-disk formats + interfaces, NOT a Swift ConvoyKit** (there won't be one — the
  core is TS). convoy-macos consumes: `pty.toml`, `<root>/convoy.pid` + the HostLock format, the
  `strategy.*` tags, and the `st`/`pty` interfaces. Cleanest: **the app runs `convoy up` as its child**
  (the app = TCC anchor spawning it) → it inherits the reconcile loop + the single-owner lock for free,
  which is exactly the §6.1 "app = Mac always-on host" model. (A tiny Swift re-impl of the convoy.pid
  read + warning is the fallback if the app wants its own detection.)
- **Timing:** the extraction is *forced* by the port (a Swift app can't live in a TS repo), so it
  happens at **M1**. But macOS **feature** work stays deferred post-reboot (declutter now, features
  later). Both repos must build after the split (the app just needs `st`/`pty` on PATH + the TS
  `convoy` binary — no Swift dependency on convoy).

## 7. Effort + sequencing input
- **Rough effort to a TS binary passing all guardrails:** core + tests (M2) ~fast; native integration
  (M3–M5) is the bulk but *removes* code (libs do the heavy lifting); guardrails (M6) gate it.
  Ballpark **~2–4 focused days**, de-risked by the proven design + the guardrails. macOS split ~0.5 day.
- **Long poles:** `convoy up` (M5) and smalltalk exposing its launch helpers (M4 — coordinate; stopgap
  = shell `st launch`).
- **Sequencing (feeds Nathan's call):** *port-before-reboot* gives a portable binary for the reboot but
  adds the port to the critical path; *reboot-on-Swift-then-port* de-risks reboot timing (Swift is
  proven + installed) and ports after. **My lean: reboot-on-Swift, port immediately after** — the Swift
  binary is validated + locally installed, so it can host the reboot today; the TS port then lands for
  Johannes/Linux without gating the reboot. But it's Nathan's call; this estimate is the input.

## 8. Confirm before M1
1. **Runtime:** direct-`.ts` (strip-types, smalltalk-style) vs `tsc→dist` (pty-style)? (lean: direct-`.ts`.)
2. **smalltalk exposes launch helpers** as importable lib (obviates the `st __launch-core` bridge) —
   coordinate with smalltalk-claude.
3. **Sequencing:** port-before-reboot vs reboot-on-Swift-then-port (§7).
4. **`convoy-macos` private** (confirmed) — create it at M1.
