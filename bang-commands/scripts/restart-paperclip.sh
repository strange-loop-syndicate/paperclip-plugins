#!/bin/sh
# Restart the lab Paperclip server so that exactly one server runs, on :3100.
# Usage: restart-paperclip.sh [--dry-run]   (--dry-run lists what it would stop)
# The plugin starts it detached, so it survives the server stopping.
# Log: $ROOT/restart-paperclip.log for every run, plus stdout.
# Exit 0 only when one server runs and it is the :3100 listener.
# RESTART_PC_* variables are for tests/restart-script.spec.ts only.
set -u

ROOT=${RESTART_PC_ROOT:-/Users/claude/work/paperclip}
NODE=${RESTART_PC_NODE:-$ROOT/runtime/node-v24.22.0-darwin-arm64/bin/node}
PORT=${RESTART_PC_PORT:-3100}
DELAY=${RESTART_PC_DELAY:-5}
STOP_WAIT=${RESTART_PC_STOP_WAIT:-30}
HEALTH_WAIT=${RESTART_PC_HEALTH_WAIT:-120}
ENTRY=$ROOT/app/node_modules/paperclipai/dist/index.js
SERVER_LOG=$ROOT/server-detached.log
RESTART_LOG=$ROOT/restart-paperclip.log
HEALTH=http://127.0.0.1:$PORT/api/health

DRY_RUN=0
case "${1:-}" in
  "") ;;
  --dry-run) DRY_RUN=1 ;;
  *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
esac

log() { printf '[%s] %s\n' "$(date '+%F %T %z')" "$*" | tee -a "$RESTART_LOG"; }
fail() { log "result: FAILED: $*"; exit 1; }
# Joins its arguments (or the lines of an unquoted $(...)) with single spaces.
words() { echo $*; }

# pgrep takes an extended regex; escape the path's special characters.
ENTRY_RE=$(printf '%s' "$ENTRY" | sed 's/[.[\*^$+?(){}|]/\\&/g')

# Every running server: a node process whose arguments contain "$ENTRY run".
# -a: macOS pgrep skips its own ancestors by default, and this script runs
# below the server it restarts (server → plugin worker → here). See SLS-140.
servers() {
  pgrep -a -f "$ENTRY_RE run" 2>/dev/null | while read -r pid _; do
    comm=$(ps -o comm= -p "$pid" 2>/dev/null) || continue
    [ "${comm##*/}" = node ] || continue
    case " $(ps -o args= -p "$pid" 2>/dev/null) " in
      *" $ENTRY run "*) echo "$pid" ;;
    esac
  done
}

# PIDs listening on the server port, whatever they are.
listeners() { lsof -nP -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null; }

# The given PIDs that still run. ps, not kill -0, which fails on another
# user's process; zombies count as gone.
alive() {
  for p in "$@"; do
    st=$(ps -o stat= -p "$p" 2>/dev/null) || continue
    case "$st" in Z*) ;; *) echo "$p" ;; esac
  done
}

# This script's ancestor PIDs.
ancestors() {
  p=$$
  while p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ') && [ -n "$p" ] && [ "$p" -gt 1 ]; do
    echo "$p"
  done
}

if [ "$DRY_RUN" = 1 ]; then
  anc=" $(words $(ancestors)) "
  found=$(servers)
  log "dry run: nothing is stopped or started"
  [ -n "$found" ] || log "dry run: no running server found"
  for pid in $found; do
    case "$anc" in *" $pid "*) rel="ancestor of this script" ;; *) rel="not an ancestor" ;; esac
    log "dry run: would stop server pid $pid ($rel)"
  done
  log "dry run: :$PORT listener pid(s): [$(words $(listeners))]"
  exit 0
fi

log "restart requested; waiting $DELAY s so the reply comment lands"
sleep "$DELAY"

old=$(servers)
if [ -z "$old" ]; then
  log "no running server found"
else
  log "stopping server pid(s): $(words $old)"
  for pid in $old; do kill -TERM "$pid" || log "SIGTERM to pid $pid failed"; done
  i=0
  while [ -n "$(alive $old)" ] && [ $i -lt "$STOP_WAIT" ]; do sleep 1; i=$((i+1)); done
  left=$(alive $old)
  if [ -n "$left" ]; then
    log "still running after $STOP_WAIT s, sending SIGKILL to: $(words $left)"
    for pid in $left; do kill -KILL "$pid" || log "SIGKILL to pid $pid failed"; done
    sleep 2
  fi
fi

log "re-applying local patches"
out=$("$NODE" "$ROOT/patches/apply-all.mjs" 2>&1); rc=$?
printf '%s\n' "$out" | tee -a "$RESTART_LOG"
[ $rc -eq 0 ] || log "patch script exited $rc"

# Never start a second server: Paperclip quietly takes the next free port,
# and a health check on :$PORT would then pass against the old one.
left=$(servers)
busy=$(listeners)
if [ -n "$left" ] || [ -n "$busy" ]; then
  fail "not starting a server: server pid(s) still running: [$(words $left)], :$PORT listener pid(s): [$(words $busy)]"
fi

log "starting server"
cd "$ROOT" || fail "cannot cd to $ROOT"
HOME=/Users/claude PAPERCLIP_HOME=$ROOT/state/paperclip PAPERCLIP_INSTANCE_ID=lab PAPERCLIP_TELEMETRY_DISABLED=1 \
  /usr/bin/perl -MPOSIX -e 'POSIX::setsid(); $SIG{HUP} = "IGNORE"; exec @ARGV or die "exec: $!"' -- \
  "$NODE" "$ENTRY" run >>"$SERVER_LOG" 2>&1 </dev/null &
# Not nohup: macOS nohup exits with "can't detach from console" in a terminal, before node runs.
# perl execs node, so $! is the server's own PID.
new=$!
log "new server pid $new"

# Pass only when the new server is the only server and owns :$PORT. A health
# 200 alone is not enough: it may come from a server this script did not start.
start=$(date +%s)
while :; do
  [ -n "$(alive "$new")" ] || fail "new server pid $new exited; see $SERVER_LOG"
  others=$(words $(servers | grep -vx "$new"))
  if [ -n "$others" ]; then
    kill -TERM "$new"
    fail "another server is running: [$others]; stopped the new server $new"
  fi
  lis=$(words $(listeners))
  if [ -n "$lis" ] && [ "$lis" != "$new" ]; then
    kill -TERM "$new"
    fail ":$PORT listener is [$lis], not the new server $new; stopped the new server"
  fi
  if [ "$lis" = "$new" ] && /usr/bin/curl -sf -m 3 "$HEALTH" >/dev/null; then
    break
  fi
  [ $(( $(date +%s) - start )) -ge "$HEALTH_WAIT" ] && fail "server not healthy on :$PORT after $HEALTH_WAIT s"
  sleep 1
done
log "result: ok: one server, pid $new, listening on :$PORT, healthy"
