import 'dotenv/config';
import { appendFileSync, mkdirSync } from 'node:fs';
import { JUPITER_API_BASE, jupQuote, MINTS, nowIso, sleep } from './lib.js';

// V4 / depth cron: Jupiter buy-side price impact at four notionals for the DEX-routed legs.
// Appends JSONL to data/depth/YYYY-MM-DD.jsonl (imported into depth_observations in D4-PM).
// Runs every 15 min via launchd (scripts/launchd/com.colosseum.depth-snapshot.plist) through Oct 12.
const LEGS: Array<[keyof typeof MINTS, string]> = [
  ['SPYx', 'spyx'],
  ['QQQx', 'qqqx'],
  ['USDY', 'usdy'],
  ['syrupUSDC', 'syrupusdc'],
];
const NOTIONALS_USD = [50, 500, 5_000, 50_000];
const day = new Date().toISOString().slice(0, 10);
mkdirSync('data/depth', { recursive: true });
const file = `data/depth/${day}.jsonl`;
let rows = 0;
for (const [sym, assetId] of LEGS) {
  for (const usd of NOTIONALS_USD) {
    const q = await jupQuote(MINTS.USDC, MINTS[sym], BigInt(usd) * 1_000_000n);
    const row = {
      assetId,
      side: 'buy',
      notionalUsd: usd,
      priceImpactPct: q.status === 200 ? Number(q.body.priceImpactPct) : null,
      outAmount: q.status === 200 ? String(q.body.outAmount) : null,
      routes:
        q.status === 200 ? ((q.body.routePlan as unknown[] | undefined)?.length ?? null) : null,
      error: q.status === 200 ? null : `${q.status} ${String(q.body.error ?? '')}`.trim(),
      source: `${JUPITER_API_BASE}/quote`,
      method: 'jupiter_quote_exact_in_usdc',
      fetchedAt: nowIso(),
      provenance: 'live',
    };
    appendFileSync(file, `${JSON.stringify(row)}\n`);
    rows++;
    await sleep(1300);
  }
}
console.log(
  JSON.stringify({
    id: 'V4',
    item: 'xStocks depth snapshot',
    status: 'pass',
    how: 'scripts/depth-snapshot.ts',
    value: { file, rows },
    fetchedAt: nowIso(),
  }),
);
