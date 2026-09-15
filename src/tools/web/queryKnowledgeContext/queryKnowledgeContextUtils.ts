import {
  KnowledgeNodeContext,
  SemanticContextNode,
} from '../../../sdks/tableau/apis/knowledgeApi.js';

// Advisory label only — a low top score is surfaced, never used to withhold the
// commit. Resolution ambiguity is decided structurally (see decideResolution).
const LOW_CONFIDENCE_BELOW = 0.5;

export type NodeCandidate = { id: string; name: string; type: string; score: number };

export type Resolution =
  | { kind: 'commit'; nodeId: string; lowConfidence: boolean }
  | { kind: 'candidates'; candidates: NodeCandidate[] }
  | { kind: 'no_match' };

// Search scores are uncalibrated, so a score threshold can't tell a safe winner
// from a coin-flip. A true tie is structural: two matches sharing name AND type
// are indistinguishable to the caller, so hand them back instead of guessing. A
// lone match always commits — there is nothing to disambiguate against — but a
// weak one is flagged so the caller can weigh it.
export function decideResolution(matches: NodeCandidate[]): Resolution {
  if (matches.length === 0) return { kind: 'no_match' };
  const [top, ...rest] = matches;
  const collision = rest.some((m) => m.name === top.name && m.type === top.type);
  if (collision) {
    return {
      kind: 'candidates',
      candidates: matches.filter((m) => m.name === top.name && m.type === top.type),
    };
  }
  return { kind: 'commit', nodeId: top.id, lowConfidence: top.score < LOW_CONFIDENCE_BELOW };
}

export type LabeledPreference = {
  id: string;
  text: string;
  subtype: 'user-authored' | 'tableau-managed';
  // Whether Tableau ran a per-resource VIEW check to return this. False for
  // user-authored context, which TK owns and does not gate — so it can describe
  // data the caller has no VIEW access to. True for Tableau-managed context,
  // which inherits its source's VIEW permission (its presence proves the check).
  permissionChecked: boolean;
  scope: 'attached' | 'global';
};

export function labelPreferences(
  node: SemanticContextNode,
  scope: 'attached' | 'global',
): LabeledPreference[] {
  const managed = node.type === 'SEMANTIC_CONTEXT_EXTERNAL';
  return node.properties.statements.map((s) => ({
    id: s.id,
    text: s.statement,
    subtype: managed ? 'tableau-managed' : 'user-authored',
    permissionChecked: managed,
    scope,
  }));
}

// The server ignores query relevance on the global-context list, so rank here and
// cap what is RETURNED (never what is fetched) — else the answer can sit past the
// cap and vanish. ponytail: lexical overlap; swap for the server's ranking once it has one.
export function rankAndCapGlobal(
  nodes: SemanticContextNode[],
  query: string,
  cap: number,
): SemanticContextNode[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const score = (n: SemanticContextNode): number =>
    n.properties.statements.reduce(
      (hits, s) => hits + terms.filter((t) => s.statement.toLowerCase().includes(t)).length,
      0,
    );
  return [...nodes].sort((a, b) => score(b) - score(a)).slice(0, cap);
}

export function slimEntity(node: KnowledgeNodeContext): { id: string; name: string; type: string } {
  return { id: node.id, name: node.name, type: node.type };
}
