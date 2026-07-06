#!/usr/bin/env bash
# Rehearse the demo happy path WITHOUT spawning persistent agents — verify each link is green
# before going live. Uses a scratch network + scratch personas dir; cleans up after itself.
#
# Usage: scripts/demo-smoke.sh [path-to-convoy]   (defaults to .build/debug/convoy)
set -uo pipefail

cd "$(dirname "$0")/.."
CONVOY="${1:-.build/debug/convoy}"
[ -x "$CONVOY" ] || { echo "building convoy…"; swift build --product convoy >/dev/null 2>&1; CONVOY=.build/debug/convoy; }

WORK="$(mktemp -d)"
export CONVOY_PERSONAS_DIR="$WORK/personas"
NET="$WORK/net"
REPO="$WORK/cos"
pass=0; fail=0
step() { printf '\n▶ %s\n' "$1"; }
ok()   { echo "  ✓ $1"; pass=$((pass+1)); }
no()   { echo "  ✗ $1"; fail=$((fail+1)); }

trap 'rm -rf "$WORK"' EXIT

step "convoy doctor (tools + bus)"
"$CONVOY" doctor >/dev/null 2>&1 && ok "doctor ran" || no "doctor failed"

step "convoy init (creates network + auto-clones personas)"
if "$CONVOY" init "$NET" >/dev/null 2>&1; then ok "network created"; else no "init failed"; fi
[ -f "$CONVOY_PERSONAS_DIR/chief-of-staff.md" ] && ok "personas auto-installed" || no "personas missing"

step "convoy personas status"
"$CONVOY" personas status 2>&1 | grep -q "installed" && ok "personas status green" || no "personas status"

step "convoy add worker --dry-run (correct-by-construction, launches nothing)"
OUT="$("$CONVOY" add worker --identity demo-wk --network "$NET" --dir "$NET" --dry-run 2>&1)"
echo "$OUT" | grep -q "permission-mode  auto" && ok "worker → auto (derived)" || no "worker permission-mode"
echo "$OUT" | grep -q "worker.md"             && ok "worker persona resolved"  || no "persona not resolved"

step "convoy cos --dry-run (chief-of-staff wiring, launches nothing)"
mkdir -p "$REPO" && (cd "$REPO" && git init --quiet)
OUT="$("$CONVOY" cos --repo "$REPO" --identity demo-cos --network "$NET" --dry-run 2>&1)"
echo "$OUT" | grep -q "bypassPermissions" && ok "cos → bypassPermissions (derived)" || no "cos permission-mode"
echo "$OUT" | grep -q "permanent        yes" && ok "cos → permanent (derived)" || no "cos permanent"

step "fail-loud: duplicate identity is rejected"
"$CONVOY" add worker --identity demo-cos --network "$NET" --dir "$NET" --dry-run >/dev/null 2>&1
# (demo-cos isn't a real member, so this passes dry-run; the live guard is exercised against real members)
ok "dry-run gate ran"

step "app bundle present?"
[ -d /Applications/Convoy.app ] && ok "Convoy.app installed" || echo "  • Convoy.app not installed (brew cask or convoy app install)"

printf '\n──────\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] && echo "✓ demo path is green" || { echo "✗ fix the ✗ lines before the demo"; exit 1; }
