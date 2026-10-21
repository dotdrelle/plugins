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
  'This llm-wiki connection is read-only. Only the listed read tools and workspace selection controls are available. Other tools are denied by the bridge even if called directly.',
  'Tool names are prefixed with mcp__llm_wiki__. For ordinary questions, call mcp__llm_wiki__wiki_workspace_current; list/select a workspace only if the requested one is not active or the user asks to choose. Do not call wiki_workspace_status for ordinary Q&A.',
  'Required bounded reading workflow: for synthesis, architecture, audit, comparison, or functional analysis, call mcp__llm_wiki__wiki_collect_context FIRST, once, with maxResults=3 and maxPageChars=6000. For one narrow fact, use maxResults=1 or 2. Do not start with wiki_search_context. Use its targeted search only if the collection reports incomplete coverage or the user asks you to establish whether something is absent; then make at most one focused search with maxResults=3, includeRaw=false, and maxExcerptChars=1200.',
  'Evidence shape: wiki_collect_context.readPages are the only opened page evidence. candidateResults are wiki-page previews for path selection, not opened evidence. sourceCandidates and notReadRawSources are path-only unread leads; never infer or quote their content. Open the matching source before using it. Keep read wiki pages, archived originals, attachments, and web results as distinct sources.',
  'Read only the selected evidence pages. If more evidence is necessary, call wiki_read_pages once with only the additional paths, exclude already-read paths, maxPageChars=6000, and maxTotalChars=20000. Stop when the evidence answers the question. Do not enumerate the wiki, reread paths, or open raw originals just to broaden the answer. Read one narrow raw-source section only when the user asks for source verification or a relevant wiki page is explicitly partial and the missing detail changes the answer; use an anchored path with a 4000-character page cap and 8000-character total budget, and identify the raw source as supplemental.',
  'Treat search excerpts as candidates, not complete evidence. Base claims on pages actually read, cite only the exact paths used, and state material lexical fallback, incomplete coverage, missing/unreadable/truncated pages, ambiguity, or budget limits. Answer concisely in the user’s language; do not dump the search process or every candidate path.',
  'For a request that combines wiki evidence with current or external information, use the Harness web tools when they are available. For attached documents, use Harness attachment or file-reading tools when available. Keep wiki, web, and attachment evidence distinct and cite each source; do not present web results as if they came from the wiki.',
  'This MCP connection cannot perform edits, ingestion, builds, or exports. Do not claim those actions were completed based on this connection, and do not use shell or filesystem tools to bypass the wiki write workflow.',
].join('\n');

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function idKey(id) {
  return `${typeof id}:${String(id)}`;
}

function toolRefusal(id, name) {
  writeMessage({
    jsonrpc: '2.0',
    id,
    result: {
      isError: true,
      content: [{
        type: 'text',
        text: `Tool refused: ${String(name || '(missing name)')} is not available in this read-only llm-wiki connection. Use its listed read tools; it cannot perform wiki changes.`,
      }],
    },
  });
}

if (!existsSync(connectorPath)) {
  console.error(
    `llm-wiki Harness bridge: connector not found at ${connectorPath}. Set LLM_WIKI_CONNECTOR to plugins/claude-desktop/bin/llm-wiki-connect.mjs.`,
  );
  process.exit(1);
}

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
      const existing = message.result.instructions?.replaceAll(
        'wiki_workspace_select',
        'mcp__llm_wiki__wiki_workspace_select',
      );
      message.result.instructions = [existing, instructions].filter(Boolean).join('\n\n');
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
          controls.push({
            ...tool,
            annotations: { ...tool.annotations, readOnlyHint: true },
          });
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
              description: 'FIRST choice for wiki synthesis, architecture, audit, comparison, and functional analysis. Call once with maxResults=3 and maxPageChars=6000 (use maxResults=1–2 for a narrow fact). readPages are opened evidence; candidateResults are wiki previews; sourceCandidates are unread path-only leads with no excerpts. Do not call wiki_search_context first; expand only when coverage is incomplete or the user asks to verify absence.',
            });
          } else if (tool.name === 'wiki_search_context') {
            readTools.push({
              ...tool,
              description: 'Targeted candidate search only, not the first step for synthesis. Use after wiki_collect_context only when coverage is incomplete or the user asks to verify absence. Keep the search focused: maxResults=3, includeRaw=false, maxExcerptChars=1200. Wiki excerpts are previews, not opened evidence; archived sources are path-only unread leads. Read a source before relying on it.',
            });
          } else if (tool.name === 'wiki_read_pages') {
            readTools.push({
              ...tool,
              description: 'Read only selected pages or sections that are needed to answer. Pass only new paths (never reread pages already returned), maxPageChars=6000, maxTotalChars=20000. For a necessary raw-source check, use one anchored section with maxPageChars=4000 and maxTotalChars=8000.',
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
      message.result.tools = [...controls, ...readTools];
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
    if (!control && !readOnly) {
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
