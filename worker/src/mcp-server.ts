/**
 * Public Pegma composition MCP server (stateless).
 *
 * Tools return catalog facts only — no private data plane, no auth for reads.
 * Hosted on pegma-dev-api at POST/GET /api/mcp (Streamable HTTP).
 */

import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { z } from 'zod';
import {
  CAPABILITY_TAGS,
  getComponent,
  getRecipe,
  listComponents,
  listRecipes,
  planComposition,
  type PlanCompositionInput,
} from '../../src/data/mcp-tools';
import {
  fetchCompositionCatalog,
  type CatalogFetchEnv,
} from './mcp-catalog-fetch';

const capabilityTagSchema = z.enum(
  CAPABILITY_TAGS as unknown as [string, ...string[]],
);

function jsonText(value: unknown): { content: [{ type: 'text'; text: string }] } {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function errorText(message: string): {
  content: [{ type: 'text'; text: string }];
  isError: true;
} {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

/**
 * Build a fresh MCP server bound to a catalog loader.
 * createMcpHandler requires a factory (new server per request).
 */
export function createPegmaCatalogMcpServer(
  loadCatalog: () => Promise<Awaited<ReturnType<typeof fetchCompositionCatalog>>>,
): McpServer {
  const server = new McpServer({
    name: 'pegma-catalog',
    version: '1.0.0',
  });

  server.registerTool(
    'list_components',
    {
      description:
        'List Pegma composition catalog components (id, summary, status, packages). Progressive disclosure — use get_component for owns/refuses/deps/adapters.',
      inputSchema: {},
    },
    async () => {
      try {
        const catalog = await loadCatalog();
        return jsonText({
          schemaVersion: catalog.schemaVersion,
          generatedAt: catalog.generatedAt,
          components: listComponents(catalog),
        });
      } catch (error) {
        return errorText(
          `Failed to load catalog: ${error instanceof Error ? error.message : 'unknown'}`,
        );
      }
    },
  );

  server.registerTool(
    'get_component',
    {
      description:
        'Full catalog entry for one component: owns, refuses, dependencies, adapters, hostMustProvide, packages, links.',
      inputSchema: {
        id: z.string().min(1).describe('Catalog component id (e.g. identity, storage-core)'),
      },
    },
    async ({ id }) => {
      try {
        const catalog = await loadCatalog();
        const component = getComponent(catalog, id);
        if (!component) {
          return errorText(`Unknown component id: ${id}`);
        }
        return jsonText({
          schemaVersion: catalog.schemaVersion,
          generatedAt: catalog.generatedAt,
          component,
        });
      } catch (error) {
        return errorText(
          `Failed to load catalog: ${error instanceof Error ? error.message : 'unknown'}`,
        );
      }
    },
  );

  server.registerTool(
    'list_recipes',
    {
      description:
        'List synthetic composition recipes (id, intent, packages, fixture status). Use get_recipe for full metadata and fixture citation.',
      inputSchema: {},
    },
    async () => {
      try {
        const catalog = await loadCatalog();
        return jsonText({
          schemaVersion: catalog.schemaVersion,
          generatedAt: catalog.generatedAt,
          recipes: listRecipes(catalog),
        });
      } catch (error) {
        return errorText(
          `Failed to load catalog: ${error instanceof Error ? error.message : 'unknown'}`,
        );
      }
    },
  );

  server.registerTool(
    'get_recipe',
    {
      description:
        'Full recipe: intent, packages, adapters, host responsibilities, anti-patterns, fixture citation. Synthetic intents only.',
      inputSchema: {
        id: z.string().min(1).describe('Catalog recipe id (e.g. cf-passkey-accounts)'),
      },
    },
    async ({ id }) => {
      try {
        const catalog = await loadCatalog();
        const recipe = getRecipe(catalog, id);
        if (!recipe) {
          return errorText(`Unknown recipe id: ${id}`);
        }
        return jsonText({
          schemaVersion: catalog.schemaVersion,
          generatedAt: catalog.generatedAt,
          recipe,
        });
      } catch (error) {
        return errorText(
          `Failed to load catalog: ${error instanceof Error ? error.message : 'unknown'}`,
        );
      }
    },
  );

  server.registerTool(
    'plan_composition',
    {
      description:
        'Deterministic package/recipe recommendation from structured capabilityTags and optional host. Rule-based over the catalog — not an LLM. Prefer productionOnly=true for real hosts.',
      inputSchema: {
        capabilityTags: z
          .array(capabilityTagSchema)
          .describe('Structured capability tags from the catalog schema'),
        host: z
          .enum(['cloudflare', 'azure', 'memory', 'other'])
          .optional()
          .describe('Hosting surface to prefer for adapters'),
        productionOnly: z
          .boolean()
          .optional()
          .describe(
            'When true (default), skip unpublished components and incomplete recipes',
          ),
      },
    },
    async (args) => {
      try {
        const catalog = await loadCatalog();
        const input: PlanCompositionInput = {
          capabilityTags: args.capabilityTags as PlanCompositionInput['capabilityTags'],
          host: args.host,
          productionOnly: args.productionOnly,
        };
        return jsonText(planComposition(catalog, input));
      } catch (error) {
        return errorText(
          `Failed to plan composition: ${error instanceof Error ? error.message : 'unknown'}`,
        );
      }
    },
  );

  return server;
}

/** Stable Streamable HTTP handler for /api/mcp. */
export function createPegmaMcpHandler(env: CatalogFetchEnv = {}) {
  return createMcpHandler(
    () =>
      createPegmaCatalogMcpServer(() => fetchCompositionCatalog(env)),
    {
      route: '/api/mcp',
      // Custom domain; Origin-less agent clients remain valid.
      allowedHostnames: ['pegma.dev', 'localhost', '127.0.0.1'],
      // Public catalog facts only — no private data plane.
      corsOptions: {
        origin: '*',
        methods: 'GET, POST, OPTIONS',
        headers: 'Content-Type, Accept, MCP-Protocol-Version, MCP-Session-Id',
      },
    },
  );
}
