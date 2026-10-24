#!/bin/sh
# Restart the lab Paperclip server. Started detached by the plugin, so it
# survives the server (and the plugin worker) stopping. Log: detached-restart-paperclip.log
set -u
PAPERCLIP_ROOT=/Users/claude/work/paperclip
NODE=$PAPERCLIP_ROOT/runtime/node-v24.22.0-darwin-arm64/bin/node
ENTRY=$PAPERCLIP_ROOT/app/node_modules/paperclipai/dist/index.js
LOG=$PAPERCLIP_ROOT/server-detached.log
HEALTH=http://127.0.0.1:3100/api/health

echo "[$(date '+%F %T')] restart requested; waiting 5 s so the reply comment lands"
sleep 5

PID=$(pgrep -f "$ENTRY run" | head -1)
if [ -n "$PID" ]; then
  echo "stopping server pid $PID"
  kill -TERM "$PID"
  i=0
  while kill -0 "$PID" 2>/dev/null && [ $i -lt 30 ]; do sleep 1; i=$((i+1)); done
  if kill -0 "$PID" 2>/dev/null; then echo "still running after 30 s, sending SIGKILL"; kill -KILL "$PID"; sleep 2; fi
else
  echo "no running server found"
fi

echo "re-applying local patches"
"$NODE" $PAPERCLIP_ROOT/patches/apply-all.mjs

echo "starting server"
cd "$PAPERCLIP_ROOT" || exit 1
HOME=/Users/claude PAPERCLIP_HOME=$PAPERCLIP_ROOT/state/paperclip PAPERCLIP_INSTANCE_ID=lab PAPERCLIP_TELEMETRY_DISABLED=1 \
  /usr/bin/perl -MPOSIX -e 'POSIX::setsid(); $SIG{HUP} = "IGNORE"; exec @ARGV or die "exec: $!"' -- \
  "$NODE" "$ENTRY" run >>"$LOG" 2>&1 </dev/null &
# Not nohup: macOS nohup exits with "can't detach from console" in a terminal, before node runs.
echo "new server pid $!"

i=0
until /usr/bin/curl -sf -m 3 "$HEALTH" >/dev/null; do
  i=$((i+1)); [ $i -ge 60 ] && { echo "server not healthy after 120 s"; exit 1; }
  sleep 2
done
echo "[$(date '+%F %T')] server healthy"
