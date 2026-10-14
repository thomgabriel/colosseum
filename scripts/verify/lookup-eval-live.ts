import { readFileSync } from 'node:fs';
import {
  type EvalQuestion,
  type EvalScore,
  type EvalSet,
  evalCounts,
  scoreAnswer,
} from '../../apps/api/src/testing/lookup-eval';

// The eval set of the conversations' lookups, live (API-AGENT-LOOKUPS-2): every question of
// apps/api/src/orders/lookup-eval.json sent to a running API, each reply scored as the offline test
// scores it (apps/api/src/testing/lookup-eval.ts). It prints counts only: never a reply, an id or a value.
//
// A person runs it, against a local API (it spends model calls from the API's own quota):
//   API_URL           the API, default http://localhost:3002
//   API_ACCESS_TOKEN  a signed-in session's access token, and API_IDENTITY_TOKEN its identity token,
//                     with a wallet on each chain asked; copied from the browser, never written to a file
//   VAULT_SOLANA, VAULT_ROBINHOOD  a vault of that person on each chain, for the vault questions; a chain
//                     with none skips its vault questions and says how many
// It reads no .env file and writes nothing.

const API_URL = (process.env.API_URL ?? 'http://localhost:3002').replace(/\/+$/u, '');
const access = process.env.API_ACCESS_TOKEN?.trim();
const identity = process.env.API_IDENTITY_TOKEN?.trim();
if (!access || !identity) {
  console.error('Set API_ACCESS_TOKEN and API_IDENTITY_TOKEN from a signed-in session first.');
  process.exit(2);
}
const vaults: Record<EvalQuestion['chain'], string | undefined> = {
  solana: process.env.VAULT_SOLANA?.trim() || undefined,
  robinhood: process.env.VAULT_ROBINHOOD?.trim() || undefined,
};
const set = JSON.parse(
  readFileSync(new URL('../../apps/api/src/orders/lookup-eval.json', import.meta.url), 'utf8'),
) as EvalSet;

async function ask(question: EvalQuestion): Promise<EvalScore | null> {
  const vault = vaults[question.chain];
  if (question.conversation === 'vault' && !vault) return null;
  const path =
    question.conversation === 'goal'
      ? `/v1/conversations/${question.chain}/goal/reply`
      : `/v1/vaults/${question.chain}/${vault}/conversation/reply`;
  const response = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${access}`,
      'privy-id-token': identity as string,
    },
    body: JSON.stringify({
      version: 1,
      language: 'en',
      messageId: question.id,
      messages: question.messages,
    }),
  });
  // a 503 is a failed answer; any other status says the run itself is wrong (sign-in, vault, route)
  if (response.status === 503) return scoreAnswer(question, null);
  if (!response.ok)
    throw new Error(`the API answered ${response.status} on a ${question.conversation} question`);
  return scoreAnswer(question, (await response.json()) as Parameters<typeof scoreAnswer>[1]);
}

const scores: EvalScore[] = [];
let skipped = 0;
for (const question of set.questions) {
  const score = await ask(question);
  if (score) scores.push(score);
  else skipped += 1;
}
const counts = evalCounts(scores);
const problems: Record<string, number> = {};
for (const score of scores)
  for (const problem of score.problems)
    problems[problem.replace(/^no \w+ figure/u, 'no figure')] =
      (problems[problem.replace(/^no \w+ figure/u, 'no figure')] ?? 0) + 1;
console.log(JSON.stringify({ check: 'lookup-eval-live', ...counts, skipped, problems }));
process.exit(counts.failed || counts.passed < counts.questions ? 1 : 0);
