#!/usr/bin/env node
// The connector, the .mcpb manifest and the Claude plugin manifest must carry
// one version: they had drifted to 0.4.0 / 0.5.0 / 0.1.0, so nobody could tell
// which package was installed. The connector is read as text — importing it
// would start the CLI.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function pluginVersions() {
  const connector = readFileSync(join(root, 'bin', 'llm-wiki-connect.mjs'), 'utf8')
    .match(/^const CONNECTOR_VERSION = '([^']+)';$/m)?.[1] ?? null;
  const manifest = JSON.parse(readFileSync(join(root, 'mcpb', 'manifest.json'), 'utf8')).version;
  const plugin = JSON.parse(readFileSync(join(root, 'claude-plugin', '.claude-plugin', 'plugin.json'), 'utf8')).version;
  return { connector, manifest, plugin };
}

export function assertPluginVersions() {
  const versions = pluginVersions();
  const distinct = new Set(Object.values(versions));
  if (distinct.size !== 1 || distinct.has(null)) {
    throw new Error(`Versions du plugin divergentes : ${JSON.stringify(versions)}`);
  }
  return versions.manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(assertPluginVersions());
}
