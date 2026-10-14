import { readFileSync } from 'node:fs';
import type { ChainId } from '@colosseum/schemas';
import { evalApp } from './lookup-eval-app';

// What the lookups read for the tokens of each chain that runs here for real, with no model call
// (API-AGENT-LOOKUPS-2): the app as the eval builds it (`lookup-eval-app.ts`), asked through the real
// route `GET /v1/assets/{id}/facts` for every token of the deploys' records, each part counted: facts
// served, figures not measured with their reasons, a read late or failed, and the mainnet token a
// test-network token reads. It spends nothing and prints counts and reasons only: never a value.
//   CHAIN_MODE_SOLANA=readonly CHAIN_NETWORK_SOLANA=testnet SOLANA_RPC_URL=https://api.devnet.solana.com \
//     pnpm exec tsx --env-file=<the main checkout's .env> scripts/verify/lookup-eval-reads.ts

const RECORDS: Record<'solana' | 'robinhood', string> = {
  solana: 'solana-devnet.json',
  robinhood: 'robinhood-mainnet.json',
};
const { app, flags, real, close } = await evalApp();
for (const chain of ['solana', 'robinhood'] as const satisfies readonly ChainId[]) {
  if (!real(chain)) {
    console.log(
      JSON.stringify({ chain, mode: flags.chainMode[chain], skipped: 'not a real chain here' }),
    );
    continue;
  }
  const record = JSON.parse(
    readFileSync(new URL(`../../deployments/${RECORDS[chain]}`, import.meta.url), 'utf8'),
  ) as { assets?: Array<{ id?: string }>; cash?: { id?: string } };
  const ids = [record.cash?.id, ...(record.assets ?? []).map((asset) => asset.id)].filter(
    (id): id is string => Boolean(id),
  );
  console.log(JSON.stringify({ chain, mode: flags.chainMode[chain], tokens: ids.length }));
  for (const id of ids) {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/assets/${encodeURIComponent(id)}/facts?window=24h`,
    });
    if (res.statusCode !== 200) {
      console.log(JSON.stringify({ asset: id, status: res.statusCode }));
      continue;
    }
    const body = res.json() as {
      provenance: string;
      parts: Record<
        string,
        {
          facts: unknown[];
          missing: Array<{ reason: string }>;
          modelledOn: string | null;
          unread?: string;
        }
      >;
    };
    console.log(
      JSON.stringify({
        asset: id,
        provenance: body.provenance,
        modelledOn: Object.values(body.parts).find((part) => part.modelledOn)?.modelledOn ?? null,
        ...Object.fromEntries(
          Object.entries(body.parts).map(([part, answer]) => [
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
await close();
process.exit(0);
