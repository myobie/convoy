#!/usr/bin/env bash
# clean-room.sh — prove resilient onboarding WITHOUT a second machine.
#
# Runs the install-cli + `convoy doctor --quick` flow in a THROWAWAY environment stripped of this machine's help
# — a fresh $HOME, a bare PATH (no ~/.local/bin, none of your installed CLIs), signed-out — so nothing here can
# make it falsely pass. Then it INJECTS each failure condition and asserts the preflight catches it with the
# RIGHT actionable message. If the flow works stripped of this machine, it will very likely work on a stranger's.
#
# Usage:  bash scripts/clean-room.sh        (run from anywhere; resolves the convoy clone from its own path)
# Portable: POSIX-ish bash, no sed -i / stat -f / realpath / launchctl. Requires: node, git, a writable /tmp.

set -u

# --- resolve the convoy clone from this script's location (portable; no realpath) ---
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CONVOY_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
CONVOY_BIN="$CONVOY_ROOT/bin/convoy"

pass=0
fail=0
note() { printf '\n=== %s ===\n' "$1"; }
ok()   { printf '  OK   %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf '  FAIL %s\n' "$1"; fail=$((fail + 1)); }

# assert that running convoy doctor/install under a given env prints an expected substring.
# args: <description> <expected-substring> -- <env KEY=VAL ...> -- <convoy args...>
expect_output() {
  desc=$1; needle=$2; shift 2
  [ "$1" = "--" ] && shift
  envs=(); while [ "$1" != "--" ]; do envs+=("$1"); shift; done; shift
  out=$(env "${envs[@]}" node "$CONVOY_BIN" "$@" 2>&1)
  if printf '%s' "$out" | grep -qF "$needle"; then ok "$desc"; else
    bad "$desc — expected to see: $needle"; printf '       got: %s\n' "$(printf '%s' "$out" | tail -3 | tr '\n' '|')"
  fi
}

# A fresh, empty HOME so no credential / git config / ~/.local/bin from THIS machine leaks in.
FRESH_HOME=$(mktemp -d "${TMPDIR:-/tmp}/cleanroom-home-XXXXXX")
FRESH_BIN="$FRESH_HOME/.local/bin"
# A deliberately LONG temp dir to exercise the socket-length check.
LONG_TMP=$(mktemp -d "${TMPDIR:-/tmp}/cleanroom-a-very-long-temp-dir-that-should-overflow-the-socket-budget-XXXXXX")
# A minimal PATH — just enough to find node/git, NONE of this machine's tool dirs.
NODE_DIR=$(dirname -- "$(command -v node)")
GIT_DIR=$(dirname -- "$(command -v git)")
BARE_PATH="$NODE_DIR:$GIT_DIR:/usr/bin:/bin"

cleanup() { rm -rf "$FRESH_HOME" "$LONG_TMP"; }
trap cleanup EXIT

printf 'clean-room: convoy=%s\n  fresh HOME=%s\n  bare PATH=%s\n' "$CONVOY_ROOT" "$FRESH_HOME" "$BARE_PATH"

# 1) install-cli into a fresh env where ~/.local/bin does NOT exist + is NOT on PATH.
note "install-cli in a stripped env (no ~/.local/bin, bare PATH)"
out=$(env -i HOME="$FRESH_HOME" PATH="$BARE_PATH" SHELL=/bin/bash node "$CONVOY_BIN" install-cli --bin "$FRESH_BIN" 2>&1)
printf '%s\n' "$out"
printf '%s' "$out" | grep -qF "st →" && printf '%s' "$out" | grep -qF "pty →" && printf '%s' "$out" | grep -qF "convoy →" \
  && ok "install-cli linked all three tools" || bad "install-cli did not link all three"
printf '%s' "$out" | grep -qF "NOT on your PATH" && ok "install-cli detected the dir is not on PATH + printed a hint" || bad "install-cli missed the not-on-PATH case"
[ -L "$FRESH_BIN/convoy" ] && [ -L "$FRESH_BIN/st" ] && [ -L "$FRESH_BIN/pty" ] && ok "the three symlinks exist in the fresh bin dir" || bad "symlinks missing in the fresh bin dir"

# From here the fresh bin dir is on PATH (as it would be after the user follows the hint).
FRESH_PATH="$FRESH_BIN:$BARE_PATH"

# After install-cli + a PATH-add, the shell resolves all three via the fresh bin dir. (We don't assert the
# INVERSE — "st absent under a bare PATH" — because on a machine where smalltalk/pty were `npm install`ed, their
# bins also live in node's bin dir, so a PATH that keeps node also keeps st/pty. A clone-only machine wouldn't.)
note "after linking + a PATH-add, the shell resolves all three"
if env -i PATH="$FRESH_PATH" sh -c 'command -v st >/dev/null && command -v pty >/dev/null && command -v convoy >/dev/null'; then ok "convoy, st, pty all resolve via the fresh bin dir"; else bad "tools didn't resolve after linking + PATH-add"; fi

# 2) FAILURE INJECTIONS — each preflight check must CATCH its broken condition with the right message.
# (NOTE: the auth probe reads real creds. On macOS, Claude's OAuth lives in the KEYCHAIN — a fresh $HOME does NOT
# strip it — but a fresh $HOME DOES strip Codex (~/.codex), so the signed-out assertion keys on either harness.)
note "failure paths — the preflight must catch each break"
mkdir -p "$FRESH_HOME/empty-claude"
# a long TMPDIR overflows the pty-socket budget
expect_output "long TMPDIR → caught" "TMPDIR is too long" -- HOME="$FRESH_HOME" PATH="$FRESH_PATH" TMPDIR="$LONG_TMP" -- doctor --quick
# An INSTALLED-but-UNUSED signed-out harness is a WARN, not a hard FAIL (the "don't red-fail a valid setup"
# rule): on a fresh network (no codex members) a signed-out codex must NOT block. FRESH_NET pins ST_ROOT/PTY_ROOT
# so we don't inherit this machine's network (which may include codex agents → codex would count as "used").
# (fresh HOME → ~/.codex absent → codex signed-out.) The REQUIRED-harness HARD-fail path can't be forced in a
# clean room — macOS keeps Claude's OAuth in the keychain, so a fresh HOME/config can't sign Claude out — so
# it's covered by the auth unit tests + a live run against a network that actually uses the signed-out harness.
FRESH_NET="$FRESH_HOME/net"
expect_output "unused signed-out codex → WARN, not a hard fail" "installed but not signed in" -- HOME="$FRESH_HOME" PATH="$FRESH_PATH" ST_ROOT="$FRESH_NET" PTY_ROOT="$FRESH_NET/pty" -- doctor --quick
# too-old Node → caught (simulate by asking a check that always runs; Node is real here, so assert the OS line prints)
expect_output "preflight runs the Environment section" "Node" -- HOME="$FRESH_HOME" PATH="$FRESH_PATH" -- doctor --quick

note "clean-room summary"
printf '  %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] && printf '  ✓ the onboarding flow + preflight behave correctly stripped of this machine.\n' \
  || printf '  ✗ see failures above.\n'
exit "$fail"
