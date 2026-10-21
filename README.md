# llm-wiki for DeepSeek Harness

This Cordis bundle connects DeepSeek Harness to the existing `llm-wiki`
connector over MCP stdio. It is separate from `../claude-desktop`, which keeps
the Claude Desktop packaging and installer.

## What it provides

- Workspace discovery and selection through the existing connector.
- Wiki search, evidence collection, page and source reading, graph queries,
  provenance lookup, product help, and other explicitly allow-listed read tools.
- Instructions telling Harness to ground answers in pages it actually read and
  report incomplete coverage, and to keep wiki, web, and attachment evidence
  distinct when the profile provides those other tools.
- A stdio bridge that filters `tools/list` and rejects every non-allow-listed
  `tools/call`, even if a model attempts to invoke a hidden write tool directly.
- Per workspace, the bridge selects a `.wikirc` profile that accepts the
  manager-issued MCP credential. It reports and skips a workspace when no
  profile accepts that credential or the workspace has not been initialized.

Wiki reading is bounded for Harness: synthesis starts with at most three pages
and 6,000 characters per page; any follow-up reads have a total character
budget. Raw originals are opened only to verify a material gap in a partial
wiki page. This keeps ordinary answers grounded without flooding the model
context with repeated searches or whole source documents.

The MCP result keeps evidence types separate: `readPages` contains opened wiki
evidence, `candidateResults` contains wiki previews for path selection, and
`sourceCandidates` contains unread source paths without excerpts. Donna must
open a candidate before citing its content; a raw-source lead is never treated
as part of a wiki page.

Writes, ingestion, skills that execute actions, builds, and exports are not
available through this integration. The current multi-workspace connector keeps
one active workspace for the MCP process; selecting another workspace changes
the target for every conversation using that profile. Use one profile per
workspace when conversations may run concurrently.

The bridge blocks writes through this MCP connection. It cannot disable other
Harness tools: a profile that grants filesystem or shell access may still be
able to modify local files directly. The instructions prohibit using those
tools to bypass wiki's governed write workflow, but that is a model instruction,
not an OS-level path restriction.

## Requirements

- A Node.js executable available as `node`, or `LLM_WIKI_NODE` set to its
  absolute path.
- The `plugins/claude-desktop` connector and a built `llm-wiki` engine.
- A `wiki-manager` installation with at least one initialized workspace.
- DeepSeek Harness with the `@deepseek-ai/dsh-mcp-client` plugin available in
  its installation.

By default, this package expects the Claude connector at
`../claude-desktop/bin/llm-wiki-connect.mjs`. Set `LLM_WIKI_CONNECTOR` when the
connector is installed elsewhere. The connector also supports
`WIKI_MANAGER_STATE_DIR`, `LLM_WIKI_ENGINE_HOME`, and `LLM_WIKI_ENTRYPOINT` for
non-standard installations.

## Install in Harness Desktop

The Desktop app owns its `desktop` profile; a regular terminal may not have the
`dsh` command, and the app's profile should be managed from the app itself.

1. Open **Plugins** in the Harness Desktop sidebar.
2. Choose **Add plugin** → **Install a third-party plugin**.
3. Enter the absolute path to this directory, for example:
   `/Users/dotdrelle/Developpement/wikiLLM/plugins/deepseek-harness`.
4. Choose **Install**, then **Enable now** when installation finishes.
5. Restart Harness if the plugin manager says a restart is required.

The installed bundle adds `llm-wiki-dsh-paths` followed by
`llm-wiki-dsh-mcp`. The Desktop Plugins page accepts a package name, Git URL,
tarball, or absolute local directory path. See the
[Harness Desktop plugin guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-plugin-manager/README.md)
for the current install flow.

For a separate Harness CLI/Web profile, install from the workspace root with
the CLI and profile name for that separate instance:

```bash
dsh plugin --profile web add ./plugins/deepseek-harness
dsh --profile web --dump-config
```

Restart that profile after installing the bundle.

For a standalone Harness install, make the connector path available to the
profile process:

```bash
export LLM_WIKI_CONNECTOR=/absolute/path/to/plugins/claude-desktop/bin/llm-wiki-connect.mjs
export WIKI_MANAGER_STATE_DIR=/absolute/path/to/wiki-manager-state
export LLM_WIKI_ENGINE_HOME=/absolute/path/to/llm-wiki
dsh --profile web
```

If launched from the workspace checkout, the connector normally discovers the
manager and engine beside it. The connector's `list` command can confirm which
workspaces it found:

```bash
WIKI_MANAGER_STATE_DIR=/absolute/path/to/wiki-manager-state \
  node plugins/claude-desktop/bin/llm-wiki-connect.mjs list
```

## Tool policy

The bridge allows only the read tools listed in `readonly-mcp.mjs`. For engine
tools, the allow-list is combined with the MCP `readOnlyHint` annotation; a tool
is hidden if either check fails. Workspace selection controls are the only
non-engine tools exposed. Other calls receive an explicit read-only refusal.

This bundle does not add a filesystem skill directory. Its MCP initialization
instructions carry the wiki-reading workflow, so the integration does not
depend on a profile-specific skill preset.
