# convoy — where everything lives

convoy stands up and supervises a crew of agents. This is the map: where state lives on disk, and what each command does to it. (Reference for a first-time user; kept in sync as the [structure redesign](https://github.com/myobie/cos/blob/main/notes/convoy-structure-redesign.md) lands piece by piece.)

## The unit: a convoy agent session

One agent = **an identity** (`ST_AGENT`, e.g. `cos-claude`, host-scoped for its folder name) + **two ptys** (the harness process — claude/codex — and the `st ding` sidecar that delivers bus messages as `[DING]` pokes) + **a workspace** (a repo or git worktree) + **a bus folder** (inbox/archive/status). It is restartable from its `.convoy/pty.toml`, and accrues `context/now.md` + `decisions/` as the working memory it carries across restarts.

## On-disk layout: a network

A convoy **network** is a named home for one crew. Networks live under `$XDG_STATE_HOME/convoy/` (default `~/.local/state/convoy/`), one dir per network, default name `default`:

```
$XDG_STATE_HOME/convoy/<network>/
  smalltalk/                       # the bus — SYNCED across machines (st sync over fabric)
    <host>.<identity>/             # one folder per agent, hostname-prefixed (e.g. silber.cos-claude)
      inbox/  archive/  status     # messages + the liveness heartbeat (the status file's mtime)
      context/                     # the agent's working memory (cold-boot state)
        now.md  decisions/
      resources/
  pty/                             # pty runtime state (sockets/pids) — MACHINE-LOCAL, never synced
  worktrees/                       # the workspaces — git worktrees, or symlinks to repos
```

- `smalltalk/` is the synced bus — `ST_ROOT` points here. `pty/` and `worktrees/` are **siblings outside** the sync boundary, so machine-local runtime state never leaks across machines.
- Agent folders are **hostname-prefixed** (`<host>.<identity>`), so each machine's agents are distinct and sync as a clean union. The host is read from the folder-name prefix. Moving an agent across machines = copy its bus folder to a new `<newhost>.<identity>` folder + re-cut its workspace; `now.md`/`decisions/` travel with the copy.

## The workspace overlay: what convoy writes into a repo

Everything convoy works on is a **repo or a git worktree**, and convoy composes an agent into it **without polluting it** — the product-repo root stays pristine. The only footprint is two dot-dirs, both **git-excluded** (via `.git/info/exclude`, never a tracked `.gitignore`):

```
<workspace>/
  .claude/
    rules/convoy.md                # the LOADER — Claude Code auto-loads it; @imports the .convoy/ content
    settings.local.json            # the state-externalization hooks (Claude's own convention dir)
  .convoy/
    PERSONA.md                     # the agent's role/persona
    DING-BUS.md                    # the ding-mode bus instructions
    pty.toml                       # the LAUNCH SPEC — session commands + tags + env (NO conversation --resume)
```

- The workspace **root has zero visible convoy files** — nothing scattered around. `git status` stays clean, and the repo's own `CLAUDE.md` is never touched.
- `.convoy/pty.toml` is a launch **spec**, not a conversation resume: it says how to cold-start + supervise the agent's two ptys. Agents cold-boot; state carries across CLI sessions via the externalization hooks + `context/now.md`.

## What each command does

| Command | What it does |
| --- | --- |
| `convoy init [dir]` | Interactive, **narrated** walkthrough. Prompts for the network **name**, a **megarepo** location (or "no megarepo"), and any CoS bootstrap. Creates `<net>/{smalltalk,pty,worktrees}` + records config. Tells you each step as it happens. |
| `convoy add <role> --identity <id>` | Composes one agent: cuts its **worktree** (off the megarepo, or symlinks a repo into `worktrees/`), writes the `.convoy/` + `.claude/` **overlay**, creates its **bus folder** (`smalltalk/<host>.<id>/` with inbox/archive/status), writes `.convoy/pty.toml`, and **spawns** its two ptys (harness + `st ding`). |
| `convoy up <network>` | **Hosts** the network: (re)spawns each agent's ptys from their `.convoy/pty.toml` manifests + supervises them — respawn permanents on crash, flapping-cap. |
| `convoy down <network>` | The **only** path that tears down sessions. |
| `convoy doctor` | **Narrated** proof the network is set up correctly **and** can do real work: checks the **structure** (named net; `smalltalk/` + `pty/` + `worktrees/`; each workspace's `.convoy/` overlay git-excluded + a pristine root; pty.toml carries no `--resume`), then runs a real **CoS → supervisor → worker** graded task on the bus. **Green doctor = a working convoy.** |
| `convoy ls [--tree]` | List the crew; `--tree` shows the spawn-parentage forest + cross-machine liveness. |

## The onboarding path

A brand-new user runs **`convoy init`** (chatty walkthrough → a correctly-structured network), then **`convoy doctor`** (narrates every check, proves the network is real and can work). Green doctor = convoy is working for a first-timer.
