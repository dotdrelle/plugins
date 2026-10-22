import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';
import { createWorkspaceProfile, defaultRoot, listWorkspaces, validateServeUrl } from './workspace.mjs';

export const name = 'llm-wiki-dsh-paths';

export const Config = z.object({
  serveUrl: z.string().pattern(/^(?:https?:\/\/.+)?$/i).default('').volatile().description({
    en: 'HTTP(S) URL opened by the Llm-wiki entries in the left and right sidebars.',
    fr: 'URL HTTP(S) ouverte par les entrées Llm-wiki dans les panneaux latéraux gauche et droit.',
  }),
});

const packageRoot = dirname(fileURLToPath(import.meta.url));

export function apply(ctx, config) {
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

  ctx.inject(['connection', 'workspaceRegistry'], (workspaceCtx) => {
    const register = (method, handler) => workspaceCtx.effect(
      () => workspaceCtx.connection.fetch.register({
        path: `/api/llmWikiWorkspace/${method}`,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          let message;
          try {
            message = await request.json();
          } catch {
            return new Response('invalid JSON-RPC request', { status: 400 });
          }
          if (message?.type !== 'client-request'
            || typeof message.rpcId !== 'string'
            || message.method !== `llmWikiWorkspace/${method}`) {
            return new Response('invalid workspace RPC envelope', { status: 400 });
          }
          let result;
          try {
            result = { ok: true, value: await handler(message.payload) };
          } catch (error) {
            result = {
              ok: false,
              error: {
                code: 'workspace-request-failed',
                message: error instanceof Error ? error.message : String(error),
                details: {},
              },
            };
          }
          return Response.json({ type: 'server-response', rpcId: message.rpcId, result });
        },
      }),
      `llm-wiki Harness workspace ${method} route`,
    );

    register('list', async () => ({ workspaces: await listWorkspaces(defaultRoot) }));
    register('serveUrl', async () => {
      const value = config.serveUrl.get();
      return { url: value ? validateServeUrl(value, 'llm-wiki Serve URL') : '' };
    });
    register('create', async (payload) => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('Workspace form data is required.');
      }
      const { workspace, directory } = await createWorkspaceProfile(payload, defaultRoot);
      try {
        await workspaceCtx.workspaceRegistry.create(directory, workspace.name);
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
      return {
        name: workspace.name,
        slug: workspace.slug,
        path: directory,
        productionEnabled: Boolean(workspace.production),
        mcpLoaderRequired: true,
      };
    });
  });
}
