// `pnpm risk:assets-bars-check <solana|robinhood>` (PLAN-ASSETS AS.7): the bars against risk_pool_flow. For
// every flow row of the chain (a pool, a regime or 'all', a window of 24 h, 7 d or 28 d ending at its
// data_to), the pool's bars of that window and regime are summed and compared: swaps, sales, purchases and
// unpriced swaps must be equal; the sale and purchase dollars equal, or within the summation error of float
// arithmetic (`withinRounding`), never a wider tolerance. A row that differs is listed with its cause where
// the check can show one:
//   swaps_without_side       (Robinhood) the flow import counts a v4 swap that logged nothing going in as
//                            an unpriced purchase; the bars leave it out of the sides (detail.swapsWithoutSide).
//                            The cause is shown when adding them back makes the row equal.
//   sides_of_a_pool_without_quote_decimals  (Robinhood) the flow import counts every swap of a pool whose
//                            quote decimals the issuer registry does not give as an unpriced purchase; the
//                            bars take each swap's side from the signs of its amounts (the count and the
//                            unpriced swaps are the same).
//   history_extended_after_import  (Solana) the row was imported before history-extend.ts (Oct 6) added
//                            transactions to the files: rebuilt in memory from only the transactions each
//                            pool had before the extension (extend.jsonl's storedNewest), the bars equal it.
//   hourly_prices_rebuilt    (Solana) as of that import the swaps and their sides are equal, the unpriced
//                            swaps or the dollars are not: the hourly file the import priced with was
//                            rewritten since (the reconstruction of Oct 6).
//   unexplained              anything else.
// Read-only on the database. The full list goes to <ASSETS_DATA_DIR>/<chain>/bars-check-<stamp>.json.
import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDb, marketBars, riskPoolFlow } from '@colosseum/db';
import {
  BARS_METHOD_VERSION,
  type CheckBar,
  type CheckFlowRow,
  type CheckResult,
  checkFlowRow,
  compareSums,
  type FlowWindow,
  type Regime,
} from '@colosseum/risk';
import { and, eq, like, ne } from 'drizzle-orm';
import { solanaMeta, solanaPoolBars, solanaRegime } from './bars-read';

const chain = process.argv[2];
if (chain !== 'solana' && chain !== 'robinhood') {
  console.error('usage: pnpm risk:assets-bars-check <solana|robinhood>');
  process.exit(1);
}
const SOURCE_PREFIX = chain === 'solana' ? 'Step 5b history%' : 'Robinhood Chain Swap events%';
const t0 = Date.now();
const { db, client } = createDb();
const flow = await db.select().from(riskPoolFlow).where(like(riskPoolFlow.source, SOURCE_PREFIX));
const barRows = await db
  .select({
    pool: marketBars.pool,
    hour: marketBars.hour,
    swaps: marketBars.swaps,
    buySwaps: marketBars.buySwaps,
    sellSwaps: marketBars.sellSwaps,
    unpricedSwaps: marketBars.unpricedSwaps,
    buyVolumeUsd: marketBars.buyVolumeUsd,
    sellVolumeUsd: marketBars.sellVolumeUsd,
    detail: marketBars.detail,
  })
  .from(marketBars)
  .where(
    and(
      eq(marketBars.chain, chain),
      eq(marketBars.methodVersion, BARS_METHOD_VERSION),
      ne(marketBars.pool, 'asset'),
    ),
  );
await client.end();

const toCheck = (b: (typeof barRows)[number]): CheckBar => {
  const d = b.detail as { regime: Regime; swapsWithoutSide?: number; regimeFrom?: string };
  return {
    hour: b.hour.toISOString(),
    regime: d.regime,
    swaps: b.swaps,
    buySwaps: b.buySwaps,
    sellSwaps: b.sellSwaps,
    unpricedSwaps: b.unpricedSwaps,
    buyVolumeUsd: b.buyVolumeUsd,
    sellVolumeUsd: b.sellVolumeUsd,
    swapsWithoutSide: d.swapsWithoutSide ?? 0,
  };
};
const bars = new Map<string, CheckBar[]>();
let regimeFromSwap = 0;
for (const b of barRows) {
  const l = bars.get(b.pool) ?? [];
  l.push(toCheck(b));
  bars.set(b.pool, l);
  if ((b.detail as { regimeFrom?: string }).regimeFrom === 'first_swap_read') regimeFromSwap++;
}
const asRow = (f: (typeof flow)[number]): CheckFlowRow => ({
  regime: f.regime as Regime | 'all',
  window: f.window as FlowWindow,
  dataTo: f.dataTo.toISOString(),
  swaps: f.swaps,
  sellSwaps: f.sellSwaps,
  buySwaps: f.buySwaps,
  unpricedSwaps: f.unpricedSwaps,
  sellUsd: f.sellUsd,
  buyUsd: f.buyUsd,
});

// Solana: the bars as an earlier import could have read them, built in memory on demand
const dataDir = join(process.env.RISK_DATA_DIR ?? 'data/risk', 'history-full');
const asOfImport = new Map<string, CheckBar[]>();
let storedNewest: Map<string, number> | null = null;
let meta: Awaited<ReturnType<typeof solanaMeta>> | null = null;
async function barsBeforeExtension(pool: string): Promise<CheckBar[] | null> {
  if (chain !== 'solana') return null;
  if (!storedNewest) {
    storedNewest = new Map();
    const text = readFileSync(join(dataDir, 'extend.jsonl'), 'utf8');
    for (const l of text.split('\n')) {
      if (!l) continue;
      const r = JSON.parse(l) as { pool?: string; storedNewest?: string };
      // the first run that extended the pool names its newest stored transaction before any extension
      if (r.pool && r.storedNewest && !storedNewest.has(r.pool))
        storedNewest.set(r.pool, Date.parse(r.storedNewest) / 1000);
    }
    meta = await solanaMeta(dataDir);
  }
  const have = asOfImport.get(pool);
  if (have) return have;
  const until = storedNewest.get(pool);
  const m = meta?.find((x) => x.address === pool);
  if (until === undefined || !m) return null;
  const got = solanaPoolBars(dataDir, m, solanaRegime(), until).bars.map((b) => ({
    hour: b.hour,
    regime: b.regime,
    swaps: b.swaps,
    buySwaps: b.buySwaps,
    sellSwaps: b.sellSwaps,
    unpricedSwaps: b.unpricedSwaps,
    buyVolumeUsd: b.buyVolumeUsd,
    sellVolumeUsd: b.sellVolumeUsd,
    swapsWithoutSide: b.swapsWithoutSide,
  }));
  asOfImport.set(pool, got);
  return got;
}

type Out = {
  pool: string;
  regime: string;
  window: string;
  dataTo: string;
  status: CheckResult['status'];
  cause: string | null;
  diffs: CheckResult['diffs'];
  asOfImport?: { status: CheckResult['status']; diffs: CheckResult['diffs'] };
};
const results: Out[] = [];
for (const f of flow) {
  const row = asRow(f);
  const r = checkFlowRow(bars.get(f.pool) ?? [], row);
  let cause: string | null = null;
  let asOf: Out['asOfImport'];
  if (r.status === 'differs') {
    const s = r.sums;
    // the flow import counts every swap of a pool whose quote decimals it lacks as an unpriced purchase
    const allBuys = {
      ...s,
      swaps: s.swaps + s.swapsWithoutSide,
      buySwaps: s.buySwaps + s.sellSwaps + s.swapsWithoutSide,
      sellSwaps: 0,
      unpricedSwaps: s.unpricedSwaps + s.swapsWithoutSide,
    };
    if (r.explainedBySwapsWithoutSide) cause = 'swaps_without_side';
    else if (chain === 'robinhood' && Object.keys(compareSums(row, allBuys).diffs).length === 0)
      cause = 'sides_of_a_pool_without_quote_decimals';
    else {
      const before = await barsBeforeExtension(f.pool);
      if (before) {
        const r2 = checkFlowRow(before, row);
        asOf = { status: r2.status, diffs: r2.diffs };
        // the same swaps and sides: what differs is which hours had a price, and at what
        const countsEqual = !['swaps', 'sellSwaps', 'buySwaps'].some((k) => k in r2.diffs);
        cause =
          r2.status !== 'differs'
            ? 'history_extended_after_import'
            : countsEqual
              ? 'hourly_prices_rebuilt'
              : 'unexplained';
      } else cause = 'unexplained';
    }
  }
  results.push({
    pool: f.pool,
    regime: f.regime,
    window: f.window,
    dataTo: row.dataTo,
    status: r.status,
    cause,
    diffs: r.diffs,
    ...(asOf ? { asOfImport: asOf } : {}),
  });
}

const groups = new Map<string, Record<string, number>>();
for (const r of results) {
  const k = `${r.dataTo} ${r.window}`;
  const g = groups.get(k) ?? { rows: 0, exact: 0, float_rounding: 0, differs: 0 };
  g.rows = (g.rows ?? 0) + 1;
  g[r.status] = (g[r.status] ?? 0) + 1;
  if (r.cause) g[r.cause] = (g[r.cause] ?? 0) + 1;
  groups.set(k, g);
}
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13);
const outDir = join(process.env.ASSETS_DATA_DIR ?? 'data/assets', chain);
mkdirSync(outDir, { recursive: true });
const file = join(outDir, `bars-check-${stamp}.json`);
const totals = results.reduce<Record<string, number>>((a, r) => {
  a[r.status] = (a[r.status] ?? 0) + 1;
  if (r.cause) a[r.cause] = (a[r.cause] ?? 0) + 1;
  return a;
}, {});
const report = {
  chain,
  checkedAt: new Date().toISOString(),
  methodVersion: BARS_METHOD_VERSION,
  flowRows: flow.length,
  pools: new Set(flow.map((f) => f.pool)).size,
  poolsWithoutBars: [...new Set(flow.map((f) => f.pool))].filter((p) => !bars.has(p)),
  bars: barRows.length,
  barsRegimeFromFirstSwap: regimeFromSwap,
  totals,
  byDataToAndWindow: Object.fromEntries(groups),
  differing: results.filter((r) => r.status === 'differs'),
};
writeFileSync(file, JSON.stringify(report, null, 1));
console.table(Object.fromEntries(groups));
const sample = report.differing.slice(0, 12).map((r) => ({
  pool: r.pool.slice(0, 10),
  regime: r.regime,
  window: r.window,
  dataTo: r.dataTo.slice(0, 16),
  cause: r.cause,
  diffs: JSON.stringify(r.diffs).slice(0, 160),
}));
if (sample.length) console.table(sample);
console.log(
  JSON.stringify({
    chain,
    flowRows: report.flowRows,
    pools: report.pools,
    poolsWithoutBars: report.poolsWithoutBars.length,
    bars: report.bars,
    barsRegimeFromFirstSwap: regimeFromSwap,
    totals,
    report: file,
    seconds: Math.round((Date.now() - t0) / 1000),
  }),
);
