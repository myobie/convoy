# convoy — acceptance criteria

Operator-specified acceptance criteria. These are **requirements, not polish**.
If convoy ships without these, it has not done its job.

## AC-1 — `convoy add` is correct-by-construction (no footguns)

**The whole reason convoy exists:** we keep starting agents by hand with wrong ENV/config and
it bites us. `convoy add` must make it **impossible to misconfigure an agent.**

### It takes high-level intent, not wiring

```
convoy add <role> --identity <id> --transport <mcp|ding> --network <path> [--persona <path>]
```

The user supplies **intent** — identity, role, transport, which network. convoy **generates ALL
the wiring, correct-by-construction, and validates it before launch.** There is:

- **No hand-authored `pty.toml`.**
- **No hand-set `ST_AGENT`** (derived from `--identity`).
- **No hand-chosen permission mode** (derived from `--role`, see table).
- **No way to fumble an env var, tag, MCP path, or hook.**

### Derived, never hand-set

| Concern              | Derived from        | Rule |
|----------------------|---------------------|------|
| `ST_AGENT`           | `--identity`        | always set to the identity; never hand-typed |
| `CLAUDE_PERMISSION_MODE` | `--role`        | **spawner/CoS → `bypassPermissions`**; **worker → `auto`**. Never hand-chosen. |
| `st.network` tag     | `--network`         | always tagged so the agent is findable on its bus |
| MCP wiring           | `--mcp` (opt-in)    | `.mcp.json` references **`bin/st`** (the bus binary) |
| ding sidecar         | default (ding)      | ding sidecar installed; no MCP block |
| hooks                | role + network      | session-start boot ritual etc. wired automatically |
| session-id bootstrap | generated           | handled by convoy; never mis-typed by hand |

### Validate before launch — fail loud, never launch broken

Before spawning, convoy runs a preflight that checks every derived value is present and coherent:
identity non-empty and unique on the network, network path exists and is a smalltalk root,
transport resolves to a real bin, permission mode matches the role, required hooks in place.

**If a config is invalid or ambiguous, fail with a clear message and DO NOT launch.**
A broken agent that silently starts is worse than a loud failure.

### Case in point — the anti-pattern this replaces

cos hand-wrote convoy-claude's own `pty.toml`:

```toml
prefix = "convoy"
[sessions.claude]
command = "$HOME/bin/pty-claude-launcher.sh --dangerously-load-development-channels server:st"
tags = { role = "agent", "st.network" = "~/.local/state/smalltalk" }
[sessions.claude.env]
ST_AGENT = "convoy-claude"
CLAUDE_PERMISSION_MODE = "bypassPermissions"
```

Every line here is a place to fumble: the wrong bin, a missing tag, a mistyped `ST_AGENT`, the
wrong permission mode. **`convoy add spawner --identity convoy-claude --transport mcp --network
<...>` must generate exactly this — correct — from intent alone.** Eliminating this manual,
error-prone step is the point of `convoy add`.

## AC-2 — `convoy init` wires a network with the same discipline

`convoy init [dir]` creates + wires a smalltalk network folder (ST_ROOT, bus layout, hooks) so
that agents added into it are correct-by-construction. No hand-editing to make a network usable.

## AC-3 — `convoy doctor` proves it works here

`convoy doctor` is the "will this actually work?" check: tools installed, config sane, hooks
fire, the bus round-trips, an agent can spawn, (later) TCC grants present. It should catch the
same footguns AC-1 prevents — so a misconfig is caught by `doctor`, not discovered in production.

---

_Captured 2026-07-06. Drives the `convoy add`/`init` design; referenced from the Wed-demo plan._
