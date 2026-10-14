import { readFileSync } from 'node:fs';
import { createDb } from '@colosseum/db';
import { serverAssetLookups } from '../../apps/api/src/asset-lookups';
import { testApp } from '../../apps/api/src/testing/harness';
import type { EvalSet } from '../../apps/api/src/testing/lookup-eval';

// What the lookups read for the eval's questions, with no model call (API-AGENT-LOOKUPS-2): the chains as
// the server builds them from this machine's environment, the asset data from the local database (as
// `lookup-eval-inprocess.ts` reads it), and for each asset a question names, the four reads the model can
// ask for, each counted: facts served, figures not measured with their reasons, and whether the read was
// late or failed. It spends nothing and prints counts and the reasons only: never a value.
//   pnpm exec tsx --env-file=<the main checkout's .env> scripts/verify/lookup-eval-reads.ts

const env = process.env as Record<string, string | undefined>;
const set = JSON.parse(
  readFileSync(new URL('../../apps/api/src/orders/lookup-eval.json', import.meta.url), 'utf8'),
) as EvalSet;
const { db, client } = createDb(
  process.env.LOOKUP_EVAL_DATABASE_URL ?? 'postgres://colosseum:colosseum@localhost:5433/colosseum',
);
const { app, registry } = await testApp({ issuer: null, db, env });

const named = new Map<string, Set<string>>();
for (const question of set.questions) {
  const text = question.messages.map((m) => m.text).join(' ');
  const ids = named.get(question.chain) ?? new Set<string>();
  ids.add(text);
  named.set(question.chain, ids);
}
for (const chain of ['solana', 'robinhood'] as const) {
  const entry = registry.get(chain);
  if (!entry) {
    console.log(JSON.stringify({ chain, entry: 'none' }));
    continue;
  }
  const listed = await entry.adapter.listAssets();
  const words = [...(named.get(chain) ?? [])].join(' ').toLowerCase();
  // the assets the eval's questions name, by symbol or what they track, and the chain's cash token
  const asked = listed.filter(
    (asset) =>
      asset.cls === 'cash' ||
      [asset.symbol, asset.underlying]
        .filter((name): name is string => Boolean(name))
        .some((name) => words.includes(name.toLowerCase().replace(/^t(?=[A-Z])/u, ''))),
  );
  console.log(
    JSON.stringify({
      chain,
      provenance: entry.provenance,
      listed: listed.length,
      asked: asked.map((asset) => asset.id),
    }),
  );
  for (const asset of asked) {
    const q = { db, chain, asset, provenance: entry.provenance, waitMs: 20_000 };
    const reads = {
      profile: await serverAssetLookups.profile(q),
      price_history_7d: await serverAssetLookups.priceHistory({ ...q, window: '7d' }),
      price_history_24h: await serverAssetLookups.priceHistory({ ...q, window: '24h' }),
      pools: await serverAssetLookups.pools(q),
      lending: await serverAssetLookups.lending(q),
    };
    console.log(
      JSON.stringify({
        asset: asset.id,
        modelledOn: reads.profile.modelledOn,
        ...Object.fromEntries(
          Object.entries(reads).map(([part, answer]) => [
            part,
            {
              facts: answer.facts.length,
              missing: answer.missing.length,
              reasons: [...new Set(answer.missing.map((m) => m.reason))],
              ...(answer.unread ? { unread: answer.unread } : {}),
            },
          ]),
        ),
      }),
    );
  }
}
await app.close();
await client.end();
process.exit(0);
