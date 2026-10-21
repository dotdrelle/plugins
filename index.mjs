import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'llm-wiki-dsh-paths';

const packageRoot = dirname(fileURLToPath(import.meta.url));

export function apply(ctx) {
  const bridgePath = resolve(packageRoot, 'readonly-mcp.mjs');
  const connectorPath = resolve(
    process.env.LLM_WIKI_CONNECTOR ||
      resolve(packageRoot, '../claude-desktop/bin/llm-wiki-connect.mjs'),
  );

  if (!existsSync(bridgePath)) {
    throw new Error(`llm-wiki Harness bridge not found: ${bridgePath}`);
  }
  if (!existsSync(connectorPath)) {
    throw new Error(
      `llm-wiki connector not found: ${connectorPath}. Set LLM_WIKI_CONNECTOR to plugins/claude-desktop/bin/llm-wiki-connect.mjs.`,
    );
  }

  ctx.provide('llmWikiDshPaths', { bridgePath, connectorPath });
}
