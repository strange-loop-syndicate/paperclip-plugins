#!/bin/sh
# Read-only: compare the installed paperclipai version with the latest on npm.
set -u
APP=/Users/claude/work/paperclip/app
NODE_BIN=/Users/claude/work/paperclip/runtime/node-v24.22.0-darwin-arm64/bin
installed=$("$NODE_BIN/node" -p "require('$APP/node_modules/paperclipai/package.json').version")
latest=$("$NODE_BIN/npm" view paperclipai version 2>&1) || { echo "npm view failed: $latest"; exit 2; }
echo "installed: $installed"
echo "latest:    $latest"
if [ "$installed" = "$latest" ]; then
  echo "Up to date."
else
  echo "Update available. Nothing was installed."
fi
