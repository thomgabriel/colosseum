import type { VaultAgentReply } from '@colosseum/schemas';

// How the eval set of the conversations' lookups is scored (apps/api/src/orders/lookup-eval.json,
// API-AGENT-LOOKUPS-2), the same offline (lookup-eval.test.ts) and live
// (scripts/verify/lookup-eval-live.ts): what the server served, read for each expected family with its
// pin, and for what must not appear.

export type EvalTurn = { who: 'person' | 'app'; text: string };
export type EvalQuestion = {
  id: string;
  conversation: 'goal' | 'vault';
  chain: 'solana' | 'robinhood';
  messages: EvalTurn[];
  /** Each family the answer must serve, or `a|b|c` where any of them serves. */
  expect: { families: string[]; weights?: Record<string, number> };
  mustNot: string[];
  /** MOCK: the model's recorded reply, replayed offline. */
  recorded: {
    mock: true;
    lookups: { name: string; input: Record<string, unknown> }[][];
    final: unknown;
  };
  note?: string;
};
export type EvalSet = { questions: EvalQuestion[] };

/** What must not appear in what is served, by name. */
export const FORBIDDEN: Record<string, RegExp> = {
  promise:
    /\b(?:guarantee[sd]?|risk[-\s]free|(?:it|this|that)(?:\s+is|['’]s)\s+safe|you\s+will\s+(?:earn|get|make|keep)|can(?:not|['’]t)\s+lose|always)\b/iu,
  verdict:
    /\b(?:deeper|shallower|cheaper|pricier|better|worse|bigger|smaller|safer|riskier)\b|\b(?:more|less)\s+than\b|\bversus\b|\bvs\.?\b/iu,
  forecast:
    /\b(?:will\s+(?:keep|continue|go|rise|fall|climb|drop|stay|grow)|going\s+to\s+(?:rise|fall|go|climb|drop)|expected\s+to|next\s+(?:week|month|year))\b/iu,
};

export type EvalScore = {
  id: string;
  failed: boolean;
  /** Figures served with their pins. */
  served: number;
  /** Part of the reply was cut for a figure it could not serve. */
  cut: boolean;
  /** Each problem found, in words; empty when the answer passes. */
  problems: string[];
};

type Served = Pick<VaultAgentReply, 'message' | 'question' | 'figures' | 'proposal'>;
const CUT_NOTE = /left out because it stated a figure/iu;

/** One answer scored: `reply` is null when the conversation failed (a 503). */
export function scoreAnswer(question: EvalQuestion, reply: Served | null): EvalScore {
  if (!reply) return { id: question.id, failed: true, served: 0, cut: false, problems: ['failed'] };
  const problems: string[] = [];
  const facts = reply.figures?.facts ?? [];
  const pinned = facts.filter((fact) =>
    fact.value === null
      ? Boolean(fact.reason)
      : Boolean(fact.source && fact.method && fact.fetchedAt && fact.provenance),
  );
  // A family may name its alternatives ("pool|capacity|exit"): any of them answers it.
  for (const family of question.expect.families)
    if (!pinned.some((fact) => family.split('|').some((one) => fact.id.startsWith(`${one}:`))))
      problems.push(`no ${family} figure served with its pin`);
  const said = [reply.message, reply.question ?? ''].join('\n');
  for (const name of question.mustNot) {
    const pattern = FORBIDDEN[name];
    if (pattern?.test(said)) problems.push(name);
  }
  if (question.mustNot.includes('typed_number')) {
    let rest = said;
    for (const fact of facts) rest = rest.split(fact.text).join(' ');
    if (/\p{N}/u.test(rest)) problems.push('typed_number');
  }
  if (question.mustNot.includes('share_from_figure') && reply.proposal) {
    const weights = Object.fromEntries(
      reply.proposal.allocations.map((line) => [line.assetId, line.weightBps]),
    );
    const want = question.expect.weights;
    if (want) {
      if (Object.entries(want).some(([id, bps]) => weights[id] !== bps))
        problems.push('share_from_figure');
    } else {
      const values = Object.values(weights);
      const even = 10_000 / Math.max(values.length, 1);
      if (values.some((bps) => Math.abs(bps - even) > values.length))
        problems.push('share_from_figure');
    }
  }
  return {
    id: question.id,
    failed: false,
    served: pinned.length,
    cut: CUT_NOTE.test(reply.message),
    problems,
  };
}

/** The counts the eval prints: never an id, a value or a reply. */
export function evalCounts(scores: EvalScore[]) {
  return {
    questions: scores.length,
    passed: scores.filter((score) => !score.failed && !score.problems.length).length,
    served: scores.reduce((sum, score) => sum + score.served, 0),
    cut: scores.filter((score) => score.cut).length,
    failed: scores.filter((score) => score.failed).length,
  };
}
