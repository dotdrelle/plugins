# llm-wiki for DeepSeek Harness

This Cordis bundle connects DeepSeek Harness to llm-wiki. The existing
machine-level connection uses the `../claude-desktop` connector over MCP stdio;
generated Harness Workspaces can connect to remote wiki and production MCP
endpoints over HTTPS, one wiki per local Harness workspace.

## What it provides

- Workspace discovery and selection through the existing connector.
- Wiki search, evidence collection, page and source reading, graph queries,
  provenance lookup, product help, and other explicitly allow-listed read tools.
- Instructions telling Harness to ground answers in pages it actually read and
  report incomplete coverage, and to keep wiki, web, and attachment evidence
  distinct when the profile provides those other tools.
- A stdio bridge that filters `tools/list` and rejects every non-allow-listed
  `tools/call`, even if a model attempts to invoke a hidden write tool directly.
- A workspace helper that creates one local Harness project directory per wiki
  workspace, containing only MCP configuration and connection metadata. Wiki
  documents are not copied onto the Harness machine.
- A workspace-scoped MCP bridge that reads the wiki and production endpoints
  through Streamable HTTP. It exposes allow-listed wiki reads and only
  `build`, `export`, and `polish` production jobs.
- A configured Serve base URL, used to turn MCP-returned document paths into
  browser links. It is the web UI URL, not the wiki MCP URL; local installs
  commonly use `http://localhost:3100`, while wiki MCP commonly uses port `3101`.
- Per workspace, the bridge selects a `.wikirc` profile that accepts the
  manager-issued MCP credential. It reports and skips a workspace when no
  profile accepts that credential or the workspace has not been initialized.

Wiki reading uses a bounded first pass in Harness: synthesis starts with at most
three candidate pages and 6,000 characters per page; follow-up reads target a
20,000-character budget per call. These are starting points, not hard limits:
when the engine reports truncation or incomplete coverage, Donna must continue
reading relevant content or narrower anchored sections before presenting a
complete answer. Targeted search starts with up to three results and 1,200
characters per excerpt. Raw originals are opened only to verify a material gap
in a partial wiki page. This reduces unnecessary context without treating
unread or truncated evidence as complete.

Wiki discovery and reading should go through the MCP tools. When a folder
inventory is needed, use `wiki_list_pages` with a narrow path filter rather
than shell, glob, or general filesystem tools. Trust the engine's explicit
truncation status; if a complete page contains malformed or abruptly ending
content, treat it as a source-quality issue and inspect only the relevant
anchored original when that missing detail matters. Each follow-up read should
resolve a specific unanswered part of the request; stop once every requested
part has supporting evidence. This is a stopping rule, not a page or content
limit.

The MCP result keeps evidence types separate: `readPages` contains opened wiki
evidence, `candidateResults` contains wiki previews for path selection, and
`sourceCandidates` contains unread source paths without excerpts. Donna must
open a candidate before citing its content; a raw-source lead is never treated
as part of a wiki page. Attached or workspace documents must be read through
llm-wiki MCP tools or from an HTTP(S) workspace URL supplied by trusted
workspace configuration or an MCP result and reachable through the configured
proxy. Do not guess a host. A local path or filename is not document content;
never use shell or filesystem tools to read it. If MCP and the approved
workspace URL cannot provide the content, say that it is unavailable.
When the user should open a wiki document, resolve its exact MCP-returned path
with `workspace_document_url` and include the resulting Serve URL as a Markdown
link. The link uses `?view=document` so Serve opens the rendered document without
its workspace navigation, toolbar, or table of contents. Remove that query
parameter to open the regular Serve page. Never make a remote document a local
relative file link.

The machine-level stdio connection remains read-only and retains its current
single-active-workspace behavior. Use generated workspace folders for remote
wiki projects: their MCP tools are agent-scoped to the Harness workspace, so a
Juno session and another wiki session do not share a mutable active selection.
The scoped bridge enables only `build`, `export`, and `polish` from the
production server. Harness's normal tool permission flow remains responsible
for confirming a requested production action. These direct Harness jobs do not
create a Serve/manager approval plan; they are submitted to `agent-production`
after Harness authorizes the destructive MCP call. The remote production server
must use a separate write-scoped token.

The machine-level bridge blocks writes through its local MCP connection. It
cannot disable other Harness tools: a profile that grants filesystem or shell
access may still modify local files directly. Generated remote workspace
folders contain no wiki documents; their workspace instructions prohibit using
local tools as a substitute for remote MCP reads.

## Create one Harness Workspace per wiki

Harness Workspaces group sessions by local directory. This helper creates that
local directory as a small connection profile; it does not mirror the wiki.
Donna reads context, templates, and deliverables from MCP, and starts
production jobs against the corresponding remote workspace. Desktop and CLI use
the same validation and private profile format.

The per-workspace loader is a separate Harness plugin. Install
`github:Momojie-S/dsh-workspace-mcp` in the same Desktop profile (Plugins → Add
plugin → install third-party plugin). It reads each project's
`.dsh/mcp.servers.yml` and scopes the tools to that workspace's agent. Review
that plugin's source and compatibility notes before installing third-party
code.

### Harness Desktop

Open **Settings → Built-in plugin settings → llm-wiki**. Enter the workspace
name, remote wiki MCP URL, read token, and Serve browser URL. The Serve URL opens
documents in the server's web UI; it is different from the MCP endpoint. The
form creates the local folder and
registers it in Harness Workspaces. Enable production only when you have a
separate production MCP URL and write token; otherwise the workspace remains
read-only. Tokens are sent to the authenticated Harness Host and stored in
owner-only files, outside Donna's model context.

If the `llm-wiki` tab is missing, use Plugins → Refresh, then reload Harness
Desktop; the plugin must be enabled. The form creates and registers the
workspace, but its MCP tools still require the one-time per-workspace loader
described above.

### CLI

The CLI creates the same private profile but cannot register it in the Desktop
app's workspace registry. Run the interactive setup from a terminal; it asks
for the MCP URL, Serve URL, and hides token input, then prints the new folder:

```bash
node plugins/deepseek-harness/workspace.mjs setup
```

For CLI mode, add the printed folder once in Harness Desktop → **Add
workspace**. To list profiles created by either interface, run:

```bash
node plugins/deepseek-harness/workspace.mjs list
```

### Advanced / batch setup

For automation or several workspaces at once, create a private JSON file
outside the wiki and source repositories, for example `~/juno-harness.json`:

```json
{
  "name": "Juno",
  "wiki": {
    "url": "https://wiki-proxy.example/juno/mcp",
    "token": "<workspace read token>"
  },
  "serve": {
    "url": "https://wiki-proxy.example/juno"
  },
  "production": {
    "url": "https://wiki-proxy.example/juno/production/mcp/",
    "token": "<workspace production write token>"
  }
}
```

Use the actual HTTPS URLs and scoped tokens issued by the server/proxy. The
Serve URL is the browser-facing wiki UI; it may share a proxy host but use a
different path from `/mcp`. For a local Compose stack, the default is
`http://localhost:3100`; the wiki MCP endpoint is normally port `3101`.
The production block is optional; without it the workspace is wiki-read-only. Then
create the Harness project directory:

```bash
node plugins/deepseek-harness/workspace.mjs create --config ~/juno-harness.json
```

For several workspaces, pass `{"workspaces": [ ... ]}` in the private JSON
file. Directories are created under `~/DeepSeek Harness Workspaces/llm-wiki`
by default; set `LLM_WIKI_DSH_WORKSPACE_ROOT` or pass `--root` to choose a
different location. Add each resulting directory in Harness Desktop →
**Add workspace**.

```bash
node plugins/deepseek-harness/workspace.mjs list
```

The helper stores endpoint credentials in the generated
`.dsh/llm-wiki-mcp.json`, with owner-only file permissions, and adds it to the
workspace `.gitignore`. It never prints tokens. Keep the config file private;
do not commit or sync it to a shared repository. The remote bridge requires
HTTPS except for localhost development, rejects credentials embedded in URLs,
reports disconnected endpoints, and refuses production job types outside the
three deliverable operations.

`build_context_read` exposes the Markdown under `build-context/` through the
engine MCP endpoint with per-file and total budgets. Update/redeploy the engine
before expecting that tool on a remote server; older servers will omit it.

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

The browser settings page is generated from `client.mjs` as the lazy client
bundle `client.js`. Regenerate it after UI changes and before packaging:

```bash
node plugins/deepseek-harness/build-client.mjs
```

A local source install can pick up the bundle after Plugins → Refresh and a
page reload. Restart Harness if that release does not hot-reload client modules.

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
