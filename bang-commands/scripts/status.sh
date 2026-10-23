#!/bin/sh
# Read-only: Paperclip health plus local patch state.
set -u
NODE=/Users/claude/work/paperclip/runtime/node-v24.22.0-darwin-arm64/bin/node
/usr/bin/curl -sS -m 10 http://127.0.0.1:3100/api/health; rc=$?
echo
"$NODE" /Users/claude/work/paperclip/patches/apply-all.mjs --check
exit $rc
