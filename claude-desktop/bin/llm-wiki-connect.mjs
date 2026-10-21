#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { createInterface as createLineInterface } from 'node:readline';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Kept equal to mcpb/manifest.json and claude-plugin/.claude-plugin/plugin.json:
// the build scripts refuse to package when the three disagree.
const CONNECTOR_VERSION = '0.16.62';

function configPath() {
  if (process.env.LLM_WIKI_CONNECTOR_CONFIG) return resolve(process.env.LLM_WIKI_CONNECTOR_CONFIG);
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(configHome, 'llm-wiki', 'connector.json');
}

function readConnectorConfig() {
  const file = configPath();
  if (!existsSync(file)) return {};
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch (error) {
    throw new Error(`Configuration llm-wiki invalide: ${file} (${error.message})`);
  }
}

function writeConnectorConfig(value) {
  const file = configPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return file;
}

function desktopLanguage() {
  const values = [process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANGUAGE, process.env.LANG];
  for (const raw of values) {
    if (!raw || /^(C|POSIX)(?:[.@_-].*)?$/i.test(raw)) continue;
    const match = raw.match(/^([A-Za-z]{2,3})(?:[-_].*)?/);
    if (match) return match[1].toLowerCase();
  }
  return 'en';
}

function workspaceLanguage(workspacePath) {
  const file = join(workspacePath, '.wikirc.yaml');
  if (!existsSync(file)) return null;
  const match = readFileSync(file, 'utf8').match(/^\s*language:\s*['"]?([A-Za-z]{2,3})['"]?\s*$/m);
  return match ? match[1].toLowerCase() : null;
}

function languageForWorkspace(workspacePath) {
  const configured = workspaceLanguage(workspacePath);
  return configured || desktopLanguage() || 'en';
}

function homeConfig() {
  const config = readConnectorConfig();
  return {
    ...config,
    managerHome: resolve(config.managerHome || process.env.WIKI_MANAGER_STATE_DIR || pluginRoot),
    workspacesHome: config.workspacesHome
      ? resolve(config.workspacesHome)
      : process.env.WIKI_WORKSPACES_DIR ? resolve(process.env.WIKI_WORKSPACES_DIR) : null,
    engineHome: resolve(config.engineHome || process.env.LLM_WIKI_ENGINE_HOME || resolve(pluginRoot, '../../llm-wiki')),
  };
}

function readEnv(file) {
  const values = {};
  if (!existsSync(file)) return values;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!match) continue;
    values[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  return values;
}

function workspaceFromPath(workspacePath) {
  const canonicalPath = resolve(workspacePath);
  const env = readEnv(join(canonicalPath, '.env'));
  return {
    name: env.WORKSPACE_NAME || process.env.WIKI_WORKSPACE_NAME || canonicalPath.split('/').pop() || 'workspace-local',
    workspacePath: canonicalPath,
    registryPath: null,
    managerDir: null,
    mcpPort: env.WIKI_MCP_PORT || null,
    servePort: env.WIKI_SERVE_PORT || null,
    mcpAuthToken: env.WIKI_MCP_AUTH_TOKEN || null,
    language: languageForWorkspace(canonicalPath),
  };
}

function candidateManagerDirs() {
  const configured = homeConfig();
  const explicit = process.env.WIKI_MANAGER_STATE_DIR;
  const workspaceDir = process.env.WIKI_WORKSPACES_DIR;
  const candidates = [
    configured.managerHome,
    explicit,
    configured.workspacesHome ? dirname(configured.workspacesHome) : null,
    workspaceDir ? dirname(workspaceDir) : null,
    process.env.PWD,
    join(homedir(), 'llm-wiki'),
    join(homedir(), '.llm-wiki'),
    resolve(pluginRoot, '../..', 'llm-wiki-manager'),
  ].filter(Boolean);
  return [...new Set(candidates.map((value) => resolve(value)))];
}

function discoverWorkspaces() {
  const configured = homeConfig();
  const result = [];
  const seen = new Set();
  for (const managerDir of candidateManagerDirs()) {
    const root = configured.workspacesHome || (process.env.WIKI_WORKSPACES_DIR
      ? resolve(process.env.WIKI_WORKSPACES_DIR)
      : join(managerDir, 'workspaces'));
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const registryPath = join(root, entry.name);
      const env = readEnv(join(registryPath, '.env'));
      if (!Object.keys(env).length) continue;
      const workspacePath = resolve(env.WIKI_WORKSPACE_PATH || registryPath);
      let canonicalPath = workspacePath;
      try { canonicalPath = realpathSync.native?.(workspacePath) ?? realpathSync(workspacePath); } catch {}
      const workspace = {
        name: env.WORKSPACE_NAME || entry.name,
        workspacePath: canonicalPath,
        registryPath,
        managerDir,
        mcpPort: env.WIKI_MCP_PORT || null,
        servePort: env.WIKI_SERVE_PORT || null,
        mcpAuthToken: env.WIKI_MCP_AUTH_TOKEN || null,
        language: languageForWorkspace(canonicalPath),
      };
      const key = `${workspace.name}\0${workspace.workspacePath}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(workspace);
      }
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

function workspaceConfigFile(workspace) {
  const names = readdirSync(workspace.workspacePath)
    .filter((name) => /^\.wikirc\.ya?ml(?:\.[^/\\]+)?$/.test(name));
  let activeName = null;
  try {
    const record = JSON.parse(readFileSync(join(workspace.workspacePath, '.wiki', 'active-profile.json'), 'utf8'));
    const fileName = typeof record?.fileName === 'string' ? record.fileName.trim() : '';
    const profile = typeof record?.profile === 'string' ? record.profile.trim() : '';
    if (/^\.wikirc\.ya?ml(?:\.[^/\\]+)?$/.test(fileName)) activeName = fileName;
    else if (profile) activeName = profile === 'default' ? '.wikirc.yaml' : `.wikirc.yaml.${profile}`;
  } catch {
    // Older workspaces have no active-profile record; use their available files.
  }

  const ordered = [...new Set([
    activeName,
    '.wikirc.yaml',
    '.wikirc.yml',
    '.wikirc.yaml.default',
    ...names.sort(),
  ].filter((name) => name && names.includes(name)))];
  if (!ordered.length) return undefined;

  const engineHome = homeConfig().engineHome;
  const YAML = createRequire(join(engineHome, 'package.json'))('yaml');
  const parsed = [];
  for (const name of ordered) {
    try {
      const value = YAML.parse(readFileSync(join(workspace.workspacePath, name), 'utf8')) ?? {};
      const accessKey = value && typeof value === 'object' && !Array.isArray(value)
        ? value.mcp?.accessKey
        : undefined;
      parsed.push({ name, accessKey });
    } catch {
      // Leave malformed profiles to the engine's normal, actionable diagnostic.
    }
  }

  const token = workspace.mcpAuthToken;
  const matching = parsed.find((profile) => token && profile.accessKey === token);
  if (matching) return matching.name;

  const active = parsed.find((profile) => profile.name === activeName);
  if (active && active.accessKey == null) return active.name;

  // A profile without its own key lets the engine resolve the manager-issued
  // WIKI_MCP_AUTH_TOKEN from the child environment.
  return parsed.find((profile) => profile.accessKey == null)?.name ?? null;
}

function discoverWorkspaceSkills(workspace) {
  const skillsDir = join(workspace.workspacePath, '.wiki', 'skills');
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => {
      const file = join(skillsDir, entry.name);
      const raw = readFileSync(file, 'utf8');
      const name = raw.match(/^---[\s\S]*?^name:\s*["']?([^\r\n"']+)["']?\s*$/m)?.[1]?.trim()
        || entry.name.replace(/\.md$/, '');
      const description = raw.match(/^---[\s\S]*?^description:\s*["']?([^\r\n"']+)["']?\s*$/m)?.[1]?.trim() || '';
      return { name, description };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function selectWorkspace(name) {
  const workspaces = discoverWorkspaces();
  const requestedName = name || process.env.WIKI_WORKSPACE_NAME;
  if (requestedName) {
    const normalizedName = requestedName.toLocaleLowerCase();
    const found = workspaces.find((workspace) => workspace.name.toLocaleLowerCase() === normalizedName);
    if (!found) throw new Error(`Workspace not found: ${requestedName}`);
    return found;
  }
  const path = process.env.WIKI_WORKSPACE_PATH;
  if (path) return workspaceFromPath(path);
  if (workspaces.length === 1) return workspaces[0];
  if (!workspaces.length) throw new Error('No workspace found. Configure WIKI_MANAGER_STATE_DIR or WIKI_WORKSPACES_DIR.');
  throw new Error(`Multiple workspaces found (${workspaces.map((item) => item.name).join(', ')}). Use --workspace <name>.`);
}

function printUsage() {
  console.log(`Usage:
  llm-wiki-connect.mjs setup [--manager-home <path>] [--workspaces-home <path>] [--engine-home <path>]
  llm-wiki-connect.mjs list
  llm-wiki-connect.mjs mcp --workspace <name>
  llm-wiki-connect.mjs multi-mcp
  llm-wiki-connect.mjs claude-config --workspace <name>`);
}

function writeJsonRpc(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let activeIngest = null;

function bunCommand() {
  const configured = process.env.BUN_BIN;
  if (configured) return configured;
  const bundled = join(homedir(), '.bun', 'bin', 'bun');
  return existsSync(bundled) ? bundled : 'bun';
}

function managerCommand() {
  const configured = process.env.LLM_WIKI_MANAGER_BIN;
  if (configured) return configured.endsWith('.js') ? [bunCommand(), configured] : [configured];
  const configuredHome = process.env.LLM_WIKI_MANAGER_HOME;
  if (configuredHome) return [bunCommand(), join(resolve(configuredHome), 'bin', 'wiki-manager.js')];
  const engineHome = homeConfig().engineHome;
  const candidates = [
    join(resolve(engineHome, '..', 'llm-wiki-manager'), 'bin', 'wiki-manager.js'),
    join(resolve(pluginRoot, '..', '..', 'llm-wiki-manager'), 'bin', 'wiki-manager.js'),
  ];
  const localSource = candidates.find((candidate) => existsSync(candidate));
  if (localSource) return [bunCommand(), localSource];
  return ['wiki-manager'];
}

function workspaceCommand() {
  const configured = process.env.LLM_WIKI_WORKSPACE_BIN;
  if (configured) return [configured];
  const engineHome = homeConfig().engineHome;
  const candidates = [
    join(resolve(engineHome, '..', 'llm-wiki-manager'), 'wiki-workspace'),
    join(resolve(pluginRoot, '..', '..', 'llm-wiki-manager'), 'wiki-workspace'),
  ];
  const localSource = candidates.find((candidate) => existsSync(candidate));
  return localSource ? [localSource] : ['wiki-workspace'];
}

function runHeadlessSkill(workspace, skill) {
  return new Promise((resolveRun) => {
    const command = managerCommand();
    const child = spawn(command[0], [
      ...command.slice(1),
      '--headless', '--workspace', workspace.name, '--skill', skill,
      '--timeout', '3600', '--max-turns', '20',
    ], {
      cwd: workspace.managerDir || workspace.registryPath || workspace.workspacePath,
      env: {
        ...process.env,
        WIKI_MANAGER_STATE_DIR: workspace.managerDir || process.env.WIKI_MANAGER_STATE_DIR,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let error = '';
    let settled = false;
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { error += chunk.toString(); });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      resolveRun({ status: 'timeout', exitCode: 124, output: output.trim(), error: 'The skill run timed out.' });
    }, 3_630_000);
    child.on('error', (cause) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({ status: 'failed', exitCode: 1, output: output.trim(), error: cause.message });
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({
        status: code === 0 ? 'done' : 'failed',
        exitCode: code ?? 1,
        output: output.trim(),
        error: error.trim(),
      });
    });
  });
}

function runWorkspaceIngest(workspace, progress, requestId) {
  return new Promise((resolveRun) => {
    const command = workspaceCommand();
    const child = spawn(command[0], [...command.slice(1), 'wiki', workspace.name, 'ingest'], {
      cwd: workspace.managerDir || workspace.registryPath || workspace.workspacePath,
      env: { ...process.env, WIKI_MANAGER_STATE_DIR: workspace.managerDir || process.env.WIKI_MANAGER_STATE_DIR },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let output = '';
    let error = '';
    let settled = false;
    let cancelled = false;
    const stop = () => {
      if (settled) return false;
      cancelled = true;
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
      return true;
    };
    activeIngest = { child, workspace, requestId, stop };
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      output += text;
      progress?.(text, 'stdout');
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      error += text;
      progress?.(text, 'stderr');
    });
    const timer = setTimeout(() => {
      if (settled) return;
      stop();
      settled = true;
      child.kill('SIGTERM');
      resolveRun({ status: 'timeout', exitCode: 124, output: output.trim(), error: 'The ingestion timed out.' });
    }, 3_630_000);
    child.on('error', (cause) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({ status: 'failed', exitCode: 1, output: output.trim(), error: cause.message });
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({ status: cancelled ? 'cancelled' : (code === 0 ? 'done' : 'failed'), exitCode: code ?? 1, output: output.trim(), error: error.trim() });
      if (activeIngest?.child === child) activeIngest = null;
    });
  });
}

function runWorkspaceCommand(workspace, commandName, args = []) {
  return new Promise((resolveRun) => {
    const command = workspaceCommand();
    const child = spawn(command[0], [...command.slice(1), 'wiki', workspace.name, commandName, ...args], {
      cwd: workspace.managerDir || workspace.registryPath || workspace.workspacePath,
      env: { ...process.env, WIKI_MANAGER_STATE_DIR: workspace.managerDir || process.env.WIKI_MANAGER_STATE_DIR },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let error = '';
    let settled = false;
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { error += chunk.toString(); });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      resolveRun({ status: 'timeout', exitCode: 124, output: output.trim(), error: 'The command timed out.' });
    }, 3_630_000);
    child.on('error', (cause) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({ status: 'failed', exitCode: 1, output: output.trim(), error: cause.message });
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({ status: code === 0 ? 'done' : 'failed', exitCode: code ?? 1, output: output.trim(), error: error.trim() });
    });
  });
}

async function runMultiMcp() {
  const configured = homeConfig();
  const entrypoint = process.env.LLM_WIKI_ENTRYPOINT || resolve(configured.engineHome, 'dist/bin/wiki.js');
  if (!existsSync(entrypoint)) throw new Error(`llm-wiki entrypoint not found: ${entrypoint}`);
  const workspaces = discoverWorkspaces();
  if (!workspaces.length) throw new Error('No workspace found in the wiki-manager registry.');

  let childRequestId = 0;
  const children = [];
  for (const workspace of workspaces) {
    const configFile = workspaceConfigFile(workspace);
    if (configFile === null) {
      console.error(`llm-wiki connector: workspace ${workspace.name} skipped (no .wikirc profile accepts its MCP credential).`);
      continue;
    }
    const childEnv = {
      ...process.env,
      WIKI_WORKSPACE_PATH: workspace.workspacePath,
      ...(workspace.mcpAuthToken ? { WIKI_MCP_AUTH_TOKEN: workspace.mcpAuthToken } : {}),
    };
    if (configFile) childEnv.WIKI_CONFIG_PATH = configFile;
    else delete childEnv.WIKI_CONFIG_PATH;
    const child = spawn(process.execPath, [entrypoint, 'mcp'], {
      cwd: workspace.workspacePath,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const pending = new Map();
    child.on('exit', (code) => {
      const error = new Error(`MCP workspace process exited (${code ?? 'unknown'})`);
      for (const settle of pending.values()) settle({ error: { message: error.message } });
      pending.clear();
    });
    const lines = createLineInterface({ input: child.stdout });
    lines.on('line', (line) => {
      try {
        const message = JSON.parse(line);
        if (message.id !== undefined && pending.has(message.id)) {
          const settle = pending.get(message.id);
          pending.delete(message.id);
          settle(message);
        }
      } catch {
        // The engine's MCP stdout must remain JSON-RPC; ignore malformed noise
        // so one child cannot corrupt the proxy transport.
      }
    });
    const call = (method, params = {}) => new Promise((resolveCall, rejectCall) => {
      const id = ++childRequestId;
      pending.set(id, (message) => {
        if (message.error) rejectCall(new Error(message.error.message || `MCP ${method} failed`));
        else resolveCall(message.result ?? {});
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
    try {
      await call('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'llm-wiki-claude-multiplexer', version: CONNECTOR_VERSION },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
      children.push({ workspace, child, call });
    } catch (error) {
      console.error(`llm-wiki connector: workspace ${workspace.name} skipped (${error.message})`);
      child.kill();
    }
  }
  if (!children.length) throw new Error('No workspace MCP server could be started.');

  const workspaceTools = new Map();
  for (const entry of children) {
    const listing = await entry.call('tools/list');
    workspaceTools.set(entry.workspace.name, { entry, tools: listing.tools ?? [] });
  }
  let activeWorkspace = children.length === 1 ? children[0].workspace.name : null;
  const workspaceControlTools = [
    {
      name: 'wiki_workspace_list',
      description: 'List the workspaces available in the wiki-manager registry.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'wiki_workspace_current',
      description: 'Return the workspace currently selected for this Claude session.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'wiki_workspace_select',
      description: 'Select the workspace used by the standard wiki_* tools for this Claude session.',
      inputSchema: {
        type: 'object',
        properties: { workspace: { type: 'string', description: 'Exact workspace name from wiki_workspace_list.' } },
        required: ['workspace'],
      },
    },
    {
      name: 'wiki_skill_list',
      description: 'List the exact workspace skill names available in the active workspace.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'wiki_skill_run',
      description: 'Run an exact workspace skill through the local wiki-manager headless runner. Use only after the user explicitly asks to execute a skill.',
      inputSchema: {
        type: 'object',
        properties: { skill: { type: 'string', description: 'Exact workspace skill name, with optional inline arguments.' } },
        required: ['skill'],
      },
    },
    {
      name: 'wiki_ingest',
      description: 'Run the native llm-wiki ingestion pipeline for the active workspace. Use when the user explicitly asks to ingest pending sources; this is a pipeline command, not a workspace skill.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'wiki_ingest_stop',
      description: 'Stop the active local wiki ingestion, if one is running.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'wiki_command_run',
      description: 'Run a native wiki-workspace command for the active workspace. Use for doctor, run, build, or export; this is not a workspace skill.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', enum: ['doctor', 'run', 'build', 'export'] },
          args: { type: 'array', items: { type: 'string' }, description: 'Arguments passed unchanged to wiki-workspace.' },
        },
        required: ['command'],
      },
    },
  ];

  function activeTools() {
    // Claude Desktop builds its permissions screen from the first tools/list
    // response. Publish the normal wiki tools immediately, even before a
    // workspace is selected; calls are refused with a clear selection hint
    // until wiki_workspace_select has established the session target.
    const selected = activeWorkspace
      ? workspaceTools.get(activeWorkspace)
      : workspaceTools.values().next().value;
    return [
      ...workspaceControlTools,
      ...(selected?.tools ?? []).map((tool) => ({
        ...tool,
        description: `[active workspace: ${activeWorkspace || 'none selected'}] ${tool.description || ''}`.trim(),
      })),
    ];
  }

  function workspaceListResult() {
    return {
      workspaces: children.map((entry) => ({
        name: entry.workspace.name,
        path: entry.workspace.workspacePath,
        active: entry.workspace.name === activeWorkspace,
      })),
      activeWorkspace,
    };
  }

  const dispatch = async (message) => {
    if (message.method === 'notifications/initialized') return;
    if (message.method === 'notifications/cancelled') {
      const requestId = message.params?.requestId;
      if (activeIngest && (requestId === undefined || requestId === activeIngest.requestId)) activeIngest.stop();
      return;
    }
    if (message.method === 'initialize') {
      writeJsonRpc({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: '2025-11-25',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'llm-wiki-claude', version: CONNECTOR_VERSION },
          instructions: `Available workspaces: ${children.map((entry) => entry.workspace.name).join(', ')}. Call wiki_workspace_select before the wiki_* tools when no active workspace is set. The selection stays active for this Claude session.`,
        },
      });
      return;
    }
    if (message.method === 'ping') {
      writeJsonRpc({ jsonrpc: '2.0', id: message.id, result: {} });
      return;
    }
    if (message.method === 'tools/list') {
      writeJsonRpc({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          tools: activeTools(),
        },
      });
      return;
    }
    if (message.method === 'tools/call') {
      const requested = message.params?.name;
      if (requested === 'wiki_workspace_list') {
        writeJsonRpc({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(workspaceListResult(), null, 2) }] } });
        return;
      }
      if (requested === 'wiki_workspace_current') {
        writeJsonRpc({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify({ activeWorkspace }, null, 2) }] } });
        return;
      }
      if (requested === 'wiki_workspace_select') {
        const requestedWorkspace = String(message.params?.arguments?.workspace ?? '').trim();
        const selected = children.find((entry) => entry.workspace.name.toLocaleLowerCase() === requestedWorkspace.toLocaleLowerCase());
        if (!selected) {
          writeJsonRpc({ jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: `Unknown workspace: ${requestedWorkspace}. Use wiki_workspace_list.` }] } });
          return;
        }
        activeWorkspace = selected.workspace.name;
        writeJsonRpc({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify({ ...workspaceListResult(), message: `Active workspace: ${activeWorkspace}` }, null, 2) }] } });
        return;
      }
      if (requested === 'wiki_skill_list') {
        if (!activeWorkspace) {
          writeJsonRpc({ jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: 'No active workspace. Use wiki_workspace_list then wiki_workspace_select.' }] } });
          return;
        }
        const selected = workspaceTools.get(activeWorkspace)?.entry.workspace;
        writeJsonRpc({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify({ workspace: activeWorkspace, skills: discoverWorkspaceSkills(selected) }, null, 2) }] } });
        return;
      }
      if (requested === 'wiki_skill_run') {
        if (!activeWorkspace) {
          writeJsonRpc({ jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: 'No active workspace. Use wiki_workspace_list then wiki_workspace_select.' }] } });
          return;
        }
        const requestedSkill = String(message.params?.arguments?.skill ?? '').trim();
        if (!requestedSkill) {
          writeJsonRpc({ jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: 'The exact skill name is required.' }] } });
          return;
        }
        const selected = workspaceTools.get(activeWorkspace)?.entry.workspace;
        const result = await runHeadlessSkill(selected, requestedSkill);
        writeJsonRpc({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify({ workspace: activeWorkspace, skill: requestedSkill, ...result }, null, 2) }], ...(result.status === 'failed' || result.status === 'timeout' ? { isError: true } : {}) } });
        return;
      }
      if (requested === 'wiki_ingest') {
        if (!activeWorkspace) {
          writeJsonRpc({ jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: 'No active workspace. Use wiki_workspace_list then wiki_workspace_select.' }] } });
          return;
        }
        const selected = workspaceTools.get(activeWorkspace)?.entry.workspace;
        const progressToken = message.params?._meta?.progressToken;
        const startedAt = Date.now();
        const progress = progressToken === undefined ? null : (chunk, stream) => {
          const lines = String(chunk).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
          for (const line of lines) {
            writeJsonRpc({
              jsonrpc: '2.0',
              method: 'notifications/progress',
              params: {
                progressToken,
                progress: Date.now() - startedAt,
                total: 3_630_000,
                message: `${stream === 'stderr' ? '[diagnostic] ' : ''}${line}`,
              },
            });
          }
        };
        const result = await runWorkspaceIngest(selected, progress, message.id);
        result.durationMs = Date.now() - startedAt;
        result.summary = result.status === 'done'
          ? `Ingestion complete for ${activeWorkspace}. See the output for details.`
          : `Ingestion ${result.status} for ${activeWorkspace}. See the error for diagnostics.`;
        writeJsonRpc({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify({ workspace: activeWorkspace, operation: 'ingest', ...result }, null, 2) }], ...(result.status === 'failed' || result.status === 'timeout' ? { isError: true } : {}) } });
        return;
      }
      if (requested === 'wiki_ingest_stop') {
        const stopped = activeIngest?.stop() ?? false;
        writeJsonRpc({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify({ operation: 'ingest_stop', stopped, workspace: activeIngest?.workspace.name ?? activeWorkspace, message: stopped ? 'Stop requested.' : 'No ingestion is running.' }, null, 2) }] } });
        return;
      }
      if (requested === 'wiki_command_run') {
        if (!activeWorkspace) {
          writeJsonRpc({ jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: 'No active workspace. Use wiki_workspace_list then wiki_workspace_select.' }] } });
          return;
        }
        const commandName = String(message.params?.arguments?.command ?? '').trim();
        const args = Array.isArray(message.params?.arguments?.args)
          ? message.params.arguments.args.map((arg) => String(arg))
          : [];
        if (!['doctor', 'run', 'build', 'export'].includes(commandName)) {
          writeJsonRpc({ jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: 'Native command refused. Allowed commands: doctor, run, build, export.' }] } });
          return;
        }
        const selected = workspaceTools.get(activeWorkspace)?.entry.workspace;
        const result = await runWorkspaceCommand(selected, commandName, args);
        writeJsonRpc({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify({ workspace: activeWorkspace, operation: commandName, args, ...result }, null, 2) }], ...(result.status === 'failed' || result.status === 'timeout' ? { isError: true } : {}) } });
        return;
      }
      if (!activeWorkspace) {
        writeJsonRpc({ jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: 'No active workspace. Use wiki_workspace_list then wiki_workspace_select.' }] } });
        return;
      }
      const owner = workspaceTools.get(activeWorkspace);
      const tool = owner?.tools.find((candidate) => candidate.name === requested);
      if (!owner || !tool) {
        writeJsonRpc({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: `Unknown tool for the active workspace ${activeWorkspace}: ${requested}` } });
        return;
      }
      try {
        const result = await owner.entry.call('tools/call', { ...message.params, name: tool.name });
        writeJsonRpc({ jsonrpc: '2.0', id: message.id, result });
      } catch (error) {
        writeJsonRpc({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: error.message } });
      }
      return;
    }
    if (message.id !== undefined) {
      writeJsonRpc({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Unsupported MCP method: ${message.method}` } });
    }
  };

  const input = createLineInterface({ input: process.stdin });
  input.on('line', (line) => {
    try {
      const message = JSON.parse(line);
      void dispatch(message);
    } catch (error) {
      console.error(`llm-wiki connector: invalid MCP message (${error.message})`);
    }
  });
  await new Promise(() => {});
}

async function setup() {
  const current = readConnectorConfig();
  const managerHomeArg = argument('--manager-home');
  const workspacesHomeArg = argument('--workspaces-home');
  const engineHomeArg = argument('--engine-home');
  const languageArg = argument('--language');
  const nonInteractive = process.argv.includes('--non-interactive');
  let managerHome = managerHomeArg || current.managerHome || process.env.WIKI_MANAGER_STATE_DIR || '';
  let workspacesHome = workspacesHomeArg || current.workspacesHome || process.env.WIKI_WORKSPACES_DIR || '';
  let engineHome = engineHomeArg || current.engineHome || resolve(pluginRoot, '../../llm-wiki');

  if (!nonInteractive && process.stdin.isTTY && process.stdout.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const language = (languageArg || current.language || desktopLanguage()).toLowerCase();
    managerHome = (await rl.question(`Manager home [${managerHome || 'auto'}]: `)).trim() || managerHome;
    workspacesHome = (await rl.question(`Workspaces home [${workspacesHome || 'auto'}]: `)).trim() || workspacesHome;
    engineHome = (await rl.question(`Engine home [${engineHome}]: `)).trim() || engineHome;
    rl.close();
    current.language = language || 'en';
  } else if (languageArg) {
    current.language = languageArg.toLowerCase();
  }

  const next = {
    ...current,
    ...(managerHome ? { managerHome: resolve(managerHome) } : {}),
    ...(workspacesHome ? { workspacesHome: resolve(workspacesHome) } : {}),
    ...(engineHome ? { engineHome: resolve(engineHome) } : {}),
    language: current.language || desktopLanguage() || 'en',
  };
  const file = writeConnectorConfig(next);
  console.log(JSON.stringify({ config: file, ...next }, null, 2));
}

const command = process.argv[2];
if (!command || command === '--help' || command === 'help') {
  printUsage();
  process.exit(0);
}

try {
  if (command === 'setup' || command === 'init') {
    await setup();
    process.exit(0);
  }

  if (command === 'list') {
    console.log(JSON.stringify(discoverWorkspaces(), null, 2));
    process.exit(0);
  }

  if (command === 'multi-mcp') {
    await runMultiMcp();
    process.exit(0);
  }

  const workspace = selectWorkspace(argument('--workspace'));

  if (command === 'claude-config') {
    const args = [join(pluginRoot, 'bin', 'llm-wiki-connect.mjs'), 'mcp'];
    const env = {};
    if (workspace.registryPath) {
      args.push('--workspace', workspace.name);
      env.WIKI_MANAGER_STATE_DIR = workspace.managerDir;
    } else {
      env.WIKI_WORKSPACE_PATH = workspace.workspacePath;
    }
    console.log(JSON.stringify({
      mcpServers: {
        [`llm-wiki-${workspace.name}`]: {
          type: 'stdio',
          command: process.execPath,
          args,
          env: { ...env, LLM_WIKI_LANGUAGE: workspace.language || 'en' },
        },
      },
    }, null, 2));
    process.exit(0);
  }

  if (command === 'mcp') {
    const entrypoint = process.env.LLM_WIKI_ENTRYPOINT || resolve(homeConfig().engineHome, 'dist/bin/wiki.js');
    if (!existsSync(entrypoint)) throw new Error(`llm-wiki entrypoint not found: ${entrypoint}`);
    const configFile = workspaceConfigFile(workspace);
    if (configFile === null) {
      throw new Error(`No .wikirc profile accepts the MCP credential for workspace ${workspace.name}.`);
    }
    const childEnv = {
      ...process.env,
      WIKI_WORKSPACE_PATH: workspace.workspacePath,
      ...(workspace.mcpAuthToken ? { WIKI_MCP_AUTH_TOKEN: workspace.mcpAuthToken } : {}),
    };
    if (configFile) childEnv.WIKI_CONFIG_PATH = configFile;
    else delete childEnv.WIKI_CONFIG_PATH;
    const child = spawn(process.execPath, [entrypoint, 'mcp'], {
      cwd: workspace.workspacePath,
      env: childEnv,
      stdio: 'inherit',
    });
    child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
    process.on('SIGTERM', () => child.kill('SIGTERM'));
    process.on('SIGINT', () => child.kill('SIGINT'));
    process.exitCode = 0;
    // Keep this process alive while the child MCP server is running.
    await new Promise(() => {});
  }

  throw new Error(`Unknown command: ${command}`);
} catch (error) {
  console.error(`llm-wiki connector: ${error.message}`);
  process.exit(1);
}
