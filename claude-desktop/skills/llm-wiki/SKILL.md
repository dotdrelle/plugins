---
name: llm-wiki
description: Use the connected llm-wiki MCP server to search, read, cite, traverse, and explicitly update a local Markdown knowledge base.
---

# llm-wiki workflow

The Claude extension discovers all registered workspaces and maintains one
active workspace for the session. If several are available, call
`wiki_workspace_list`, ask the user which one to use when necessary, then call
`wiki_workspace_select`. Once selected, use the standard `wiki_search_context`,
`wiki_collect_context`, `wiki_read_page`, and other `wiki_*` tools. Keep the
active workspace in mind and call `wiki_workspace_current` if it is unclear.
For synthesis, comparison, architecture, or audit work, prefer
`wiki_collect_context`, then use the returned `readPagePaths` and `readPages`
as the evidence base.

All workspace knowledge reads must use the MCP tools. After a search returns a
path, read it with `wiki_read_page` or `wiki_read_pages`; read archived material
with `wiki_read_ingested_source` when the path is under `raw/ingested/`. Use
`wiki_read_page` for `raw/untracked/` as well. Never ask Claude to add the
workspace folder, use computer file access, or read the path directly merely
because a search result names it. Direct filesystem access is outside this
workflow and would bypass the selected-workspace boundary.

For relationship questions, use `wiki_graph_query` or `wiki_graph_path` before
reading the relevant pages. Preserve source citations
such as `[src: ...]` in the answer and state when raw archived sources were not
opened in full.

Treat `wiki_write_page`, `wiki_add_source`, `template_write`, and
`profile_update` as mutating operations. Only call them when the user clearly
asked for the corresponding change; otherwise report the proposed change.

## Execute a workspace skill

When the user explicitly asks to run a skill, preserve its exact name and
delegate through `wiki-manager` headless mode. The workspace is resolved from
the wiki-manager registry, independently of MCP extensions. In a
Claude Desktop session, select the workspace with `wiki_workspace_select`, then
use `wiki_skill_list` when the exact name is not already known, then call
`wiki_skill_run` with the exact skill name. This runs on the Mac through
the local extension; do not try to execute the bundled Python script in a
cloud/VM shell.

Ingestion is a native pipeline operation, not automatically a skill. When the
user asks to ingest pending sources, call `wiki_ingest` after selecting the
workspace. Only call `wiki_skill_run` with `ingest` if `wiki_skill_list`
actually returns a workspace skill with that exact name.

Native workspace commands are not skills. If the user writes or asks for
`/wiki doctor`, `/wiki run ...`, `/wiki build`, or `/wiki export`, select the
workspace and call `wiki_command_run` with the exact command and arguments.
Do not look for `doctor` or `run` in `wiki_skill_list`. For example, `/wiki run
<args>` becomes `wiki_command_run({ command: "run", args: ["<args>"] })`.

In a local-execution session (Cowork or Claude Code), the Python fallback is:

```bash
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/run-wiki-skill.py \
  --skill "<exact-skill-name>"
```

If the result has `status: workspace_required`, ask the user to choose one of
the returned `workspaces`, then run again with its exact name:

```bash
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/run-wiki-skill.py \
  --workspace "<workspace-name>" \
  --skill "<exact-skill-name>"
```

If only one workspace is registered, it is selected automatically. The manager
state folder may be supplied with `--manager-home`; the script also discovers
the development manager next to `LLM_WIKI_ENGINE_HOME` and the Bun installation
in `~/.bun/bin`. Do not translate a skill name into a guessed CLI command, and
do not run a skill unless the user explicitly requests it.

The script returns JSON containing the workspace, exact skill name, status,
exit code, output and error.

The MCP extension uses the manager registry and keeps the selected workspace in
session memory. Set `LLM_WIKI_ENTRYPOINT` only if the built `wiki.js` entrypoint
is not at the default engine path.
