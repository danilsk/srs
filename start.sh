#!/bin/sh
# ES modules need http, not file://
# Google OAuth only allows these two ports.
set -e
cd "$(dirname "$0")"
for PORT in 8123 8124; do
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || break
  PORT=
done
if [ -z "$PORT" ]; then
  echo "ports 8123 and 8124 are both busy; free one (OAuth allows only these)" >&2
  exit 1
fi
( sleep 1; open "http://127.0.0.1:$PORT/" ) &
exec python3 -m http.server "$PORT" --bind 127.0.0.1
