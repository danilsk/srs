#!/bin/sh
# ES modules need http, not file://
set -e
cd "$(dirname "$0")"
PORT=${1:-8123}
( sleep 1; open "http://127.0.0.1:$PORT/" ) &
exec python3 -m http.server "$PORT" --bind 127.0.0.1
