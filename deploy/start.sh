#!/bin/sh
set -eu
umask 077
: "${REDPILOT_PUBLIC_URL:?请配置 REDPILOT_PUBLIC_URL}"
mkdir -p "$REDPILOT_DATA_DIR"
if [ "${REDPILOT_REMOTE_DESKTOP:-false}" = "true" ] && [ ! -f "$REDPILOT_DATA_DIR/remote-desktop.password" ]; then
  echo '请先配置远程桌面密码文件'
  exit 1
fi
Xvfb "$DISPLAY" -screen 0 1440x1000x24 -nolisten tcp &
xvfb_pid=$!
display_number=${DISPLAY#:}
display_number=${display_number%%.*}
attempt=0
while [ ! -S "/tmp/.X11-unix/X$display_number" ]; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 50 ] || { kill -TERM "$xvfb_pid"; exit 1; }
  sleep 0.1
done
node --env-file-if-exists="$REDPILOT_DATA_DIR/.env" app/deployment-reader.mjs &
reader_pid=$!
vnc_pid=""
web_pid=""
if [ "${REDPILOT_REMOTE_DESKTOP:-false}" = "true" ]; then
  x11vnc -display "$DISPLAY" -localhost -rfbauth "$REDPILOT_DATA_DIR/remote-desktop.password" -forever -shared -rfbport 5900 -quiet &
  vnc_pid=$!
  websockify --web=/usr/share/novnc 6080 127.0.0.1:5900 >/dev/null 2>&1 &
  web_pid=$!
fi
if ! node -e 'let ready=false; for(let attempt=0;attempt<60;attempt++){try{ready=(await fetch("http://127.0.0.1:3456/health")).ok;}catch{} if(ready)break;await new Promise(resolve=>setTimeout(resolve,500));}process.exit(ready?0:1)' --input-type=module; then
  kill -TERM "$reader_pid" "$xvfb_pid" 2>/dev/null || true
  [ -z "$web_pid" ] || kill -TERM "$web_pid" 2>/dev/null || true
  [ -z "$vnc_pid" ] || kill -TERM "$vnc_pid" 2>/dev/null || true
  echo '浏览器读取服务未启动'
  exit 1
fi
node --env-file-if-exists="$REDPILOT_DATA_DIR/.env" app/server.mjs &
app_pid=$!
# A lost browser must restart the service instead of leaving unattended jobs stranded.
(
  failures=0
  while kill -0 "$app_pid" 2>/dev/null; do
    sleep 30
    if kill -0 "$reader_pid" 2>/dev/null && kill -0 "$xvfb_pid" 2>/dev/null && node -e 'fetch("http://127.0.0.1:3456/health",{signal:AbortSignal.timeout(3000)}).then(response=>process.exit(response.ok?0:1)).catch(()=>process.exit(1))'; then
      failures=0
    else
      failures=$((failures + 1))
      if [ "$failures" -ge 3 ]; then
        echo '浏览器读取服务中断，正在重启'
        kill -TERM "$app_pid" 2>/dev/null || true
        break
      fi
    fi
  done
) &
watchdog_pid=$!
shutdown() {
  kill -TERM "$watchdog_pid" 2>/dev/null || true
  kill -TERM "$app_pid" 2>/dev/null || true
  wait "$app_pid" 2>/dev/null || true
  kill -TERM "$reader_pid" 2>/dev/null || true
  wait "$reader_pid" 2>/dev/null || true
  [ -z "$web_pid" ] || kill -TERM "$web_pid" 2>/dev/null || true
  [ -z "$vnc_pid" ] || kill -TERM "$vnc_pid" 2>/dev/null || true
  kill -TERM "$xvfb_pid" 2>/dev/null || true
}
trap shutdown INT TERM
set +e
wait "$app_pid"
status=$?
kill -TERM "$watchdog_pid" 2>/dev/null || true
kill -TERM "$reader_pid" 2>/dev/null || true
[ -z "$web_pid" ] || kill -TERM "$web_pid" 2>/dev/null || true
[ -z "$vnc_pid" ] || kill -TERM "$vnc_pid" 2>/dev/null || true
kill -TERM "$xvfb_pid" 2>/dev/null || true
exit "$status"
