import { readFileSync } from 'node:fs';
import { createDb } from '@colosseum/db';
import { person, testApp, testIssuer } from '../../apps/api/src/testing/harness';
import {
  type EvalScore,
  type EvalSet,
  evalCounts,
  scoreAnswer,
} from '../../apps/api/src/testing/lookup-eval';

// The eval set of the conversations' lookups, live and in process (API-AGENT-LOOKUPS-2): every /goal
// question of apps/api/src/orders/lookup-eval.json sent through the app as the server builds it from
// this machine's environment (the model, its quota, the chains), signed in by a throwaway test issuer,
// with the asset data read from the local database. The goal route writes nothing. Vault questions need
// a person's vault and are skipped here: `lookup-eval-live.ts` asks them through a running API.
//
// A person runs it once; it spends one reply's model calls per question from the shared quota:
//   pnpm exec tsx --env-file=<the main checkout's .env> scripts/verify/lookup-eval-inprocess.ts
// The asset data is read from the local database, `LOOKUP_EVAL_DATABASE_URL` or this machine's Postgres
// (never the environment's `DATABASE_URL`, which the env file may point at a hosted one with no asset
// data). Each question is asked by a person of its own, so the per-person allowance is not what ends the
// run. It prints counts and, per question, the eval's own id with the kinds of problem: never a reply, a
// figure's id or a value.

const env = process.env as Record<string, string | undefined>;
const set = JSON.parse(
  readFileSync(new URL('../../apps/api/src/orders/lookup-eval.json', import.meta.url), 'utf8'),
) as EvalSet;

const issuer = await testIssuer('lookup-eval');
const { db, client } = createDb(
  process.env.LOOKUP_EVAL_DATABASE_URL ?? 'postgres://colosseum:colosseum@localhost:5433/colosseum',
);
const { app } = await testApp({ issuer: issuer.issuer, db, env });

const scores: EvalScore[] = [];
let skipped = 0;
const statuses: Record<string, number> = {};
for (const question of set.questions) {
  if (question.conversation !== 'goal') {
    skipped += 1;
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
await app.close();
await client.end();
process.exit(counts.failed || counts.passed < counts.questions ? 1 : 0);
