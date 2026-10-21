#!/bin/sh
set -eu

plugin_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
connector="$plugin_dir/bin/llm-wiki-connect.mjs"

if [ -n "${WIKI_WORKSPACE_NAME:-}" ]; then
  exec node "$connector" mcp --workspace "$WIKI_WORKSPACE_NAME"
fi

exec node "$connector" mcp
