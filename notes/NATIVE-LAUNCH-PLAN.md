# Native launch — convoy owns `add`/`cos` launch (milestone-0 plan)

**Goal:** `convoy add`/`cos` fully own agent launch — **no `st launch` shell-out**. Agents come back
`--resume <sid>` (not `--fresh`). The native-launch capstone green by morning. **NO `convoy.toml`** —
derive everything from the agent folder + the pty registry.

## Where we are (the stopgap this replaces)
`convoy add` today = `st launch --fresh` (writes wiring) + convoy's native `spawnDaemon`
(`spawnFromPtyFile`). Two debts: (1) `--fresh` → agents don't resume; (2) still leans on `st launch`'s
write-logic, including the bits that broke post-cutover (the `claude --print` session-id bootstrap
hangs; its pty registration no-ops).

## Already owned — do NOT rebuild
persona resolution (`Personas`), permission-mode / permanent / transport derivation (`Role`/`AgentSpec`),
the native spawn (`host.ts` `spawnDaemon`), enriched PATH (`exec.ts`), `convoy up` (reconcile / respawn
via `pty restart -y` / flapping-cap). All green (e2e 14/0, 45 units).

## Reimplement natively (`src/launch.ts`) — scrutinized to the minimum an agent needs
1. **session-id / `--resume` — THE fix.** `<dir>/.claude-session-id`:
   - **Existing** (migrating agent) → command uses `--resume <sid>` (its jsonl already exists → resumes).
   - **New** (fresh agent) → mint a UUID, write `.claude-session-id`; create the session WITHOUT the
     hanging `claude --print` bootstrap — use `claude --session-id <uuid>` if it creates the jsonl, else
     let claude create it on first `--resume <new>` (I'll pin the exact behavior with a 2-line test
     first thing in the build).
   - **Respawn/relaunch ALWAYS `--resume <sid>`** — the sid persists in `.claude-session-id` and the
     jsonl exists after first run. This is the `--fresh`→`--resume` fix the capstone needs.
2. **the claude session command builder.** The unattended auto-poker
   (`(sleep N && pty send <displayName> key:return) × k &`) that dismisses claude's first-launch TUI
   gates, then `exec claude --permission-mode <m> --resume <sid>`. (Reimplements st launch's builder.)
3. **pty.toml write.** Serialize the per-agent manifest (`prefix`, `[sessions.claude]` command+tags+env,
   `[sessions.ding]`) with `smol-toml`. It's the record convoy spawns from + `convoy up` respawns from
   (`pty restart` uses stored metadata). Note: this is **pty's** format, not a `convoy.toml`.
4. **ding-sidecar spawn.** `spawnDaemon` the `st ding <agent>-claude --identity <agent>` session
   (role=ding, strategy=permanent, ptyfile.session=ding). `st ding` stays a smalltalk runtime binary
   (bus-side) — convoy just spawns + supervises it.
5. **spawn + tags.** `spawnDaemon` the claude session + the ding sidecar (host.ts, already works). Tags:
   role, strategy=permanent, st.network, ptyfile/ptyfile.session; env: ST_AGENT + enriched PATH.

## The handoff-to-smalltalk — the ONE decision for your review
An agent also needs the smalltalk-specific wiring to work on the bus: `PERSONA.md`, `DING-BUS.md`,
`CLAUDE.md` `@`-imports, and `.claude/settings.local.json` **hooks** (SessionStart boot-ritual,
PreCompact flush, StopFailure ding) — and those hooks **reference smalltalk's scripts by absolute path**
(`…/smalltalk/examples/claude-code/hooks/{session-start,pre-compact,stop-failure}.sh`). These are
smalltalk artifacts, so "remove st launch" forces a choice:

- **A — import smalltalk's `cmdLaunch` (RECOMMENDED).** Call it as a library (smalltalk-claude is
  exposing it) to write the wiring correctly, passing `--fresh` so IT skips the hanging bootstrap; then
  **convoy owns the spawn + the session-id/`--resume` + the ding-sidecar.** Minimal convoy code, reuses
  smalltalk's tested writes, no duplicated hook/template drift. "Native" = a function call, not a
  shell-out; convoy still owns launch (drives it, controls spawn + resume).
- **B — fully reimplement the writes.** convoy writes persona/ding-bus/hooks itself, resolving
  smalltalk's hook-script paths + vendoring the DING-BUS template. Zero smalltalk-launch dependency, but
  duplicates smalltalk artifacts (drift risk) + more code (~+0.5 day).

**Recommendation: A** — convoy owns launch (spawn + session-id/resume + ding-sidecar + the removal of
the shell-out) while not duplicating smalltalk's hook/persona/ding artifacts. It's the smallest correct
surface. If you want zero smalltalk-launch coupling, say B and I'll vendor.

## st-launch-shell removal
Delete the `st launch --fresh` shell-out from `launchSpec` (src/commands.ts). Replace with the cmdLaunch
import (A) or convoy's native writers (B). Keep `st` for the bus (`message`/`agents`/`status`) and
`st ding` as the sidecar runtime binary. Coordinate the retirement of `st launch`'s user surface with
smalltalk-claude.

## Verification (the DONE bar)
- `convoy add worker` → agent boots ding-only, **resumes** (`--resume`), registers permanent, hostable.
- Kill under a running `convoy up` → respawns (`--resume`, command preserved).
- evals **native-launch capstone** green (coordinate the re-run) + e2e-convoy-up 14/0 + demo-smoke 10/0
  + vitest all green vs the TS binary.
- New unit tests: session-id resolution (new→create / existing→`--resume`) + the command builder.

## Effort
- **Option A: ~0.5 day** (session-id/resume + command builder + cmdLaunch wiring + ding-sidecar +
  st-launch removal + tests).
- **Option B: ~1 day** (+ native persona/ding-bus/hooks writers + vendoring smalltalk artifacts).
- Decision-INDEPENDENT + startable now: the session-id/`--resume` fix + the ding-sidecar (convoy-native
  in both). A/B only changes step 3's write-logic + the handoff. Gated on: smalltalk exposing
  `cmdLaunch` (A) — coordinate with smalltalk-claude.

## Build order (overnight)
- **M1** — session-id/`--resume` (native, decision-independent): the capstone's resume fix + tests.
- **M2** — ding-sidecar spawn (native).
- **M3** — the write-logic per your A/B call (A: cmdLaunch import; B: native writers).
- **M4** — remove the `st launch` shell + handoff coordination with smalltalk-claude.
- **M5** — guardrails + the native-launch capstone (with evals) → green. Ping when green = migrate-ready.
