# @momojie-s/dsh-workspace-mcp

A DSH plugin that loads and unloads MCP servers per **workspace (session cwd)**. A project's `.dsh/mcp.servers.yml` applies only to that project's sessions. Its MCP tools are registered in the agent scope and released with the agent, so projects never interfere with each other.

This is a compiled copy of the upstream project; see [VENDORED.md](VENDORED.md). The upstream README is in Chinese, this is its translation.

## Requirements

- DSH `>= 0.1.0-rc.6` (verified up to `0.2.0-rc.2`)

## Usage

Put `.dsh/mcp.servers.yml` at the project root:

```yaml
servers:
  my-server:
    transport: stdio
    command: npx
    args: ["-y", "some-mcp-server@latest"]
    env: {}
  remote:
    transport: streamable-http
    url: https://example.com/mcp
    headers:
      Authorization: "Bearer <token>"
```

Fields match `@deepseek-ai/dsh-mcp-client` (`transport` / `command` / `args` / `env` / `url` / `headers` / `toolCallTimeoutMs` / `reconnect`).

- Connection and registration happen when the agent is created (`agent/created`), so **the first model request already has these tools**. In the headless "create, then send a message at once" race, step 1 may lack them; step 2 always has them.
- **Automatic reconnection** (ported from the official dsh-mcp-client supervisor): a failed start or a lost connection reconnects with exponential backoff and registers the tools again. The old tools stay registered meanwhile (calls fail) and are replaced once the server is back. For stdio this respawns the process; for HTTP it repeats the handshake.
- **Session recovery** (>= 0.2.1, not yet in the official client): after a streamable-http server restart or session eviction, errors such as `Session not found` count as a disconnection and trigger a new connection, with no manual forced reconnect.
- **stdio environment inheritance** (>= 0.3.0, same as global MCP): the child process gets a scrubbed parent environment (names matching `KEY|PASSWORD|SECRET|TOKEN` and names starting with `DSH_` are removed) plus the yml `env` as an overlay. Servers that need a parent variable such as `PYTHONPATH` just work; the yml `env` is an overlay, not the whole environment.
- A server declaring a supported `outputSchema` enters the `structuredContent` output contract. An invalid tool list or a registered-name conflict rejects or rolls back the whole generation (>= 0.3.0, aligned with the official client).
- A `toolListChanged` notification from the server resynchronizes the tool list.
- chokidar watches the configuration file, so saving reloads it. A directory without this file loads no MCP server.

### Temporary mount in headless/tui profiles

These two profiles do not mount workspace-mcp by default. When needed, use `--patch` to mount a `file:///` line pointing at its lib. This works for host-only plugins, not for plugins with a browser half:

```bash
dsh --profile headless --patch <(echo "- insert:
    - id: workspace-mcp
      name: file:///D:/code/workspace/deepseek-harness-101/plugins/dsh-workspace-mcp/lib/index.js") "task..."
```

### Shadowing global MCP servers of the same name (measured)

Tool names are `mcp__<serverName>__<tool>` on both sides. Conflicts follow the DSH tool registry: the agent scope shadows the global scope, tool by tool.

| Case | Behaviour |
|---|---|
| Different serverName | Both coexist and the model sees both sets of tools (normal use) |
| Same serverName (tool names collide) | The project wins: the model sees and calls the project version (from step 1 on web; if the race is lost, step 1 may use the global version, then the project version from step 2). The global version is unaffected in other workspaces without this server |
| Two entries with the same serverName in the global patch | The later generation's registration rolls back entirely, the log reports `already registered`, and that server has no tools |
| Duplicate server key in one yml | The later YAML key overrides the earlier one |

Deliberate shadowing is a legitimate technique, for example to point a global server at a local dev instance. If a collision is accidental, rename the server. If the two tool lists differ, only the same-named tools are shadowed; the others stay visible on each side.

## Installation

In Harness Desktop, under Plugins > Add plugin > Install a third-party plugin:

```text
git+https://github.com/dotdrelle/plugins.git#main&path:/dsh-workspace-mcp
```

For another profile, from the command line:

```bash
dsh plugin --profile web add 'git+https://github.com/dotdrelle/plugins.git#main&path:/dsh-workspace-mcp'
```

The plugin is a **bundle** (`dsh.bundle`): installing it adds its configuration layer, with no patch to edit by hand. Restart DSH once the layer is in place. To verify it:

```bash
dsh web --dump-config | grep workspace-mcp
```

## Configuration

Plugin level (patch `config` field):

| Field | Default | Description |
|------|--------|------|
| `configFile` | `.dsh/mcp.servers.yml` | Configuration file path, relative to the workspace root |
| `verbose` | `false` | Detailed connection and registration logs, for troubleshooting |
| `reconnect.enabled` | `true` | Reconnect automatically after a disconnection or a failed start |
| `reconnect.initialDelayMs` | `500` | First reconnection delay, then doubled each time |
| `reconnect.maxDelayMs` | `30000` | Backoff ceiling. A connection alive for longer resets the attempt budget, so occasional crashes recover indefinitely while a crash loop is stopped |
| `reconnect.maxAttempts` | `10` | Maximum consecutive failures in one disconnection cycle. Once exhausted, all the server's tools are unloaded; editing the configuration file or restarting recovers |

Per-server override (`.dsh/mcp.servers.yml`, takes priority over the plugin level):

```yaml
servers:
  flaky:
    transport: stdio
    command: npx
    args: ["-y", "some-mcp"]
    reconnect:
      enabled: true
      initialDelayMs: 1000
      maxAttempts: 5
```

## Verification

Put a `.dsh/mcp.servers.yml` with a test server (such as the official MCP `server-everything`) at the project root, and ask the agent in a session to list its tools:

```
mcp__<serverName>__<toolName>
```

If the tools appear, it works. In a directory without configuration they no longer appear, which confirms the isolation.

To troubleshoot, set `verbose: true` in the mount config. The logs include `[ws-mcp] server "xxx": registered N tools` (on stderr for stdio).

---

The design documents and tests are in the [upstream repository](https://github.com/Momojie-S/dsh-workspace-mcp).
