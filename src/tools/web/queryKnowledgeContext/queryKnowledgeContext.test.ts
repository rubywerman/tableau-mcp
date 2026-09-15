import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { useRestApi } from '../../../restApiInstance.js';
import { WebMcpServer } from '../../../server.web.js';
import { Provider } from '../../../utils/provider.js';
import { getMockRequestHandlerExtra } from '../toolContext.mock.js';
import { webToolFactories } from '../tools.js';

const mocks = vi.hoisted(() => ({
  searchKnowledgeNodes: vi.fn(),
  getKnowledgeNode: vi.fn(),
  listSemanticStatements: vi.fn(),
}));

vi.mock('../../../restApiInstance.js', () => ({
  useRestApi: vi.fn().mockImplementation(async ({ callback }) =>
    callback({
      knowledgeMethods: {
        searchKnowledgeNodes: mocks.searchKnowledgeNodes,
        getKnowledgeNode: mocks.getKnowledgeNode,
        listSemanticStatements: mocks.listSemanticStatements,
      },
    }),
  ),
}));

const PDS = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'pds-1',
  name: 'Sales Cloud',
  type: 'PDS',
  properties: {},
  score: 0.9,
  semantic_statements: [],
  ...over,
});

const userAuthoredGlobal = {
  id: 'ctx-aov',
  type: 'SEMANTIC_CONTEXT',
  name: 'AOV',
  properties: {
    statements: [{ id: 's1', statement: 'AOV = revenue / orders' }],
    is_global: true,
    kind: 'statement',
    source: 'mcp',
    updated_at: '2026-01-01T00:00:00Z',
  },
};
const managedAttached = {
  id: 'ctx-ext',
  type: 'SEMANTIC_CONTEXT_EXTERNAL',
  name: 'ARR note',
  properties: { statements: [{ id: 's2', statement: 'ARR reported in USD' }] },
};

function payload(result: CallToolResult): any {
  return JSON.parse((result.content[0] as { text: string }).text);
}

describe('queryKnowledgeContextTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.searchKnowledgeNodes.mockResolvedValue({ matches: [PDS()] });
    mocks.getKnowledgeNode.mockResolvedValue({
      id: 'pds-1',
      name: 'Sales Cloud',
      type: 'PDS',
      properties: {},
      semantic_statements: [],
      connected_nodes: [],
    });
    mocks.listSemanticStatements.mockResolvedValue([]);
  });

  it('is registered read-only with the knowledge read scope', async () => {
    const tool = getTool();
    expect(tool.name).toBe('query-knowledge-context');
    expect(await Provider.from(tool.annotations)).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    await getToolResult({ graphId: 'g1', query: 'AOV of Sales Cloud' });
    expect(vi.mocked(useRestApi)).toHaveBeenCalledWith(
      expect.objectContaining({ jwtScopes: ['tableau:knowledge:read'] }),
    );
  });

  it('commits on a clear winner and grounds on the resolved node', async () => {
    mocks.searchKnowledgeNodes.mockResolvedValue({
      matches: [PDS(), PDS({ id: 'pds-2', name: 'Sales Cloud Opportunities', score: 0.6 })],
    });
    const out = payload(await getToolResult({ graphId: 'g1', query: 'AOV of Sales Cloud' }));
    expect(out.resolution).toBe('confident');
    expect(mocks.getKnowledgeNode).toHaveBeenCalledWith({ graphId: 'g1', nodeId: 'pds-1' });
    expect(out.entity).toEqual({ id: 'pds-1', name: 'Sales Cloud', type: 'PDS' });
  });

  it('returns candidates without grounding when name and type collide', async () => {
    mocks.searchKnowledgeNodes.mockResolvedValue({
      matches: [PDS({ id: 'pds-1' }), PDS({ id: 'pds-9', score: 0.85 })],
    });
    const out = payload(await getToolResult({ graphId: 'g1', query: 'Sales Cloud' }));
    expect(out.resolution).toBe('ambiguous');
    expect(out.candidates.map((c: any) => c.id)).toEqual(['pds-1', 'pds-9']);
    expect(mocks.getKnowledgeNode).not.toHaveBeenCalled();
  });

  it('reports no_match when search returns nothing', async () => {
    mocks.searchKnowledgeNodes.mockResolvedValue({ matches: [] });
    const out = payload(await getToolResult({ graphId: 'g1', query: 'nope' }));
    expect(out.resolution).toBe('no_match');
    expect(mocks.getKnowledgeNode).not.toHaveBeenCalled();
  });

  it('marks attached incomplete when the entity is not visible (404)', async () => {
    mocks.getKnowledgeNode.mockRejectedValue(new Error('404'));
    const out = payload(await getToolResult({ graphId: 'g1', query: 'AOV of Sales Cloud' }));
    expect(out.entity).toBeNull();
    expect(out.attachedComplete).toBe(false);
  });

  it('labels a user-authored global preference as ungated and flags graph-wide scope', async () => {
    mocks.listSemanticStatements.mockImplementation(async ({ isGlobal }: { isGlobal?: boolean }) =>
      isGlobal ? [userAuthoredGlobal] : [],
    );
    const out = payload(await getToolResult({ graphId: 'g1', query: 'AOV' }));
    const aov = out.businessPreferences.find((p: any) => p.text.includes('AOV'));
    expect(aov).toMatchObject({
      subtype: 'user-authored',
      permissionChecked: false,
      scope: 'global',
    });
    expect(out.scopeNotice).toContain('graph-wide');
  });

  it('labels a tableau-managed attached preference as permission-checked', async () => {
    mocks.listSemanticStatements.mockImplementation(async ({ isGlobal }: { isGlobal?: boolean }) =>
      isGlobal ? [] : [managedAttached],
    );
    const out = payload(await getToolResult({ graphId: 'g1', query: 'ARR' }));
    const arr = out.businessPreferences.find((p: any) => p.text.includes('ARR'));
    expect(arr).toMatchObject({
      subtype: 'tableau-managed',
      permissionChecked: true,
      scope: 'attached',
    });
  });

  it('degrades to partial when the global lane errors', async () => {
    mocks.listSemanticStatements.mockImplementation(
      async ({ isGlobal }: { isGlobal?: boolean }) => {
        if (isGlobal) throw new Error('boom');
        return [];
      },
    );
    const out = payload(await getToolResult({ graphId: 'g1', query: 'AOV' }));
    expect(out.groundingStatus).toBe('partial');
  });
});

function getTool(): any {
  const factory = webToolFactories.find(
    (candidate) => candidate.name === 'getQueryKnowledgeContextTool',
  );
  expect(factory, 'getQueryKnowledgeContextTool is not registered').toBeDefined();
  return (factory as (server: WebMcpServer) => any)(new WebMcpServer());
}

async function getToolResult(
  args: any,
  extra = getMockRequestHandlerExtra(),
): Promise<CallToolResult> {
  const tool = getTool();
  return (await Provider.from(tool.callback))(args, extra);
}
