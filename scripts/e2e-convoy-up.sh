#!/usr/bin/env bash
# e2e-convoy-up.sh — broad, binary-driven acceptance test for `convoy up` (the foreground host).
#
# LANGUAGE-AGNOSTIC GUARDRAIL. It drives the `convoy` BINARY only (never source), so the same script
# validates the Swift build today and the TypeScript port tomorrow. Point it at either:
#
#   CONVOY_BIN=/path/to/convoy scripts/e2e-convoy-up.sh
#   scripts/e2e-convoy-up.sh /path/to/convoy         # or pass the binary as $1
#   scripts/e2e-convoy-up.sh                          # defaults to `convoy` on PATH
#
# It builds an ISOLATED throwaway network under /tmp with lightweight dummy sessions (sleep/crasher —
# near-zero CPU, non-saturating), exercises the seven reboot-critical scenarios, and tears down clean.
# Exits non-zero on any failure. Requires `pty` on PATH + python3.
set -uo pipefail

CONVOY="${CONVOY_BIN:-${1:-convoy}}"
command -v "$CONVOY" >/dev/null 2>&1 || CONVOY="$(command -v convoy || true)"
[ -n "$CONVOY" ] || { echo "no convoy binary (set CONVOY_BIN or pass a path)"; exit 2; }
command -v pty >/dev/null 2>&1 || { echo "pty not on PATH"; exit 2; }

ROOT=/tmp/convoy-e2e-guardrail
export PTY_ROOT="$ROOT/pty"
PASS=0; FAIL=0
ok(){ echo "  PASS: $1"; PASS=$((PASS+1)); }
no(){ echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

sid(){ pty list --json 2>/dev/null | python3 -c "import sys,json;xs=[s for s in json.load(sys.stdin) if s['tags'].get('ptyfile.session')=='$1'];print(xs[-1]['name'] if xs else '')"; }
st(){ pty list --json 2>/dev/null | python3 -c "import sys,json;print(next((s['status'] for s in json.load(sys.stdin) if s['name']=='$1'),'gone'))"; }
nperm(){ pty list --json 2>/dev/null | python3 -c "import sys,json;print(sum(1 for s in json.load(sys.stdin) if s['tags'].get('strategy')=='permanent'))"; }
nrun(){ pty list --json 2>/dev/null | python3 -c "import sys,json;print(sum(1 for s in json.load(sys.stdin) if s['status']=='running'))"; }
ev(){ python3 -c "import json,sys;print(sum(1 for l in open('$1') if l.strip() and json.loads(l).get('type')=='$2'))" 2>/dev/null; }

cleanup(){ pkill -f "convoy up $ROOT" 2>/dev/null
  [ -d "$PTY_ROOT" ] && for n in $(pty list --json 2>/dev/null | python3 -c "import sys,json;[print(s['name']) for s in json.load(sys.stdin)]" 2>/dev/null); do pty kill "$n" >/dev/null 2>&1; done
  rm -rf "$ROOT"; }
trap cleanup EXIT
cleanup; sleep 1; mkdir -p "$ROOT"

echo "== e2e-convoy-up: $CONVOY =="

# ---- A: multi-agent bring-up (cos + 3 workers + 1 crasher = 5 permanent) ----
# Sessions are created with `pty run -d` (detached), tagged as a real agent would be by st launch —
# strategy=permanent + the ptyfile/ptyfile.session pair convoy keys on. (`pty up` was removed from pty
# in the §3.4-B cutover; `pty run` is the create primitive. convoy up reconciles via `pty restart`.)
echo "== A: multi-agent bring-up =="
mkrun(){ # mkrun <name> <cmd...>
  local a="$1"; shift; local d="$ROOT/agents/$a"; mkdir -p "$d"
  pty run -d --cwd "$d" --name "$a" \
    --tag role=worker --tag strategy=permanent \
    --tag "ptyfile=$d/pty.toml" --tag "ptyfile.session=$a" \
    -- "$@" >/dev/null 2>&1
}
for a in cos wk1 wk2 wk3; do mkrun "$a" sleep 100000; done
mkrun crasher sh -c 'exit 1'
sleep 2
[ "$(nperm)" = "5" ] && ok "5 permanent sessions registered (multi-agent)" || no "expected 5 permanent, got $(nperm)"

"$CONVOY" up "$ROOT" --reconcile-interval 2 --fast-fail-window 60 --json >"$ROOT/host.json" 2>"$ROOT/host.err" &
HOST=$!
sleep 3
[ -f "$ROOT/convoy.pid" ] && ok "convoy.pid written" || no "convoy.pid missing"
COS=$(sid cos)
[ "$(st "$COS")" = "running" ] && ok "cos session hosted + running" || no "cos not running"

# ---- B: session-crash recovery ----
echo "== B: session-crash recovery =="
pty kill "$(sid wk1)" >/dev/null 2>&1; sleep 9
[ "$(st "$(sid wk1)")" = "running" ] && ok "wk1 respawned after kill" || no "wk1 not recovered"

# ---- C: cos-self-host (the host, not cos, respawns cos) ----
echo "== C: cos-self-host =="
pty kill "$COS" >/dev/null 2>&1; sleep 9
[ "$(st "$(sid cos)")" = "running" ] && ok "cos respawned by the host (no self-relaunch)" || no "cos not recovered"

# ---- D: flapping-cap (crasher climbs → flaps → parks) ----
echo "== D: flapping-cap =="
sleep 12
[ "$(ev "$ROOT/host.json" session_flapping)" -ge 1 ] && ok "crasher hit the flapping-cap" || no "no flap event"
[ "$(pty tag "$(sid crasher)" 2>/dev/null | grep -c 'strategy.status=flapping')" = "1" ] && ok "strategy.status=flapping written to pty" || no "flapping tag not on pty"
B=$(ev "$ROOT/host.json" respawn); sleep 6
[ "$B" = "$(ev "$ROOT/host.json" respawn)" ] && ok "parked: no further respawns after flap" || no "still respawning after flap"

# ---- E: §5.5 manual reset ----
echo "== E: manual reset (§5.5) =="
pty tag "$(sid crasher)" --rm strategy.status >/dev/null 2>&1; sleep 6
[ "$(ev "$ROOT/host.json" reset)" -ge 1 ] && ok "manual --rm strategy.status → reset+retry" || no "no reset event"

# ---- F: host-crash + stale-pid takeover ----
echo "== F: host-crash + stale-pid takeover =="
kill -9 $HOST 2>/dev/null; wait $HOST 2>/dev/null; sleep 1
[ -n "$(cat "$ROOT/convoy.pid" 2>/dev/null)" ] && ok "host crash left a stale pid" || no "no stale pid"
[ "$(st "$(sid wk2)")" = "running" ] && ok "hosted sessions survived the host crash" || no "wk2 died with host"
"$CONVOY" up "$ROOT" --reconcile-interval 2 --json >"$ROOT/host2.json" 2>"$ROOT/host2.err" &
HOST2=$!; sleep 3
python3 -c "import json,sys;sys.exit(0 if any(json.loads(l).get('type')=='up' for l in open('$ROOT/host2.json') if l.strip()) else 1)" 2>/dev/null \
  && ok "new host took over the stale pid" || no "new host failed to take over: $(head -1 "$ROOT/host2.err")"

# ---- G: teardown / rollback (zero RUNNING orphans) ----
echo "== G: teardown / rollback =="
kill -INT $HOST2 2>/dev/null; wait $HOST2 2>/dev/null; sleep 2
[ "$(nrun)" = "0" ] && ok "teardown zero-orphan (0 running sessions)" || no "$(nrun) running orphan(s)"
[ ! -f "$ROOT/convoy.pid" ] && ok "convoy.pid removed on teardown" || no "convoy.pid left behind"

echo
echo "==== RESULT: $PASS passed, $FAIL failed ($CONVOY) ===="
[ "$FAIL" = "0" ]
