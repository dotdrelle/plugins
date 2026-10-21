#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { assertPluginVersions } from './check-versions.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
assertPluginVersions();
const staging = join(root, '.mcpb-staging');
const output = join(root, 'dist', 'llm-wiki-claude.mcpb');

rmSync(staging, { recursive: true, force: true });
mkdirSync(join(root, 'dist'), { recursive: true });
cpSync(join(root, 'mcpb', 'manifest.json'), join(staging, 'manifest.json'));
mkdirSync(join(staging, 'servers'), { recursive: true });
cpSync(join(root, 'servers', 'llm-wiki-mcp.sh'), join(staging, 'servers', 'llm-wiki-mcp.sh'));
mkdirSync(join(staging, 'bin'), { recursive: true });
cpSync(join(root, 'bin', 'llm-wiki-connect.mjs'), join(staging, 'bin', 'llm-wiki-connect.mjs'));
rmSync(output, { force: true });
execFileSync('zip', ['-q', '-r', output, 'manifest.json', 'servers', 'bin'], { cwd: staging });
rmSync(staging, { recursive: true, force: true });

if (!existsSync(output)) throw new Error(`MCPB was not created: ${output}`);
console.log(output);
