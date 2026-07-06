# The TCC hosting crux (IDEA.md Part 4)

**The one architectural decision that makes or breaks the menubar app.** For agents to inherit the
app's TCC grants (Full Disk Access + Calendar), **the app must be their responsible process** —
i.e. the app must *host* the pty-daemon (spawn it as a child), not merely coexist with it.

## What we know (de-risked)

- **`pty run -d` re-parents to launchd (PID 1)** — confirmed by pty-claude: `child_process.spawn(…,
  { detached: true }) + child.unref()` → `setsid()` → orphan → launchd adopts it. So the mechanical
  worry ("will it even run under a GUI app?") is **not** a blocker.
- **The responsible process is set at `posix_spawn` time and cached in the kernel** — it does *not*
  follow ppid, so it should survive the re-parent. In principle a chain `Convoy.app → pty → daemon →
  agents` keeps the daemon's responsible-pid pointed at `Convoy.app`, so grants on the app's bundle
  id apply to the whole tree.
- **The risk**: Node's `spawn` doesn't call `responsibility_spawnattrs_setdisclaim(false)` to *lock*
  inheritance in. On some macOS versions the default may disclaim, or the re-parent may trigger a
  responsibility recompute — and agents lose grants. Chrome/VS Code deliberately disclaim (opposite
  of what we want); we rely on the default sticking. **Unverified.**

## The gate (run before building hosting)

`scripts/tcc-probe.sh` — grant a launcher FDA + Calendar, spawn a probe via `pty run -d`, kill the
launcher, check whether the probe still reads `~/Library/Calendars`. Needs a human (TCC grants are a
System Settings action). **0 → grants inherit → build hosting. Non-zero → day-2 with a shim.**

## The build (once the gate is green)

1. On launch, `Convoy.app` ensures the pty-daemon is running **as its own child** (spawn `pty` /
   `pty up` via `Process`; Foundation does *not* disclaim, which is what we want). This sets the
   daemon's responsible process to the app.
2. Menubar control to start/stop the network (`pty up` / `pty down`) and show host status.
3. `convoy` CLI defers daemon ownership to the app when the app is the host (replacing the launchd
   gc job for app users); `launchd`/`systemd` stays the headless path.

## If the gate is red (day-2 fallback)

A tiny native shim the app spawns that calls `responsibility_spawnattrs_setdisclaim(false)` before
exec'ing `pty`, forcing inheritance — or a long-lived supervisor process the app keeps alive to hold
the TCC anchor. Either is a focused, separable addition; the app ships as dashboard + keep-awake
until then.

## Current status

Mechanically ready to build (re-parenting confirmed, probe written, app already spawns `st`/`pty`
via a disclaim-free `Process`). **Blocked only on the human TCC probe result** — building on faith is
explicitly out (a hosting app that silently doesn't inherit grants is worse than an honest dashboard).
