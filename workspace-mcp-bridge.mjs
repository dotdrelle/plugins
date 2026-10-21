#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const wikiToolNames = new Set([
  'wiki_workspace_status',
  'wiki_list_pages',
  'wiki_curation_inventory',
  'wiki_read_page',
  'wiki_read_pages',
  'wiki_list_provenance_locators',
  'wiki_outline',
  'wiki_graph_query',
  'wiki_graph_view',
  'wiki_graph_path',
  'template_read',
  'build_context_read',
  'wiki_read_deliverable',
  'wiki_list_ingested_sources',
  'wiki_read_ingested_source',
  'wiki_maintenance_state',
  'wiki_search_context',
  'wiki_collect_context',
  'help_list',
  'help_read',
  'help_search',
  'profile_read',
]);

const productionToolNames = new Set([
  'production_status',
  'production_list_templates',
  'production_start_job',
  'production_job_status',
  'production_job_logs',
  'production_cancel_job',
  'production_list_jobs',
]);
const allowedProductionJobs = new Set(['build', 'export', 'polish']);

function instructionsFor(serveUrl, workspaceSlug) {
  const prefix = `mcp__${workspaceSlug}_wiki__`;
  const links = serveUrl
    ? `Trusted Serve browser base URL: ${serveUrl}. When the user needs to open a document, call workspace_document_url with the exact relative path returned by a wiki MCP tool and include the returned URL as a Markdown link. The link opens only the rendered document, without Serve navigation. Never emit a remote document path as a local relative file link.`
    : 'No Serve browser URL is configured. You may read documents through MCP, but do not present their relative paths as clickable local files; say that opening them in Serve is not configured.';
  return [
    'This MCP server is scoped to exactly one remote llm-wiki workspace. The workspace documents remain on the wiki server; read them through these MCP tools or open them with a trusted Serve URL configured for this workspace.',
    `For this workspace, use its tools named ${prefix}wiki__* and ${prefix}production__*. Do not use a machine-level/global workspace selector or another wiki's tools for this workspace.`,
    `Use ${prefix}wiki__wiki_workspace_status to inspect templates, shared build context, and deliverables. Read template bodies with ${prefix}wiki__template_read, shared rules with ${prefix}build_context_read, and generated documents with ${prefix}wiki__wiki_read_deliverable. These tools return the remote content; local project files are only connection configuration.`,
    'Use wiki search/collection and read tools for factual evidence. Keep wiki evidence, web evidence, and attachments distinct, and cite the exact paths returned by the tools.',
    links,
    `Production tools are restricted by this bridge to build, export, and polish. When the user requests one, use ${prefix}production__production_start_job if production is connected; do not claim this workspace lacks build/export tools based only on the global read-only connection. Then use ${prefix}production__production_job_status and ${prefix}production__production_job_logs to report the result; never claim success from a queued job alone.`,
    `If ${prefix}workspace_connection_status reports a disconnected service, report which service is disconnected and do not substitute another wiki or use local filesystem tools to read remote documents.`,
  ].join('\n');
}

function fail(message) {
  console.error(`llm-wiki workspace bridge: ${message}`);
  process.exit(1);
}

function endpointUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute HTTPS URL.`);
  }
  const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !localHttp) {
    throw new Error(`${label} must use HTTPS. HTTP is allowed only for localhost development.`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must not embed credentials, query parameters, or a fragment.`);
  }
  return url;
}

function serveBaseUrl(value) {
  const url = endpointUrl(value, 'serve.url');
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

function documentUrl(pathValue, serveUrl) {
  if (!serveUrl) throw new Error('No Serve browser URL is configured for this workspace.');
  if (typeof pathValue !== 'string' || !pathValue.trim() || pathValue.length > 4096) {
    throw new Error('path must be an exact relative path returned by a wiki MCP tool.');
  }
  const [rawPath, ...fragmentParts] = pathValue.trim().split('#');
  const path = rawPath.replace(/^\/+/, '');
  if (!path || path.includes('?') || path.includes('\\') || /^[a-z][a-z\d+.-]*:/i.test(path)) {
    throw new Error('path must be a relative Serve document path without a query or URL scheme.');
  }
  const segments = path.split('/').map((segment) => {
    let decoded;
    try { decoded = decodeURIComponent(segment); } catch { throw new Error('path contains invalid URL encoding.'); }
    if (!decoded || decoded === '.' || decoded === '..' || decoded.startsWith('.tmp.') || decoded.startsWith('.changes.')) {
      throw new Error('path contains a hidden or unsafe segment.');
    }
    return decoded;
  });
  const relativePath = segments.join('/');
  if (!(relativePath.startsWith('wiki/')
    || relativePath.startsWith('templates/')
    || relativePath.startsWith('deliverables/')
    || relativePath.startsWith('build-context/')
    || relativePath.startsWith('raw/'))
    || (!relativePath.endsWith('.md') && !relativePath.endsWith('.md.lock'))) {
    throw new Error('path is outside the Markdown documents served by this workspace.');
  }
  const encodedPath = segments.map((segment) => encodeURIComponent(segment)).join('/');
  const href = `${serveUrl.replace(/\/+$/, '')}/${encodedPath}?view=document`;
  const fragment = fragmentParts.join('#');
  return fragment ? `${href}#${encodeURIComponent(fragment)}` : href;
}

async function readConfig() {
  const configPath = resolve(process.cwd(), '.dsh/llm-wiki-mcp.json');
  let config;
  try {
    config = JSON.parse(await readFile(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!config || typeof config !== 'object' || !config.wiki || typeof config.wiki !== 'object') {
    throw new Error(`${configPath} must declare a wiki endpoint and read token.`);
  }
  if (typeof config.wiki.url !== 'string' || typeof config.wiki.token !== 'string' || !config.wiki.token.trim() || /[\r\n]/.test(config.wiki.token)) {
    throw new Error(`${configPath} must declare wiki.url and wiki.token.`);
  }
  const wikiUrl = endpointUrl(config.wiki.url, 'wiki.url');
  const serve = config.serve === undefined || config.serve === null
    ? null
    : { url: serveBaseUrl(config.serve.url) };
  let production = null;
  if (config.production) {
    if (typeof config.production.url !== 'string' || typeof config.production.token !== 'string' || !config.production.token.trim() || /[\r\n]/.test(config.production.token)) {
      throw new Error('production must declare both url and token, or be omitted.');
    }
    production = {
      url: endpointUrl(config.production.url, 'production.url'),
      token: config.production.token,
    };
  }
  return {
    wiki: { url: wikiUrl, token: config.wiki.token },
    serve,
    production,
  };
}

async function connectEndpoint(name, endpoint, token) {
  if (!endpoint) return { name, status: 'not-configured', client: null, tools: [] };
  const client = new Client({ name: `llm-wiki-dsh-${name}`, version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  try {
    await client.connect(transport);
    return { name, status: 'connected', client, tools: [] };
  } catch (error) {
    await transport.close().catch(() => {});
    return {
      name,
      status: 'disconnected',
      client: null,
      tools: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function discoverTools(connection, allowlist, namespace, exposed) {
  if (!connection.client) return;
  try {
    let cursor;
    const seenCursors = new Set();
    for (let page = 0; page < 100; page += 1) {
      const result = await connection.client.listTools(cursor ? { cursor } : undefined);
      for (const tool of result.tools ?? []) {
        if (!allowlist.has(tool.name)) continue;
        if (namespace === 'wiki' && tool.annotations?.readOnlyHint !== true) continue;
        const name = `${namespace}__${tool.name}`;
        const item = { ...tool, name };
        if (namespace === 'production') {
          if (tool.name === 'production_start_job') {
            item.description = `${tool.description ?? ''} This workspace bridge permits only type=build, type=export, or type=polish.`.trim();
            item.annotations = {
              ...tool.annotations,
              readOnlyHint: false,
              destructiveHint: true,
              idempotentHint: false,
            };
            if (item.inputSchema?.properties?.type) {
              item.inputSchema = {
                ...item.inputSchema,
                properties: {
                  ...item.inputSchema.properties,
                  type: { ...item.inputSchema.properties.type, enum: [...allowedProductionJobs] },
                },
              };
            }
          } else if (tool.name === 'production_cancel_job') {
            item.annotations = {
              ...tool.annotations,
              readOnlyHint: false,
              destructiveHint: true,
              idempotentHint: true,
            };
          } else {
            item.annotations = {
              ...tool.annotations,
              readOnlyHint: true,
              destructiveHint: false,
              idempotentHint: true,
            };
          }
        }
        exposed.set(name, { connection, rawName: tool.name, namespace });
        connection.tools.push(name);
        exposed.set(`tool:${name}`, item);
      }
      const nextCursor = result.nextCursor;
      if (!nextCursor || seenCursors.has(nextCursor)) break;
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
  } catch (error) {
    connection.status = 'disconnected';
    connection.error = error instanceof Error ? error.message : String(error);
    await connection.client.close().catch(() => {});
    connection.client = null;
    connection.tools = [];
    for (const [name, target] of exposed) {
      if (typeof name === 'string' && target?.connection === connection) exposed.delete(name);
    }
  }
}

async function main() {
  const config = await readConfig();
  const [wikiConnection, productionConnection] = await Promise.all([
    connectEndpoint('wiki', config.wiki.url, config.wiki.token),
    connectEndpoint('production', config.production?.url, config.production?.token),
  ]);
  const exposed = new Map();
  await Promise.all([
    discoverTools(wikiConnection, wikiToolNames, 'wiki', exposed),
    discoverTools(productionConnection, productionToolNames, 'production', exposed),
  ]);

  const server = new Server(
    { name: 'llm-wiki-workspace-bridge', version: '1.0.0' },
    { capabilities: { tools: {} }, instructions: instructionsFor(config.serve?.url, basename(resolve(process.cwd())) || 'workspace') },
  );
  const statusTool = {
    name: 'workspace_connection_status',
    title: 'Workspace connection status',
    description: 'Report which configured remote wiki and production MCP services are connected, and whether a Serve document URL is configured.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  };
  const documentUrlTool = {
    name: 'workspace_document_url',
    title: 'Open workspace document in Serve',
    description: 'Turn an exact Markdown path returned by this workspace wiki MCP into a browser URL for the wiki Serve UI. Use this for clickable links to templates, wiki pages, build-context files, deliverables, or raw Markdown sources.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Exact relative Markdown path returned by a wiki MCP tool, optionally with a #heading fragment.' } },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [statusTool, documentUrlTool, ...[...exposed.keys()].filter((name) => !name.startsWith('tool:')).map((name) => exposed.get(`tool:${name}`))],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args = {} } = request.params;
    if (name === statusTool.name) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            workspace: process.cwd(),
            wiki: { status: wikiConnection.status, tools: wikiConnection.tools.length, ...(wikiConnection.error ? { error: wikiConnection.error } : {}) },
            serve: config.serve ? { status: 'configured' } : { status: 'not-configured' },
            production: { status: productionConnection.status, tools: productionConnection.tools.length, ...(productionConnection.error ? { error: productionConnection.error } : {}) },
          }, null, 2),
        }],
      };
    }
    if (name === documentUrlTool.name) {
      try {
        return { content: [{ type: 'text', text: documentUrl(args.path, config.serve?.url) }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] };
      }
    }
    const target = exposed.get(name);
    if (!target) {
      return { isError: true, content: [{ type: 'text', text: `Tool refused: ${name} is not enabled for this wiki workspace.` }] };
    }
    if (target.namespace === 'production' && target.rawName === 'production_start_job') {
      if (!allowedProductionJobs.has(String(args.type ?? ''))) {
        return { isError: true, content: [{ type: 'text', text: 'Tool refused: this workspace exposes only build, export, and polish jobs.' }] };
      }
    }
    try {
      return await target.connection.client.callTool(
        { name: target.rawName, arguments: args },
        undefined,
        { signal: extra.signal },
      );
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: `${name} failed: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  for (const connection of [wikiConnection, productionConnection]) {
    if (connection.status === 'disconnected') {
      console.error(`llm-wiki workspace bridge: ${connection.name} MCP is disconnected: ${connection.error}`);
    }
  }
  const close = async () => {
    await Promise.all([wikiConnection.client?.close(), productionConnection.client?.close()]);
    await server.close();
  };
  process.once('SIGINT', () => { void close().finally(() => process.exit(0)); });
  process.once('SIGTERM', () => { void close().finally(() => process.exit(0)); });
}

main().catch(fail);
