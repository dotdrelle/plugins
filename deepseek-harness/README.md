# llm-wiki for DeepSeek Harness

This Cordis bundle connects DeepSeek Harness to llm-wiki. Generated Harness
Workspaces connect to remote wiki and production MCP endpoints over HTTPS, one
wiki per local Harness workspace. An optional machine-level read-only
connection can reuse the `../claude-desktop` connector over MCP stdio.

**Donna Harness** is DeepSeek Harness running this bundle, so Donna answers from
the wiki inside Harness. A separate brand bundle can replace the Harness mark
in the sidebar with the Donna one: a hexagon, the Donna wordmark and a
**HARNESS** pill. That brand bundle is not part of this repository, and the
llm-wiki integration works without it.

## What it provides

- Optional local manager workspace discovery through the existing connector.
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
- Each generated Harness Workspace is bound to the exact wiki MCP URL and
  read token entered for it. The bridge passes the workspace name, slug, and
  endpoint to Donna as MCP instructions and on its tools; it never exposes the
  token. Donna is told not to choose a workspace from the manager registry.
- A configured Serve base URL, used to turn MCP-returned document paths into
  browser links. It is the web UI URL, not the wiki MCP URL; local installs
  commonly use `http://localhost:3100`, while wiki MCP commonly uses port `3101`.
- Harness-compatible graph handling: the engine's graph tool returns an SVG,
  which Harness cannot consume as an image. The workspace bridge keeps the
  structured graph result, explains this format limitation, and supplies a
  link to Serve's interactive graph; `workspace_graph_url` can prefill its
  search with a concept, tag, or phrase.
- A plugin-level Serve URL setting and **Llm-wiki** entries in the left panel
  list and the right-Sidebar guide. With a conversation active, selecting the
  left entry opens that URL in Harness's right-Sidebar Browser; without one, it
  opens the URL in the system browser. The right-Sidebar guide opens it in the
  Harness Browser.
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
single-active-workspace behavior. In Harness, its manager-wide workspace list
and selection controls are hidden and refused; its generic read tools are
marked as local-only and are not bound to a generated URL/token profile. Use
generated workspace folders for remote wiki projects: their MCP tools are
agent-scoped to the Harness workspace, so sessions on two different wikis do
not share a mutable active selection. If those scoped tools are
missing, open the conversation in the matching Harness Workspace instead of
selecting a target from the manager registry.
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
the same validation and private profile format. The wiki URL and token pair
fix the remote target for that local Harness Workspace. Creating a profile
does not switch the current conversation: open the conversation in the matching
Harness Workspace to activate its scoped MCP tools. A manager registry message
about an unselected workspace does not change the bridge's binding.

To use generated remote workspaces, install a second Harness plugin: the
per-workspace loader. Install
`github:Momojie-S/dsh-workspace-mcp` in the same Desktop profile (Plugins → Add
plugin → install third-party plugin). It reads each project's
`.dsh/mcp.servers.yml` and scopes the tools to that workspace's agent. Review
that plugin's source and compatibility notes before installing third-party
code.

### Harness Desktop

Once the plugin is enabled, Harness shows two entry points:

- **Llm-wiki** in the left sidebar, below Plugins, Automation tasks and Inbox.
  It opens the configured Serve page (see below).
- An **llm-wiki** tab in **Settings → Built-in plugins**, next to **Plugin
  list**. It holds the **llm-wiki workspaces** form.

The form asks for four fields:

| Field | Value |
| --- | --- |
| **Workspace name** | The label of the Harness Workspace. |
| **Wiki MCP HTTPS URL** | The remote wiki MCP endpoint. |
| **Wiki read token** | The read token issued for that endpoint. |
| **Serve HTTP(S) browser URL (open wiki documents)** | The wiki web UI, used to build document links. Local default: `http://localhost:3100`. |

All four fields are required. The Serve URL opens documents in the server's web
UI and is different from the MCP endpoint. It also differs from the sidebar
URL, which is set in the plugin configuration (below). The form creates the
local folder and
registers it in Harness Workspaces; it does not switch the current session to
that workspace. Use a conversation opened under the new Harness Workspace.
Tick **Enable build, export and polish actions** only when you have a
separate production MCP URL and write token (the **Production MCP HTTPS URL**
and **Production write token** fields); otherwise the workspace remains
read-only. Tokens are sent to the authenticated Harness Host and stored in
owner-only files, outside Donna's model context.

If the `llm-wiki` tab is missing, use Plugins → Refresh, then reload Harness
Desktop; the plugin must be enabled. The form creates and registers the
workspace, but its MCP tools still require the one-time per-workspace loader
described above.

Set the page address under **Plugins → @dotdrelle/dsh-llm-wiki → Configure** on
the `llm-wiki-dsh-paths` component. Select **Llm-wiki** in the left sidebar to
open that address in Harness's right-side Browser when a conversation is
active, or in the system browser when no conversation is active. The right
Sidebar's **llm-wiki** entry opens the same configured address in Harness
Browser. The Serve URL on each
workspace form remains available for workspace-specific document links; it does
not control these entries.
Desktop enables the Sidebar Browser by default. In a Harness Web profile, enable
`ui-sidebar-browser` in that profile. The plugin setting accepts HTTP or HTTPS;
Harness Browser may refuse sites that block embedding, and HTTPS is recommended
for remote servers.

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
outside the wiki and source repositories, for example `~/my-wiki-harness.json`:

```json
{
  "name": "My wiki",
  "wiki": {
    "url": "https://wiki-proxy.example/my-wiki/mcp",
    "token": "<workspace read token>"
  },
  "serve": {
    "url": "https://wiki-proxy.example/my-wiki"
  },
  "production": {
    "url": "https://wiki-proxy.example/my-wiki/production/mcp/",
    "token": "<workspace production write token>"
  }
}
```

Use the actual HTTPS URLs and scoped tokens issued by the server/proxy. The
Serve URL is the browser-facing wiki UI; it may share a proxy host but use a
different path from `/mcp`. Serve accepts HTTP or HTTPS; use HTTPS for a remote
server. For a local Compose stack, the default is
`http://localhost:3100`; the wiki MCP endpoint is normally port `3101`.
The production block is optional; without it the workspace is wiki-read-only. Then
create the Harness project directory:

```bash
node plugins/deepseek-harness/workspace.mjs create --config ~/my-wiki-harness.json
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

- Node.js 24 or newer available as `node`, or `LLM_WIKI_NODE` set to its
  absolute path. This is required by the per-workspace loader.
- DeepSeek Harness with the `@deepseek-ai/dsh-mcp-client` plugin available in
  its installation.
- The per-workspace MCP loader, installed in the same Harness profile.
- The Harness right-Sidebar Browser for opening Serve pages beside a
  conversation (enabled by default in Desktop; enable it for Web profiles).

For a remote wiki, the local Claude connector, wiki engine, and wiki-manager
installation are not required. If the connector is absent, the machine-level
MCP bridge reports that it is unavailable and exposes no tools; the
workspace-specific remote connection continues to work. To enable local
manager workspaces, set `LLM_WIKI_CONNECTOR` to the connector file and configure
`WIKI_MANAGER_STATE_DIR` plus `LLM_WIKI_ENGINE_HOME` (the directory containing
`dist/bin/wiki.js`) or `LLM_WIKI_ENTRYPOINT` (the entrypoint file itself).

## One-command setup on Ubuntu

This installs the llm-wiki bundle and the per-workspace loader into one Harness
profile, then creates the local Harness Workspace folder connected to a remote
wiki. It assumes DeepSeek Harness CLI is already installed and a wiki MCP URL
and read token have been issued by the server.

From a clone of `https://github.com/dotdrelle/plugins`, run:

```bash
./install-deepseek.sh
```

Open Harness once first, then quit it when the script asks. The script creates
or updates the `desktop` profile under `~/.dsh`, installs both plugins, and
prompts for the remote wiki URL, token, and Serve URL. It writes the workspace
connection files under `~/DeepSeek Harness Workspaces/llm-wiki` with private
permissions. If pnpm asks permission to run the per-workspace loader's build
script, allow it for this install. For a separate CLI/Web profile, use the
manual profile-specific commands below.

The final prompt prints the new workspace folder. Add it once in Harness
Desktop with **Add workspace** to use the wiki from a conversation. The folder
contains connection settings, not wiki documents. This installer connects to
an existing wiki server; it does not deploy the wiki engine or manager.

## Install in Harness Desktop

The Desktop app owns its `desktop` profile; a regular terminal may not have the
`dsh` command, and the app's profile should be managed from the app itself.

This repository contains multiple plugins, so a Git URL must select the
`deepseek-harness/` package directory. In the Plugins page, use:

```text
git+https://github.com/dotdrelle/plugins.git#main&path:/deepseek-harness
```

The DSH bundle manifest is the `package.json` inside that directory. It declares
`dsh.bundle.patch`; no separate `plugin.json` is required. Installing the Git
URL lets Harness install the dependencies declared by that package.

For a local clone, install the package dependencies before linking the
directory into a Harness profile. DSH links a local checkout and uses that
checkout's own `node_modules`; it does not install those dependencies into the
clone for you:

From the root of the cloned `plugins` repository:

```bash
cd deepseek-harness
pnpm install
```

Then install or refresh the local directory in Harness Plugins. This step is
what makes imports such as `@deepseek-ai/schemastery` available. The bundle's
own dependencies are separate from the additional per-workspace loader below.

The same Git subdirectory target can be used from the CLI for another profile:

```bash
dsh plugin --profile web add 'git+https://github.com/dotdrelle/plugins.git#main&path:/deepseek-harness'
```

1. Open **Plugins** in the Harness Desktop sidebar.
2. Choose **Add plugin** → **Install a third-party plugin**.
3. Enter the absolute path to this directory, for example:
   `/path/to/plugins/deepseek-harness`.
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
