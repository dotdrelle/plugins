#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const packageRoot = dirname(fileURLToPath(import.meta.url));
const connectorPath = resolve(
  process.env.LLM_WIKI_CONNECTOR ||
    resolve(packageRoot, '../claude-desktop/bin/llm-wiki-connect.mjs'),
);

const workspaceControls = new Set([
  'wiki_workspace_list',
  'wiki_workspace_current',
  'wiki_workspace_select',
]);

// This allow-list is intentionally explicit. Engine annotations are checked as
// a second guard before any tool is advertised to the Harness model.
const readOnlyToolNames = new Set([
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

const instructions = [
  'This llm-wiki machine-level connection is read-only and is not bound to the URL/token configured in a generated Harness Workspace. For any project wiki configured with that URL/token, you MUST use its workspace-specific <slug>_wiki MCP server. Never use this machine-level connection to choose or infer that target from the wiki-manager registry.',
  'If the matching workspace-specific MCP tools are not present, the conversation is outside that configured Harness Workspace or its loader is unavailable. Tell the user to open the conversation in the generated Harness Workspace or install/enable the per-workspace loader. Do not fall back to wiki_workspace_list, wiki_workspace_select, or generic mcp__llm_wiki__ wiki tools, because they can target a different workspace.',
  'Tool names on this machine-level connection are prefixed with mcp__llm_wiki__. Use it only when the user explicitly asks about a local wiki workspace and the request is not tied to a generated URL/token workspace. Do not call wiki_workspace_status for ordinary Q&A.',
  'For synthesis, architecture, audit, comparison, or functional analysis, start with one wiki_collect_context pass using maxResults=3 and maxPageChars=6000; these are starting budgets, not a completeness guarantee. For one narrow fact, use maxResults=1 or 2. Do not start with wiki_search_context. Use targeted search only if collection coverage is incomplete or the user asks you to establish whether something is absent; expand the search if its result is still incomplete.',
  'For wiki discovery and reading, use the llm-wiki MCP tools. If you need a relevant folder inventory beyond the collection results, use wiki_list_pages with the narrowest useful path filter; do not use Harness shell, glob, or general filesystem tools to inspect the wiki, and do not enumerate the whole corpus.',
  'Evidence shape: wiki_collect_context.readPages are the only opened page evidence. candidateResults are wiki-page previews for path selection, not opened evidence. sourceCandidates and notReadRawSources are path-only unread leads; never infer or quote their content. Open the matching source before using it. Keep read wiki pages, archived originals, attachments, and web results as distinct sources.',
  'Read only the selected evidence pages. The 6000-character page and 20000-character read limits are first-pass budgets, not permission to treat a truncated result as complete. If the engine reports truncated or incomplete coverage, continue reading the missing relevant content with a larger budget or an anchored section; do not omit it to fit the first-pass budget. When truncated is false, do not infer a transport truncation only because the page ends abruptly or contains malformed markup, and do not reread the same complete page. If that content defect hides a material answer, inspect the relevant anchored original or report the source-quality gap. Before each follow-up retrieval, identify the exact unanswered part of the user’s request it will resolve. Continue until every requested part has supporting evidence, then stop; do not gather extra examples outside the requested scope. This is a stopping criterion, not a page or content cap.',
  'Treat search excerpts as candidates, not complete evidence. Base claims on pages actually read, cite only the exact paths used, and state material lexical fallback, incomplete coverage, missing/unreadable/truncated pages, ambiguity, or budget limits. A page or result count limit may require another focused retrieval; expand when needed for a complete answer. Answer concisely in the user’s language; do not dump the search process or every candidate path.',
  'For a request that combines wiki evidence with current or external information, use the Harness web tools when they are available. Read attached or workspace documents only through llm-wiki MCP tools or by opening an HTTP(S) workspace URL supplied by trusted workspace configuration or an MCP result, through the configured proxy. Never guess a host or use a local path, shell, glob, or filesystem tool to read a document; a filename or attachment path alone is not document content. If neither MCP nor the approved workspace URL provides the content, say it is unavailable. Keep wiki, web, and document evidence distinct and cite each source; do not present web results as if they came from the wiki.',
  'This MCP connection cannot perform edits, ingestion, builds, or exports. Do not claim those actions were completed based on this connection, and do not use shell or filesystem tools to bypass the wiki write workflow.',
].join('\n');

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function idKey(id) {
  return `${typeof id}:${String(id)}`;
}

function toolRefusal(id, name) {
  const workspaceControl = workspaceControls.has(name);
  writeMessage({
    jsonrpc: '2.0',
    id,
    result: {
      isError: true,
      content: [{
        type: 'text',
        text: workspaceControl
          ? 'Tool refused: manager-wide workspace listing and selection are disabled in this Harness bridge. Open the generated Harness Workspace bound to the desired wiki URL/token and use its workspace-specific MCP tools.'
          : `Tool refused: ${String(name || '(missing name)')} is not available in this read-only llm-wiki connection. Use its listed read tools; it cannot perform wiki changes.`,
      }],
    },
  });
}

if (!existsSync(connectorPath)) {
  console.error('llm-wiki Harness bridge: local connector unavailable; remote workspace MCP connections remain available. Set LLM_WIKI_CONNECTOR to enable the local manager connection.');
  const input = createInterface({ input: process.stdin });
  input.on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      console.error(`llm-wiki Harness bridge: invalid MCP request (${error.message})`);
      return;
    }
    if (message.id === undefined) return;

    if (message.method === 'initialize') {
      writeMessage({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion || '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'llm-wiki-harness-readonly', version: '0.1.4' },
          instructions: 'The local wiki-manager connector is not configured. For a remote wiki, open the matching generated Harness Workspace and use its workspace-specific MCP tools.',
        },
      });
    } else if (message.method === 'tools/list') {
      writeMessage({ jsonrpc: '2.0', id: message.id, result: { tools: [] } });
    } else if (message.method === 'ping') {
      writeMessage({ jsonrpc: '2.0', id: message.id, result: {} });
    } else {
      writeMessage({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `Unsupported MCP method: ${message.method}` },
      });
    }
  });
  input.on('close', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
} else {

const child = spawn(process.execPath, [connectorPath, 'multi-mcp'], {
  cwd: packageRoot,
  env: process.env,
  stdio: ['pipe', 'pipe', 'inherit'],
});

const pendingMethods = new Map();
const advertisedReadTools = new Set();
let shuttingDown = false;
let lastFilterReport = '';

function stopChild(signal = 'SIGTERM') {
  if (shuttingDown) return;
  shuttingDown = true;
  if (!child.killed) child.kill(signal);
}

function forwardRequest(message) {
  if (!child.stdin.writable) {
    if (message.id !== undefined) {
      writeMessage({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32000, message: 'llm-wiki connector is not available.' },
      });
    }
    return;
  }

  if (message.id !== undefined) {
    pendingMethods.set(idKey(message.id), message.method);
  }
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

const childOutput = createInterface({ input: child.stdout });
childOutput.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    console.error(`llm-wiki Harness bridge: invalid connector response (${error.message})`);
    return;
  }

  if (message.id !== undefined) {
    const key = idKey(message.id);
    const method = pendingMethods.get(key);
    pendingMethods.delete(key);

    if (method === 'initialize' && message.result) {
      // The local connector's built-in prompt recommends selecting a manager
      // workspace. That conflicts with URL/token-scoped Harness workspaces, so
      // replace it completely with this bridge's scope policy.
      message.result.instructions = instructions;
      message.result.serverInfo = {
        ...message.result.serverInfo,
        name: 'llm-wiki-harness-readonly',
      };
    }

    if (method === 'tools/list' && message.result && Array.isArray(message.result.tools)) {
      const controls = [];
      const readTools = [];
      const hiddenTools = [];
      for (const tool of message.result.tools) {
        if (workspaceControls.has(tool.name)) {
          hiddenTools.push(tool.name);
          continue;
        }
        if (
          readOnlyToolNames.has(tool.name) &&
          tool.annotations?.readOnlyHint === true &&
          tool.annotations?.destructiveHint !== true
        ) {
          if (tool.name === 'wiki_collect_context') {
            readTools.push({
              ...tool,
              description: 'FIRST choice for wiki synthesis, architecture, audit, comparison, and functional analysis. Start with maxResults=3 and maxPageChars=6000 (use maxResults=1–2 for a narrow fact). These are first-pass budgets: if relevant pages are truncated or coverage is incomplete, continue with a larger read or focused sections. readPages are opened evidence; candidateResults are wiki previews; sourceCandidates are unread path-only leads with no excerpts. Do not call wiki_search_context first; expand only when coverage is incomplete or the user asks to verify absence.',
            });
          } else if (tool.name === 'wiki_search_context') {
            readTools.push({
              ...tool,
              description: 'Targeted candidate search only, not the first step for synthesis. Use after wiki_collect_context only to resolve a specific unanswered part or when the user asks to verify absence. Start focused with maxResults=3, includeRaw=false, maxExcerptChars=1200; expand the search if that part remains unsupported. Wiki excerpts are previews, not opened evidence; archived sources are path-only unread leads. Read a source before relying on it, then stop once all requested parts have evidence.',
            });
          } else if (tool.name === 'wiki_read_pages') {
            readTools.push({
              ...tool,
              description: 'Read only selected pages or sections that resolve a specific unanswered part of the request. Pass only new paths (never reread complete pages already returned). Start with maxPageChars=6000 and maxTotalChars=20000 per call; if a relevant page is truncated or coverage remains incomplete, increase the budget or read its missing anchored sections. Stop when all requested parts have supporting evidence. For a necessary raw-source check, start with one anchored section at maxPageChars=4000 and maxTotalChars=8000, expanding only if that section is still truncated.',
            });
          } else if (tool.name === 'wiki_list_pages') {
            readTools.push({
              ...tool,
              description: 'Use only when wiki_collect_context or a focused search does not reveal the relevant page paths and a folder inventory is needed. Filter to the narrowest relevant path; never enumerate the full wiki. Use this MCP tool for wiki discovery instead of shell, glob, or general filesystem tools.',
            });
          } else {
            readTools.push(tool);
          }
        } else {
          hiddenTools.push(tool.name);
        }
      }
      advertisedReadTools.clear();
      for (const tool of readTools) advertisedReadTools.add(tool.name);
      const localOnlyReadTools = readTools.map((tool) => ({
        ...tool,
        description: `Machine-level connection; not bound to a generated Harness Workspace URL/token. Use only when the user explicitly asks about a local manager workspace. For a configured remote workspace, use its matching workspace-specific MCP server instead. ${tool.description ?? ''}`.trim(),
      }));
      message.result.tools = [...controls, ...localOnlyReadTools];
      const visibleCount = controls.length + readTools.length;
      const hiddenPreview = hiddenTools.slice(0, 12).join(', ');
      const hiddenSuffix = hiddenTools.length > 12 ? `, and ${hiddenTools.length - 12} more` : '';
      const report = `llm-wiki Harness read-only policy: exposed ${visibleCount}/${visibleCount + hiddenTools.length} tools; hidden ${hiddenTools.length}${hiddenTools.length ? ` (${hiddenPreview}${hiddenSuffix})` : ''}.`;
      if (report !== lastFilterReport) {
        console.error(report);
        lastFilterReport = report;
      }
    }
  }

  writeMessage(message);
});

child.on('error', (error) => {
  console.error(`llm-wiki Harness bridge: could not start connector (${error.message})`);
});

child.on('exit', (code, signal) => {
  for (const [key] of pendingMethods) {
    const separator = key.indexOf(':');
    const type = key.slice(0, separator);
    const rawId = key.slice(separator + 1);
    const id = type === 'number' ? Number(rawId) : rawId;
    writeMessage({
      jsonrpc: '2.0',
      id,
      error: { code: -32000, message: `llm-wiki connector stopped (${signal || code || 'unknown'}).` },
    });
  }
  pendingMethods.clear();
  if (!shuttingDown && code !== 0) {
    console.error(`llm-wiki Harness bridge: connector exited with code ${code ?? 'unknown'}.`);
  }
  process.exitCode = code === 0 || shuttingDown ? 0 : 1;
});

const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    console.error(`llm-wiki Harness bridge: invalid MCP request (${error.message})`);
    return;
  }

  if (message.method === 'tools/call') {
    const name = message.params?.name;
    const control = workspaceControls.has(name);
    const readOnly = readOnlyToolNames.has(name) && advertisedReadTools.has(name);
    if (control || !readOnly) {
      toolRefusal(message.id, name);
      return;
    }
  }

  forwardRequest(message);
});

input.on('close', () => {
  child.stdin.end();
  stopChild();
});

process.on('SIGINT', () => stopChild('SIGINT'));
process.on('SIGTERM', () => stopChild('SIGTERM'));
}
