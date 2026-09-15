import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Ok } from 'ts-results-es';
import { z } from 'zod';

import { useRestApi } from '../../../restApiInstance.js';
import { WebMcpServer } from '../../../server.web.js';
import { getHttpStatus } from '../../../utils/getHttpStatus.js';
import { WebTool } from '../tool.js';
import {
  decideResolution,
  labelPreferences,
  rankAndCapGlobal,
  slimEntity,
} from './queryKnowledgeContextUtils.js';

const DEFAULT_GLOBAL_CAP = 10;
const MAX_GLOBAL_CAP = 100;

const paramsSchema = {
  graphId: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,128}$/)
    .refine((value) => value !== '.' && value !== '..')
    .optional()
    .describe(
      "Knowledge graph ID. Omit to use the site's primary graph; pass one only to target a non-default graph.",
    ),
  query: z
    .string()
    .trim()
    .min(1)
    .describe(
      'The business question or entity to ground, in natural language. Resolved to a graph node unless nodeId is given.',
    ),
  term: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      'The specific concept or metric being asked about, used to rank graph-wide preferences (e.g. "AOV" for the question "what is the AOV of Sales Cloud"). Defaults to the full query, which is noisier; pass the bare term when the query names an entity too.',
    ),
  nodeId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Exact node ID from a prior result. Skips resolution and grounds on it directly.'),
  includeGlobal: z
    .boolean()
    .optional()
    .describe(
      'Include graph-wide business preferences, not just ones on the resolved node. Defaults true.',
    ),
  globalLimit: z
    .number()
    .int()
    .positive()
    .max(MAX_GLOBAL_CAP)
    .optional()
    .describe('Max graph-wide preferences returned after relevance ranking. Defaults to 10.'),
};

export const getQueryKnowledgeContextTool = (
  server: WebMcpServer,
): WebTool<typeof paramsSchema> => {
  const tool = new WebTool({
    server,
    name: 'query-knowledge-context',
    description:
      "Answers a business question using your team's curated knowledge graph: the trusted definitions, metrics, and relationships they've vetted, instead of raw Tableau data. Give it a business question, or just the name of an entity to look up. It finds the right node and returns what the graph knows about it. Prefer this over search-content or list-datasources (which find raw assets) and get-datasource-metadata (technical schema for a chosen datasource). If a name matches two things equally well it asks you to pick (resolution 'ambiguous') instead of guessing; call again with the exact nodeId. Each returned definition says where it came from: 'tableau-managed' ones were permission-checked against the source, 'user-authored' ones were not, so they may describe data the user can't otherwise see. 'Global' definitions apply to the whole graph, not just the named entity. If attachedComplete is false, the node's attached list may be missing a permission-gated definition the caller can't see; don't conclude it has none. If nothing matches, it says so; don't invent an answer.",
    paramsSchema,
    annotations: {
      title: 'Query Knowledge Context',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    callback: async (args, extra): Promise<CallToolResult> => {
      const includeGlobal = args.includeGlobal ?? true;
      const configuredLimit = (await extra.getConfigWithOverrides()).getMaxResultLimit(tool.name);
      const globalCap = Math.min(
        args.globalLimit ?? DEFAULT_GLOBAL_CAP,
        configuredLimit ?? MAX_GLOBAL_CAP,
        MAX_GLOBAL_CAP,
      );
      return tool.logAndExecute({
        extra,
        args,
        callback: async () =>
          new Ok(
            await useRestApi({
              ...extra,
              jwtScopes: tool.requiredApiScopes,
              callback: async (restApi) => {
                const km = restApi.knowledgeMethods;

                // Resolve, unless the caller already has an exact node ID.
                let nodeId = args.nodeId;
                let resolution: 'confident' | 'low_confidence' | 'provided' = 'provided';
                if (!nodeId) {
                  const { matches } = await km.searchKnowledgeNodes({
                    graphId: args.graphId,
                    query: args.query,
                  });
                  const decision = decideResolution(matches);
                  if (decision.kind === 'no_match') {
                    return { resolution: 'no_match', query: args.query };
                  }
                  if (decision.kind === 'candidates') {
                    return { resolution: 'ambiguous', candidates: decision.candidates };
                  }
                  nodeId = decision.nodeId;
                  resolution = decision.lowConfidence ? 'low_confidence' : 'confident';
                }

                // Entity lane. A 404 means the node is absent or the caller can't VIEW it —
                // degrade the entity field and let the graph-global answer stand. Any other
                // status (403 request-level auth, 5xx) is a real failure that must surface,
                // not masquerade as "not found".
                let entity = null;
                try {
                  entity = slimEntity(await km.getKnowledgeNode({ graphId: args.graphId, nodeId }));
                } catch (error) {
                  if (getHttpStatus(error as Error) !== '404') throw error;
                  entity = null;
                }

                // Attached lane. An empty result is not proof of "none": a permission-gated
                // tableau-managed preference is postfiltered out for a caller who can't VIEW
                // its source. Only trust "none" when the entity itself was visible.
                const attached = (
                  await km.listSemanticStatements({ graphId: args.graphId, nodeId })
                ).flatMap((node) => labelPreferences(node, 'attached'));
                const attachedComplete = entity !== null;

                // Global lane: runs regardless (exempt user-authored context lives here),
                // degrades to partial on error rather than failing the whole call.
                let global: ReturnType<typeof labelPreferences> = [];
                let groundingStatus: 'complete' | 'partial' = 'complete';
                if (includeGlobal) {
                  try {
                    global = rankAndCapGlobal(
                      await km.listSemanticStatements({ graphId: args.graphId, isGlobal: true }),
                      args.term ?? args.query,
                      globalCap,
                    ).flatMap((node) => labelPreferences(node, 'global'));
                  } catch {
                    groundingStatus = 'partial';
                  }
                }

                return {
                  resolution,
                  entity,
                  attachedComplete,
                  attachedPreferences: attached,
                  globalPreferences: global,
                  groundingStatus,
                  ...(global.length > 0 && {
                    scopeNotice:
                      'Global business preferences are graph-wide, not specific to the resolved node.',
                  }),
                };
              },
            }),
          ),
        constrainSuccessResult: (result) => ({ type: 'success', result }),
      });
    },
  });
  return tool;
};
