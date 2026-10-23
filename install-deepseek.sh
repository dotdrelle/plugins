#!/usr/bin/env bash
set -euo pipefail

profile="desktop"
dsh_bin="$(command -v dsh || true)"
node_bin="${LLM_WIKI_NODE:-node}"

if [[ -z "$dsh_bin" ]]; then
  echo "DeepSeek Harness CLI (dsh) is not in PATH. Install/open Harness first, then run this script again." >&2
  exit 1
fi

if ! command -v "$node_bin" >/dev/null 2>&1; then
  echo "Node.js 24 or newer is required. Set LLM_WIKI_NODE to its executable path." >&2
  exit 1
fi

node_version="$("$node_bin" --version)"
if [[ "$node_version" =~ ^v?([0-9]+) ]] && (( BASH_REMATCH[1] < 24 )); then
  echo "Node.js 24 or newer is required by the per-workspace MCP loader; found $node_version." >&2
  exit 1
fi

if [[ "$profile" == "desktop" ]]; then
  echo "Use the desktop profile: open Harness Desktop once to initialize it, then fully quit it before continuing."
  read -r -p "Press Enter when Harness Desktop is closed... " _
fi

dsh_home="${DSH_HOME:-$HOME/.dsh}"
mkdir -p "$dsh_home"
chmod 700 "$dsh_home"

echo "Installing llm-wiki for Harness profile '$profile'..."
"$dsh_bin" plugin --profile "$profile" add \
  'git+https://github.com/dotdrelle/plugins.git#main&path:/deepseek-harness'

echo "Installing the per-workspace MCP loader in the same profile..."
"$dsh_bin" plugin --profile "$profile" add \
  'github:Momojie-S/dsh-workspace-mcp'

workspace_helper="$dsh_home/profiles/$profile/node_modules/@dotdrelle/dsh-llm-wiki/workspace.mjs"
if [[ ! -f "$workspace_helper" ]]; then
  echo "Could not find the installed workspace helper at: $workspace_helper" >&2
  echo "Check DSH_HOME and the profile name, then rerun this script." >&2
  exit 1
fi

echo "Creating a local Harness workspace connected to the remote wiki..."
LLM_WIKI_DSH_PROFILE="$profile" "$node_bin" "$workspace_helper" setup

echo
echo "Add the printed folder once in Harness Desktop with Add workspace."
