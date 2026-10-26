#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const pluginRoot = path.dirname(fileURLToPath(import.meta.url));
export const defaultRoot = path.join(os.homedir(), 'DeepSeek Harness Workspaces', 'llm-wiki');

function usage() {
  process.stdout.write(`llm-wiki Harness workspace helper

Usage:
  node workspace.mjs setup
  node workspace.mjs create --config <private-json-file> [--root <directory>]
  node workspace.mjs list [--root <directory>]

Config JSON (one workspace or {"workspaces": [...]}):
  {"name":"My wiki","wiki":{"url":"https://proxy.example/my-wiki/mcp","token":"read-token"},
   "serve":{"url":"https://proxy.example/my-wiki/serve"},
   "production":{"url":"https://proxy.example/my-wiki/production/mcp/","token":"write-token"}}

Omit production when this workspace should be wiki-read-only. Documents are not
copied locally; the workspace stores MCP connection settings only.
`);
}

async function ask(label, defaultValue) {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = defaultValue ? ` [${defaultValue}]` : '';
    const answer = (await prompt.question(`${label}${suffix}: `)).trim();
    return answer || defaultValue || '';
  } finally {
    prompt.close();
  }
}

async function askSecret(label) {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error('The setup wizard needs an interactive terminal to read tokens privately. Use create --config for a non-interactive setup.');
  }
  readline.emitKeypressEvents(input);
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  process.stdout.write(`${label} (input hidden): `);
  return new Promise((resolve, reject) => {
    let secret = '';
    const finish = (error) => {
      input.removeListener('keypress', onKeypress);
      input.setRawMode(wasRaw ?? false);
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(secret);
    };
    const onKeypress = (character, key = {}) => {
      if (key.ctrl && key.name === 'c') {
        finish(new Error('Setup cancelled.'));
      } else if (key.name === 'return' || key.name === 'enter') {
        finish();
      } else if (key.name === 'backspace') {
        secret = secret.slice(0, -1);
      } else if (character && !key.ctrl && !key.meta) {
        secret += character;
      }
    };
    input.on('keypress', onKeypress);
  });
}

function parseArgs(args) {
  const result = { positionals: [], help: false };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--help' || value === '-h') {
      result.help = true;
    } else if (value === '--config' || value === '--root') {
      const next = args[index + 1];
      if (!next || next.startsWith('--')) throw new Error(`${value} requires a value.`);
      result[value.slice(2)] = next;
      index += 1;
    } else if (value.startsWith('--')) {
      throw new Error(`Unknown option: ${value}`);
    } else {
      result.positionals.push(value);
    }
  }
  return result;
}

function slugify(value) {
  const slug = value.normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug || slug.length > 27) throw new Error(`Workspace name must produce a safe slug of at most 27 characters: ${value}`);
  return slug;
}

function validateEndpoint(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute HTTPS MCP URL.`);
  }
  const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !localHttp) {
    throw new Error(`${label} must use HTTPS; HTTP is accepted only for localhost development.`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must not embed credentials, query parameters, or a fragment.`);
  }
  return url.toString();
}

export function validateServeUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute HTTP(S) Serve URL.`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`${label} must use HTTP or HTTPS.`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${label} must not embed credentials, query parameters, or a fragment.`);
  }
  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
}

export function validateWorkspace(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Each workspace config must be an object.');
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) throw new Error('Every workspace needs a non-empty name.');
  if (!raw.wiki || typeof raw.wiki !== 'object') throw new Error(`${name}: wiki endpoint is required.`);
  if (typeof raw.wiki.token !== 'string' || !raw.wiki.token.trim() || /[\r\n]/.test(raw.wiki.token)) throw new Error(`${name}: wiki.token is required and cannot contain line breaks.`);
  const workspace = {
    name,
    slug: raw.slug ? slugify(String(raw.slug)) : slugify(name),
    wiki: {
      url: validateEndpoint(raw.wiki.url, `${name}.wiki.url`),
      token: raw.wiki.token,
    },
  };
  if (raw.serve !== undefined && raw.serve !== null) {
    if (typeof raw.serve !== 'object' || typeof raw.serve.url !== 'string' || !raw.serve.url.trim()) {
      throw new Error(`${name}: serve.url must be an absolute Serve base URL when provided.`);
    }
    workspace.serve = { url: validateServeUrl(raw.serve.url, `${name}.serve.url`) };
  }
  if (raw.production !== undefined && raw.production !== null) {
    if (typeof raw.production !== 'object' || typeof raw.production.token !== 'string' || !raw.production.token.trim() || /[\r\n]/.test(raw.production.token)) {
      throw new Error(`${name}: production must declare url and token, or be omitted.`);
    }
    workspace.production = {
      url: validateEndpoint(raw.production.url, `${name}.production.url`),
      token: raw.production.token,
    };
  }
  return workspace;
}

function quote(text) {
  return JSON.stringify(text);
}

function workspaceBridgePath() {
  const profile = process.env.LLM_WIKI_DSH_PROFILE?.trim() || 'desktop';
  const installedPath = path.join(
    os.homedir(), '.dsh', 'profiles', profile, 'node_modules',
    '@dotdrelle', 'dsh-llm-wiki', 'workspace-mcp-bridge.mjs',
  );
  // The installed package path is a symlink in local development. Preserve it
  // so Node resolves this package's dependencies from the Harness profile.
  return existsSync(installedPath)
    ? installedPath
    : path.join(pluginRoot, 'workspace-mcp-bridge.mjs');
}

function workspaceFiles(workspace, directory) {
  const mcpConfig = {
    servers: {
      [`${workspace.slug}_wiki`]: {
        transport: 'stdio',
        command: process.execPath,
        args: ['--preserve-symlinks-main', workspaceBridgePath()],
        env: { ELECTRON_RUN_AS_NODE: '1' },
        cwd: directory,
        toolCallTimeoutMs: 120_000,
        reconnect: { enabled: true, initialDelayMs: 1000, maxDelayMs: 30_000, maxAttempts: 10 },
      },
    },
  };
  const metadata = {
    schemaVersion: 1,
    name: workspace.name,
    slug: workspace.slug,
    wikiEndpoint: new URL(workspace.wiki.url).origin,
    ...(workspace.serve ? { serveUrl: workspace.serve.url } : {}),
    productionEnabled: Boolean(workspace.production),
  };
  const privateConfig = {
    wiki: workspace.wiki,
    ...(workspace.serve ? { serve: workspace.serve } : {}),
    ...(workspace.production ? { production: workspace.production } : {}),
  };
  const starter = [
    `# ${workspace.name} — wiki distant`,
    '',
    'Ce workspace Harness est un point d’accès au workspace wiki distant.',
    `Cible distante fixe : ${workspace.wiki.url}`,
    'Pour les tâches wiki dans cette conversation, utilise uniquement les outils MCP de ce workspace Harness. Cette URL et le jeton stocké localement déterminent le wiki cible; ne demande pas de choisir un workspace dans le registre wiki-manager et ne bascule pas vers un autre wiki. Le jeton est un secret et ne doit jamais être affiché.',
    'La configuration de ce profil ne change pas automatiquement le workspace Harness courant : utilise une conversation ouverte dans ce dossier pour que ses outils MCP soient actifs.',
    'Les documents, templates, règles de build et livrables restent sur le serveur; ce dossier ne contient que la configuration MCP.',
    '',
    'Outils disponibles dans Donna : lecture du wiki, du build-context, des templates et des livrables; liens cliquables vers Serve si une URL Serve est configurée; avec un endpoint production, lancement de build, export et polish.',
    '',
    'Utilise les outils MCP de ce workspace pour consulter les documents. Ne lis pas le wiki distant avec le shell ou les outils filesystem.',
    '',
  ].join('\n');
  const gitignore = [
    '/.dsh/llm-wiki-mcp.json',
    '/.dsh/mcp.servers.yml',
    '',
  ].join('\n');
  return {
    '.dsh/mcp.servers.yml': `${JSON.stringify(mcpConfig, null, 2)}\n`,
    '.dsh/llm-wiki-mcp.json': `${JSON.stringify(privateConfig, null, 2)}\n`,
    '.dsh/llm-wiki-workspace.json': `${JSON.stringify(metadata, null, 2)}\n`,
    '.gitignore': gitignore,
    'README.md': starter,
  };
}

export async function writeWorkspace(workspace, root = defaultRoot) {
  const directory = path.join(root, workspace.slug);
  await mkdir(root, { recursive: true, mode: 0o700 });
  try {
    await access(directory);
    throw new Error(`Refusing to overwrite existing workspace: ${directory}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const stage = await mkdtemp(path.join(root, `.${workspace.slug}-`));
  try {
    const dshDir = path.join(stage, '.dsh');
    await mkdir(dshDir, { mode: 0o700 });
    const files = workspaceFiles(workspace, directory);
    for (const [relative, content] of Object.entries(files)) {
      const target = path.join(stage, relative);
      await writeFile(target, content, { mode: 0o600, flag: 'wx' });
      await chmod(target, 0o600);
    }
    await chmod(stage, 0o700);
    await chmod(dshDir, 0o700);
    await rename(stage, directory);
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
  return directory;
}

export async function createWorkspaceProfile(raw, root = defaultRoot) {
  const workspace = validateWorkspace(raw);
  const directory = await writeWorkspace(workspace, root);
  return { workspace, directory };
}

async function readWorkspaces(configPath) {
  const parsed = JSON.parse(await readFile(path.resolve(configPath), 'utf8'));
  const entries = Array.isArray(parsed) ? parsed : parsed?.workspaces ?? [parsed];
  if (!Array.isArray(entries)) throw new Error('Config must be a workspace object, an array, or {"workspaces": [...]}');
  return entries.map(validateWorkspace);
}

async function create(args) {
  if (!args.config) throw new Error('create requires --config <private-json-file>.');
  const workspaces = await readWorkspaces(args.config);
  const root = path.resolve(args.root ?? process.env.LLM_WIKI_DSH_WORKSPACE_ROOT ?? defaultRoot);
  await createWorkspaces(workspaces, root);
}

async function createWorkspaces(workspaces, root) {
  const slugs = new Set();
  for (const workspace of workspaces) {
    if (slugs.has(workspace.slug)) throw new Error(`Duplicate workspace slug: ${workspace.slug}`);
    slugs.add(workspace.slug);
  }
  for (const workspace of workspaces) {
    try {
      await access(path.join(root, workspace.slug));
      throw new Error(`Refusing to overwrite existing workspace: ${path.join(root, workspace.slug)}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  const created = [];
  for (const workspace of workspaces) created.push([workspace.name, await writeWorkspace(workspace, root)]);
  for (const [name, directory] of created) process.stdout.write(`${name}\t${directory}\n`);
  process.stdout.write(`\nAdd these local folders as Harness Workspaces. The per-workspace MCP loader must be installed; see the plugin README. No wiki documents were copied.\n`);
}

async function setup() {
  process.stdout.write('Create a DeepSeek Harness workspace connected to one remote llm-wiki workspace.\n');
  const name = await ask('Workspace name');
  const wikiUrl = await ask('Wiki MCP HTTPS URL');
  const wikiToken = await askSecret('Wiki read token');
  const serveUrl = await ask('Serve HTTP(S) URL');
  const enableProduction = /^(y|yes|oui|o)$/i.test(await ask('Enable build/export/polish actions? (y/N)', 'N'));
  const workspace = { name, wiki: { url: wikiUrl, token: wikiToken }, serve: { url: serveUrl } };
  if (enableProduction) {
    workspace.production = {
      url: await ask('Production MCP HTTPS URL'),
      token: await askSecret('Production write token'),
    };
  }
  const root = path.resolve(await ask('Local Harness workspace folder', process.env.LLM_WIKI_DSH_WORKSPACE_ROOT ?? defaultRoot));
  await createWorkspaces([validateWorkspace(workspace)], root);
}

export async function listWorkspaces(root = defaultRoot) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const workspaces = [];
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    try {
      const metadataPath = path.join(root, entry.name, '.dsh/llm-wiki-workspace.json');
      const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
      workspaces.push({ ...metadata, path: path.join(root, entry.name) });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return workspaces;
}

async function list(args) {
  const root = path.resolve(args.root ?? process.env.LLM_WIKI_DSH_WORKSPACE_ROOT ?? defaultRoot);
  const workspaces = await listWorkspaces(root);
  for (const workspace of workspaces) {
    process.stdout.write(`${workspace.name}\t${workspace.path}\t${workspace.productionEnabled ? 'production enabled' : 'read only'}\n`);
  }
  if (!workspaces.length) process.stdout.write(`No generated workspaces in ${root}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  const [command] = args.positionals;
  if (command === 'setup') return setup();
  if (command === 'create') return create(args);
  if (command === 'list') return list(args);
  usage();
  if (command) throw new Error(`Unknown command: ${command}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`llm-wiki workspace helper: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
