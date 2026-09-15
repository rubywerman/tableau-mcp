import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Ok } from 'ts-results-es';
import { z } from 'zod';

import { useRestApi } from '../../../restApiInstance.js';
import { WebMcpServer } from '../../../server.web.js';
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
      'Knowledge graph ID. Ask the user for it if not already known; do not omit it to default to the active graph.',
    ),
  query: z
    .string()
    .trim()
    .min(1)
    .describe(
      'The business question or entity to ground, in natural language (e.g. "AOV of Sales Cloud"). Resolved to a graph node unless nodeId is given.',
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
      "Looks up the trusted, curated definitions and relationships in a Tableau Cloud knowledge graph to ground an answer to a business question — one call that resolves the referenced entity and returns the governed business preferences that apply to it. Use this first for governed terms, metrics, formulas, and definitions, in preference to search-content or list-datasources (which find raw assets) and get-datasource-metadata (technical metadata for an already-chosen datasource). Pass a natural-language query; the tool resolves it to a node. If two candidates share the same name and type it cannot safely choose, so it returns them under resolution 'ambiguous' — pick one and call again with its exact nodeId. Returned business preferences are labeled: subtype 'user-authored' preferences are TK's own and were NOT permission-checked against the underlying data (permissionChecked false), so a definition can come back for data the user cannot otherwise see; 'tableau-managed' preferences are permissionChecked. Global preferences are graph-wide, not specific to the resolved node — do not report a global definition as belonging to the named source. If attachedComplete is false the attached list may be incomplete (a permission-gated preference was withheld), so do not assert the node has none. If resolution is 'no_match', say so plainly; do not invent a definition.",
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

                // Entity lane: a 404 (absent, or the caller can't VIEW it) degrades the
                // entity field but does not abort — the graph-global answer may still stand.
                let entity = null;
                try {
                  entity = slimEntity(await km.getKnowledgeNode({ graphId: args.graphId, nodeId }));
                } catch {
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
                      args.query,
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
                  businessPreferences: [...attached, ...global],
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
