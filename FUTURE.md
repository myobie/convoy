# Future directions (post-v1)

Captured for later — **not** part of v0 (CLI + app + install story). Here so the ideas aren't lost.

- **Sandboxes** — deeper per-agent isolation beyond a folder/worktree.
- **Shell-command gateway** — proxy an authenticated *host* command into a guest VM/sandbox: e.g.
  code in a Docker container runs `gh`, and it transparently proxies to the host where `gh` is
  already authenticated. **Auth stays on the host, never pushed into the container** — the same
  principle as the menubar app holding TCC grants for its agents: keep the credential at the host,
  proxy the access.
- **OTel** — tracing / observability across the network.
- **Token optimization.**
- **Base + overlay persona compose** — a base persona + a person's private overlay (from their CoS
  repo) → an effective persona. `convoy add`'s shape already anticipates this; today it installs a
  single base persona. (See `notes/ACCEPTANCE.md`.)
- **Universal + notarized distribution** — arm64 + x86_64 slices, Developer ID + notarization so the
  download needs no Gatekeeper workaround. (See `notes/DISTRIBUTION.md`; `scripts/sign.sh` is ready.)
- **App → its own repo** — extract `Convoy.app` to a separate repo so the CLI repo stays clean for
  Linux/server users. v0 keeps the monorepo but is built split-ready (`ConvoyApp` couples to the CLI
  only through `ConvoyKit`).
