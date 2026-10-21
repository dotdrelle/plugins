#!/usr/bin/env node

import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { assertPluginVersions } from './check-versions.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
assertPluginVersions();
const source = join(root, 'claude-plugin');
const staging = join(root, '.claude-plugin-staging');
const output = join(root, 'dist', 'llm-wiki.plugin');

rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
mkdirSync(join(root, 'dist'), { recursive: true });
cpSync(join(source, '.claude-plugin'), join(staging, '.claude-plugin'), { recursive: true });
cpSync(join(root, 'skills'), join(staging, 'skills'), { recursive: true });
rmSync(join(staging, 'skills', '.DS_Store'), { force: true });
mkdirSync(join(staging, 'scripts'), { recursive: true });
cpSync(join(root, 'scripts', 'run-wiki-skill.py'), join(staging, 'scripts', 'run-wiki-skill.py'));
rmSync(output, { force: true });
execFileSync('zip', ['-q', '-r', output, '.'], { cwd: staging });
rmSync(staging, { recursive: true, force: true });

if (!existsSync(output)) throw new Error(`Claude plugin was not created: ${output}`);
console.log(output);
