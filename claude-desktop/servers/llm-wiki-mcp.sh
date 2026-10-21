#!/bin/sh
set -eu

manager_home="${WIKI_MANAGER_STATE_DIR:?WIKI_MANAGER_STATE_DIR is required}"
engine_home="${LLM_WIKI_ENGINE_HOME:?LLM_WIKI_ENGINE_HOME is required}"
entrypoint="$engine_home/dist/bin/wiki.js"

if [ ! -f "$entrypoint" ]; then
  echo "llm-wiki: wiki.js not found: $entrypoint" >&2
  exit 1
fi

plugin_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
export WIKI_MANAGER_STATE_DIR="$manager_home"
export LLM_WIKI_ENGINE_HOME="$engine_home"
exec node "$plugin_dir/bin/llm-wiki-connect.mjs" multi-mcp
