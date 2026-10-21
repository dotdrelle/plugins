# llm-wiki Desktop for Claude

This package connects Claude Desktop to local `llm-wiki` workspaces over MCP.
It relies on the `llm-wiki` engine (`dist/bin/wiki.js`) and on the
`wiki-manager` registry to find the workspaces. It needs neither the ShellUI
nor `serve`.

It produces two complementary Claude files:

- `dist/llm-wiki-claude.mcpb`: the local MCP extension (`wiki_*` tools);
- `dist/llm-wiki.plugin`: the `llm-wiki` Claude skill and its instructions.

A single extension gives access to **all** the workspaces of the registry:
there is no package per workspace.

## Requirements

- **Node.js 22 or newer** in the `PATH` seen by Claude Desktop (the engine
  requires it).
- A built `llm-wiki` engine: `pnpm build` in `llm-wiki/` for a development
  checkout.
- A `wiki-manager` state directory containing `workspaces/`, with initialized
  workspaces (`wiki init`).

## Build

```bash
node scripts/build-mcpb.mjs
node scripts/build-claude-plugin.mjs
```

The three version numbers — `CONNECTOR_VERSION` in
`bin/llm-wiki-connect.mjs`, `mcpb/manifest.json` and
`claude-plugin/.claude-plugin/plugin.json` — must be identical; both scripts
refuse to build otherwise. To check them alone:

```bash
node scripts/check-versions.mjs
```

`dist/` is not versioned: after any change to `bin/llm-wiki-connect.mjs`,
rebuild **and** reinstall the extension (see "Update").

The workspace release script (`build-and-push.sh`) aligns these three numbers
on the coordinated version (`SYNC_VERSIONS_ONLY=1`) and then rebuilds `dist/`;
`scripts/check-versions.mjs` remains the local check, and the manager's
`check-versions` verifies them when the repository is present.

## Install

### MCP extension

`Claude Desktop → Settings → Extensions → Install Extension`, then choose
`dist/llm-wiki-claude.mcpb`. Two fields are requested:

- **wiki-manager state directory**: the folder that contains `workspaces/`
  (and the manager `.env`). Choose a **permanent** folder: a folder under
  `/tmp` is emptied when the Mac restarts, and the extension would then start
  with no workspace at all.
- **wiki-workspace installation directory**: the `llm-wiki` folder that
  contains `dist/bin/wiki.js` — not the `wiki.js` file, not `dist/bin`.

```text
# development checkout
/path/to/wikiLLM/llm-wiki

# local npm dependency
/path/to/project/node_modules/llm-wiki

# global npm package (resolve the path in a terminal)
$(npm root -g)/llm-wiki
```

```bash
test -f "$(npm root -g)/llm-wiki/dist/bin/wiki.js" && echo "wiki.js found"
```

Claude's folder picker wants the resolved absolute path, not `$(...)`.

### Claude skill

`Claude Desktop → Settings → Plugins → Import plugin`, then choose
`dist/llm-wiki.plugin`. The plugin contains only the `llm-wiki` skill and the
`run-wiki-skill.py` script; it starts no MCP server.

## Update

1. `git pull` in this repository, then rebuild both files.
2. Reinstall `dist/llm-wiki-claude.mcpb` (same install path) and re-import
   `dist/llm-wiki.plugin` if `skills/` changed.
3. Disable and re-enable the extension, or restart Claude Desktop.

To check that the installed version is the one from the source:

```bash
diff -q "$HOME/Library/Application Support/Claude/Claude Extensions/local.mcpb.dotdrelle.llm-wiki-claude/bin/llm-wiki-connect.mjs" \
  bin/llm-wiki-connect.mjs && echo "extension up to date"
```

The version is also returned by the server (`serverInfo.version`) at MCP
initialization.

## Multi-workspace behaviour

At startup, the extension reads the `wiki-manager` registry and starts **one
`wiki.js mcp` engine process per initialized workspace**. An uninitialized
workspace is skipped and reported in the extension log; it does not block the
others.

- `wiki_workspace_list` lists the workspaces, `wiki_workspace_select` picks the
  active workspace, `wiki_workspace_current` reports it back.
- All the other `wiki_*` tools (search, read, graph, provenance, write, help…)
  are routed to the **active workspace**. Without a selection they are refused
  with a hint; if there is only one workspace, it is selected automatically.
- Each workspace's MCP token is read from its `.env`; the model never picks a
  path from the request text.

Current limits, worth knowing:

- **One active workspace, shared.** The selection lives in the extension
  process, which Claude Desktop normally shares across conversations: changing
  workspace in one conversation changes it for the others. Re-check with
  `wiki_workspace_current` when in doubt.
- **No query across several workspaces at once.** To compare two workspaces,
  select them one after the other; avoid parallel calls right after a selection
  change.
- **Registry read at startup only.** A new workspace, or one initialized
  afterwards, appears only after restarting the extension.
- **One engine process per workspace** stays in memory for the whole session,
  used or not.
- **One tracked ingestion at a time**: `wiki_ingest_stop` stops the last one
  started.
- **Writes do not go through Donna.** `wiki_write_page`, `wiki_add_source`,
  `template_write` and `profile_update` write directly; only the engine locks
  refuse them during a production job (`PRODUCTION_JOB_ACTIVE`).

## Skills, ingestion and native commands

- `wiki_skill_list` / `wiki_skill_run` list then run a skill of the active
  workspace (`.wiki/skills/*.md`) through `wiki-manager --headless --skill`.
  This mode approves nothing automatically: a skill that modifies the workspace
  stops waiting for approval, to be given in the ShellUI or in `serve`.
- `wiki_ingest` runs the native ingestion (`wiki-workspace wiki <ws> ingest`);
  it is not a skill. Progress is relayed to Claude.
- `wiki_command_run` runs `doctor`, `run`, `build` or `export` through
  `wiki-workspace wiki <ws> <command>`. With `run`, the arguments are passed
  unchanged to the engine, including for a command that writes.

```text
Select the ATLAS workspace.
Search for information about the latest COPIL.
Run the ingestion of the pending sources.
Run /wiki doctor on ATLAS.
Run the wiki-build skill.
```

Outside Claude Desktop (Cowork, Claude Code), the skill can also launch
`scripts/run-wiki-skill.py`, which reads the same registry and asks for the
workspace when there are several. For a development install, the script
discovers the manager next to `LLM_WIKI_ENGINE_HOME`; otherwise set
`LLM_WIKI_MANAGER_BIN` to `wiki-manager.js` (and `BUN_BIN` if Bun is not in
`~/.bun/bin`).

## Local diagnostics

```bash
# detected workspaces
WIKI_MANAGER_STATE_DIR=<manager-dir> node bin/llm-wiki-connect.mjs list

# a single workspace over stdio (no multiplexing)
node bin/llm-wiki-connect.mjs mcp --workspace atlas

# the multi-workspace connector, as Claude Desktop launches it
WIKI_MANAGER_STATE_DIR=<manager-dir> LLM_WIKI_ENGINE_HOME=<llm-wiki-dir> \
  node bin/llm-wiki-connect.mjs multi-mcp
```

The last two expect MCP JSON-RPC messages on standard input. The extension log
(Claude Desktop → Settings → Extensions) shows the skipped workspaces and the
engine startup errors.

## Language

`language` from the workspace `.wikirc.yaml`, then the system language
(`LANG`/`LC_*`), then `en`.
