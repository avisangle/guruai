#!/bin/sh
# Rebuilds shekru.anim.json and filmstrips.png. usage: tools/strips.sh [tmpDir]
set -e
cd "$(dirname "$0")/.."
TMP="${1:-/tmp/shekru-frames}"
rm -rf "$TMP"; mkdir -p "$TMP"
/usr/local/bin/node tools/build-anim.mjs
/usr/local/bin/node tools/filmstrips.mjs "$TMP/frames" 12 "${2:-all}"
. /Users/avinashsangle/AI/Personal/guru/venv/bin/activate
python tools/filmstrips.py "$TMP/frames" "${3:-filmstrips.png}" 256 --rows-dir "$TMP/rows"
