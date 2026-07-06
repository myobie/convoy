# IDEA — convoy as the single entrypoint + a macOS menubar app

_Draft, 2026-07-06. Queued behind the current in-flight (evals, convoy CLI migration, persona restructure). This is the shape, not a commitment to build now._

## Part 1 — convoy is the single front door

Today setup is a scatter of steps (make a smalltalk folder, make a CoS repo, `st launch`, wire hooks, grant permissions…). `convoy` should be the **one command** that does all of it:

- `convoy init [dir]` — create + wire a smalltalk network folder (its `ST_ROOT`, bus layout, hooks).
- `convoy add <harness> --identity <id> [--ding] [--as worker:integrator] …` — add an agent (was `st launch`); composes base + overlay personas.
- `convoy remove <id>` — decommission an agent.
- **CoS bootstrap** — help create the CoS, create/point at its **private git repo**, run the first-run interview, launch it.
- `convoy doctor` — "will this work here?" (tools installed, config sane, hooks fire, bus round-trips, an agent can spawn, **TCC grants present**).
- `convoy ls` — list the network (convoys + CoS + agents).
- **macOS:** `convoy app install` — install/alias the menubar `.app` into `/Applications` (via a Homebrew cask or a direct copy).

Everything else (smalltalk = bus, pty = sessions) sits *under* convoy. One thing to learn.

## Part 2 — the macOS menubar app (`Convoy.app`)

**Why it exists (it's not a workaround — it's the right macOS architecture).** A headless `node` daemon can't cleanly hold macOS privacy grants, can't be seen, and can't be a reliable watchdog. A proper `.app` fixes all of it at once. It **converges four fragile-today needs into one native host:**

1. **TCC grant-holder** — a signed `.app` with the right `Info.plist` usage keys (`NSCalendarsUsageDescription`, etc.) can hold **Full Disk Access + Calendar**. Every agent + nano CLI it launches inherits those grants (this is exactly *why running the nano tools from a normal terminal app works* — the terminal is a grant-holding app; a headless node daemon is not). Fixes Messages **and** Calendar — the latter isn't fixable by adding a binary to Full Disk Access.
2. **Keep-awake** — an IOKit power assertion (the `caffeinate` job) so the Mac doesn't sleep and pause/kill the network.
3. **The durable watchdog** — an always-running heartbeat that can't itself park. It runs parked-agent detection + the intelligent-ding TUI idle-reading **from outside any Claude session** — the thing the session-only shepherd cron structurally can't be (it dies silently on restart/compaction; a live CoS was parked-blind for ~100 min because of exactly that).
4. **Visibility / dashboard** — menubar presence answers "is it alive?" and shows each convoy + CoS at a glance, flagging parked agents.

It also **owns `pty gc`** (replacing the launchd gc job for app users). `launchd`/`systemd` stays the headless/server path; the app is the path for interactive Mac users who want the nano CLIs and want to *see* their network.

## Part 3 — how it's built (the research)

- **Menubar UI: SwiftUI `MenuBarExtra`** (macOS 13+). Genuinely a few lines:
  ```swift
  @main struct ConvoyApp: App {
      var body: some Scene {
          MenuBarExtra("Convoy", systemImage: "point.3.connected.trianglepath.dotted") {
              NetworkStatusView()   // convoys + CoS + parked flags
          }
          .menuBarExtraStyle(.window)
      }
  }
  ```
  `LSUIElement=true` in Info.plist → menubar-only (no Dock icon).
- **No Xcode:** [**Swift Bundler**](https://swiftbundler.dev/) — a layer over Swift Package Manager that turns an SPM executable into a real distributable `.app` bundle via a git-friendly TOML config. Matches Nathan's existing no-Xcode Swift workflow (the nano tools already build via SPM → `.build/release/…`). `codesign` + `notarytool` are CLI tools — the whole pipeline is Xcode-free.
- **TCC caveat (the crux):** for grants to attach *durably*, the app needs (a) a proper `Info.plist` with the usage-description keys, and (b) a **stable signing identity** (Developer ID, or stable ad-hoc) so TCC recognizes it across rebuilds. This is precisely what the headless node binary can't satisfy — and why the grant kept getting lost.
- **Distribution: a Homebrew cask.** A custom tap (`myobie/homebrew-convoy`) or homebrew-cask: `brew install --cask convoy` copies `Convoy.app` to `/Applications` and can symlink the `convoy` CLI (a cask's `binary` stanza). Casks download → checksum → copy `.app` → symlink CLI → postflight. `convoy app install` can also do the copy directly for non-brew users.

## Part 4 — the one real architectural decision

For agents to **inherit the app's TCC grants, the app must be their responsible process** — i.e. the app has to *host* the pty-daemon (spawn it as a child), not merely coexist with it. Today the `pty` CLI self-daemonizes the pty-daemon under launchd. So the app would need to launch/own the pty-daemon (or re-parent it) so every agent runs under the app's TCC context. **This is the decision that makes or breaks the whole idea** — get it right and grants "just work" for the whole tree; get it wrong and the app is only a dashboard.

## Open questions
- **Signing:** Developer ID + notarization (distributable to others) vs stable ad-hoc (author-local only)? Ad-hoc is enough for a first cut; Developer ID for sharing.
- **Dashboard scope:** read-only status first; actions (restart/unstick a parked agent from the menubar) later.
- **Repo home:** live in `convoy` (a `macos/` dir), or its own `convoy-app` repo?

## Sources
- Homebrew: [Cask Cookbook](https://docs.brew.sh/Cask-Cookbook) · [homebrew-cask](https://github.com/Homebrew/homebrew-cask)
- Menubar: [MenuBarExtra (Apple)](https://developer.apple.com/documentation/SwiftUI/MenuBarExtra) · [Sarunw guide](https://sarunw.com/posts/swiftui-menu-bar-app/)
- No-Xcode: [Swift Bundler](https://swiftbundler.dev/) · [objc.io: SwiftUI without an Xcodeproj](https://www.objc.io/blog/2020/05/19/swiftui-without-an-xcodeproj/)
