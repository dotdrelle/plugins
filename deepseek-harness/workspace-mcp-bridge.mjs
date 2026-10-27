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

function instructionsFor(config) {
  const { workspace, wiki, production, serve } = config;
  const workspaceSlug = workspace.slug;
  const prefix = `mcp__${workspaceSlug}_wiki__`;
  const links = serve
    ? `Trusted Serve browser base URL for this workspace: ${serve.url}. When the user needs to open a document, call workspace_document_url with the exact relative path returned by a wiki MCP tool and include the returned URL as a Markdown link. The link opens only the rendered document, without Serve navigation. Never emit a remote document path as a local relative file link.`
    : 'No Serve browser URL is configured. You may read documents through MCP, but do not present their relative paths as clickable local files; say that opening them in Serve is not configured.';
  return [
    `ACTIVE HARNESS WORKSPACE BINDING: ${JSON.stringify(workspace.name)} (slug ${workspaceSlug}) is bound to the remote llm-wiki MCP endpoint ${wiki.url.href}. This URL and its locally stored bearer token are the configured workspace identity. The token is a secret: never reveal it, quote it, or include it in an answer.`,
    `This bridge has a fixed connection to that one wiki endpoint and token; it cannot switch to another workspace. Use only this workspace's tools named ${prefix}wiki__* and ${prefix}production__*, plus workspace_connection_status, workspace_document_url, and workspace_graph_url. Do not use a machine-level/global workspace selector or another wiki's tools to resolve this workspace. If the user asks to work in another wiki workspace, ask them to switch to that workspace's Harness Workspace first.`,
    'A manager registry message saying that no workspace is selected does not change this bridge binding. Do not list or activate a manager workspace to guess the target: the configured endpoint above is the target for this Harness Workspace.',
    production ? `The production tools for this same workspace are bound to ${production.url.href}; the separate production token is also secret and must never be revealed.` : 'No production endpoint is configured for this workspace.',
    `Use ${prefix}wiki__wiki_workspace_status to inspect templates, shared build context, and deliverables. Read template bodies with ${prefix}wiki__template_read, shared rules with ${prefix}build_context_read, and generated documents with ${prefix}wiki__wiki_read_deliverable. These tools return the remote content; local project files are only connection configuration.`,
    'Use wiki search/collection and read tools for factual evidence. Keep wiki evidence, web evidence, and attachments distinct, and cite the exact paths returned by the tools.',
    'For a visual knowledge graph, use wiki_graph_view for its structured nodes and edges. This Harness bridge removes its SVG image block because Harness accepts raster images only; that is not a wiki or network failure. Use workspace_graph_url with the relevant concept, tag, or search phrase and include its link so the user can open the interactive Serve graph. Do not claim the graph endpoint failed or redraw the graph from memory.',
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

function graphUrl(queryValue, serveUrl) {
  if (!serveUrl) throw new Error('No Serve browser URL is configured for this workspace.');
  if (typeof queryValue !== 'string' || queryValue.length > 500) {
    throw new Error('query must be a search phrase of at most 500 characters.');
  }
  const url = new URL(`${serveUrl.replace(/\/+$/, '')}/graph`);
  const query = queryValue.trim();
  if (query) url.searchParams.set('q', query);
  return url.href;
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
  let workspace = {
    name: basename(resolve(process.cwd())),
    slug: basename(resolve(process.cwd())),
  };
  try {
    const metadata = JSON.parse(await readFile(resolve(process.cwd(), '.dsh/llm-wiki-workspace.json'), 'utf8'));
    if (metadata && typeof metadata === 'object') {
      if (typeof metadata.name === 'string' && metadata.name.trim()) workspace.name = metadata.name.trim().replace(/[\r\n\t]+/g, ' ');
      if (typeof metadata.slug === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(metadata.slug)) workspace.slug = metadata.slug;
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error(`cannot read workspace identity: ${error instanceof Error ? error.message : String(error)}`);
  }
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
    workspace,
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

async function discoverTools(connection, allowlist, namespace, exposed, config) {
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
        } else if (namespace === 'wiki' && tool.name === 'wiki_graph_view') {
          item.description = `${tool.description ?? ''} In DeepSeek Harness, the bridge keeps the structured nodes and edges but removes the SVG image block because Harness does not accept SVG as MCP image input. Use workspace_graph_url to give the user a link to the interactive Serve graph; this is an image-format limitation, not a failed graph request.`.trim();
        }
        const boundEndpoint = namespace === 'production' ? config.production?.url.href : config.wiki.url.href;
        item.description = `Fixed workspace binding: ${config.workspace.name} (${config.workspace.slug}), ${namespace} endpoint ${boundEndpoint}. This tool can access only the workspace configured for this Harness Workspace. ${item.description ?? ''}`.trim();
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
    discoverTools(wikiConnection, wikiToolNames, 'wiki', exposed, config),
    discoverTools(productionConnection, productionToolNames, 'production', exposed, config),
  ]);

  const server = new Server(
    { name: 'llm-wiki-workspace-bridge', version: '1.0.0' },
    { capabilities: { tools: {} }, instructions: instructionsFor(config) },
  );
  const statusTool = {
    name: 'workspace_connection_status',
    title: 'Workspace connection status',
    description: 'Report the fixed workspace binding for this Harness Workspace (name, slug, and configured wiki MCP endpoint), connection status, and whether a Serve document URL is configured. The endpoint is included; credentials are never returned.',
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
  const graphUrlTool = {
    name: 'workspace_graph_url',
    title: 'Open workspace knowledge graph in Serve',
    description: 'Build a browser link to this workspace’s interactive Serve graph, optionally prefilled with a search phrase, concept, or tag.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', maxLength: 500, description: 'Optional search phrase, concept, or tag to prefill in the graph.' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [statusTool, documentUrlTool, graphUrlTool, ...[...exposed.keys()].filter((name) => !name.startsWith('tool:')).map((name) => exposed.get(`tool:${name}`))],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args = {} } = request.params;
    if (name === statusTool.name) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            workspace: process.cwd(),
            binding: {
              name: config.workspace.name,
              slug: config.workspace.slug,
              wikiEndpoint: config.wiki.url.href,
              productionEndpoint: config.production?.url.href ?? null,
            },
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
    if (name === graphUrlTool.name) {
      try {
        return { content: [{ type: 'text', text: graphUrl(args.query ?? '', config.serve?.url) }] };
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
      const result = await target.connection.client.callTool(
        { name: target.rawName, arguments: args },
        undefined,
        { signal: extra.signal },
      );
      if (target.namespace === 'wiki' && target.rawName === 'wiki_graph_view' && Array.isArray(result.content)) {
        const hasSvg = result.content.some((block) => block?.type === 'image' && block.mimeType === 'image/svg+xml');
        if (hasSvg) {
          const selector = args.concept ?? args.tag ?? (args.node ? basename(String(args.node), '.md') : '');
          let link = '';
          try { link = graphUrl(String(selector), config.serve?.url); } catch {}
          const content = result.content.filter((block) => !(block?.type === 'image' && block.mimeType === 'image/svg+xml'));
          content.push({
            type: 'text',
            text: `Harness cannot display the SVG image returned with this graph. The structured graph data above is valid.${link ? ` Open the interactive graph in Serve: ${link}` : ' No Serve URL is configured; ask the user to configure one to open the interactive graph.'}`,
          });
          return { ...result, content };
        }
      }
      return result;
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
