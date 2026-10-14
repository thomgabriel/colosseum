import { readFileSync } from 'node:fs';
import { person } from '../../apps/api/src/testing/harness';
import {
  type EvalScore,
  type EvalSet,
  evalCounts,
  scoreAnswer,
} from '../../apps/api/src/testing/lookup-eval';
import { evalApp } from './lookup-eval-app';

// The eval set of the conversations' lookups, live and in process (API-AGENT-LOOKUPS-2): every /goal
// question of apps/api/src/orders/lookup-eval.json on a chain that runs here for real, sent through the
// app as the server builds it (`lookup-eval-app.ts`: the model and its quota from this machine's
// environment, the chains with the deploys' records, the asset data from the local database). The goal
// route writes nothing. Vault questions need a person's vault and are skipped here: `lookup-eval-live.ts`
// asks them through a running API. A question on a chain on the mock is skipped too: its tokens are
// made up and have no data.
//
// A person runs it once; it spends one reply's model calls per question from the shared quota:
//   CHAIN_MODE_SOLANA=readonly CHAIN_NETWORK_SOLANA=testnet SOLANA_RPC_URL=https://api.devnet.solana.com \
//     pnpm exec tsx --env-file=<the main checkout's .env> scripts/verify/lookup-eval-inprocess.ts
// Each question is asked by a person of its own, so the per-person allowance is not what ends the run. It
// prints counts and, per question, the eval's own id with the kinds of problem: never a reply, a figure's
// id or a value.

const set = JSON.parse(
  readFileSync(new URL('../../apps/api/src/orders/lookup-eval.json', import.meta.url), 'utf8'),
) as EvalSet;
const { app, issuer, real, close } = await evalApp();

const scores: EvalScore[] = [];
const skipped = { vault: 0, mock: 0 };
const statuses: Record<string, number> = {};
for (const question of set.questions) {
  if (question.conversation !== 'goal') {
    skipped.vault += 1;
    continue;
  }
  if (!real(question.chain)) {
    skipped.mock += 1;
    continue;
  }
  const res = await app.inject({
    method: 'POST',
    url: `/v1/conversations/${question.chain}/goal/reply`,
    headers: (await person(issuer, question.chain)).headers,
    payload: { version: 1, language: 'en', messageId: question.id, messages: question.messages },
  });
  statuses[res.statusCode] = (statuses[res.statusCode] ?? 0) + 1;
  scores.push(
    scoreAnswer(question, res.statusCode === 200 ? (res.json() as never) : (null as never)),
  );
}
const counts = evalCounts(scores);
const problems: Record<string, number> = {};
for (const score of scores)
  for (const problem of score.problems) {
    const kind = problem.replace(/^no \w+ figure/u, 'no figure');
    problems[kind] = (problems[kind] ?? 0) + 1;
  }
const byQuestion = Object.fromEntries(
  scores.filter((score) => score.problems.length).map((score) => [score.id, score.problems]),
);
console.log(
  JSON.stringify({ check: 'lookup-eval-inprocess', ...counts, skipped, statuses, problems }),
);
console.log(JSON.stringify({ check: 'lookup-eval-inprocess', byQuestion }));
await close();
process.exit(counts.failed || counts.passed < counts.questions ? 1 : 0);
