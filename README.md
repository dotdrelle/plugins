# Dotdrelle plugins

Source repositories for the llm-wiki integrations:

- `claude-desktop/` — Claude Desktop MCP connector and plugin.
- `deepseek-harness/` — DeepSeek Harness plugin and per-workspace MCP bridge.

Each plugin keeps its own package metadata and release workflow. Their Git histories are retained in this repository.

For DeepSeek Harness installation, including dependency setup for a local clone,
the Git URL for the package in its subdirectory, and the required per-workspace
loader, see [`deepseek-harness/README.md`](deepseek-harness/README.md). A
one-command Ubuntu installer is available as [`install-deepseek.sh`](install-deepseek.sh).
