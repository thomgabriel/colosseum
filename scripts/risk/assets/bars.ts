// `pnpm risk:assets-bars <solana|robinhood> [--dry-run]` (PLAN-ASSETS AS.7): hourly bars per pool and per
// token from the swap history both chains already hold, upserted into market_bars under `bars-0.1`. The
// readers are in bars-read.ts (no RPC); the bars are `@colosseum/risk`'s. A second run rewrites the same rows
// (the key is chain, address, pool, hour and method version). --dry-run builds and counts and writes nothing.
//
//   Solana     RISK_DATA_DIR (default data/risk): history-full/events and history-full/hourly, and the pools'
//              metadata from risk_pools
//   Robinhood  RISK_EVM_DIR (default data/risk-evm): history/robinhood (read-only: the live loop's folder),
//              the cut the list names and the newest universe file; RISK_UNIVERSE_DIR for the list
//
// --source backfill (AS.13): the backfill's day files under ASSETS_DATA_DIR instead (bars-backfill.ts), only the
// UTC days its records hold whole. Solana needs --registry <shelf-registry-solana-*.json>; Robinhood Chain reads
// RU.2's creation logs in RISK_EVM_DIR and the shelf of --scope (default: the one shelf scope of fetched.json).
// These rows are inserted, never updated: a row already there (the held history's, or an earlier import's) is
// kept, so a re-run over the same days inserts nothing and a run after the fetch moved on adds the new days.
import 'dotenv/config';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDb, marketBars } from '@colosseum/db';
import { BARS_METHOD_VERSION } from '@colosseum/risk';
import type { AssetList } from '@colosseum/schemas';
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { readRobinhoodBackfill, readSolanaBackfill, solanaRegistryPools } from './bars-backfill';
import { type PoolBars, readRobinhood, readSolana, solanaRegime } from './bars-read';
import { type BarRow, barRows, insertBarsKeep } from './bars-rows';

const args = process.argv.slice(2);
const chain = args.find((a) => !a.startsWith('--'));
const dry = args.includes('--dry-run');
const opt = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const backfill = opt('--source') === 'backfill';
if (
  (chain !== 'solana' && chain !== 'robinhood') ||
  (opt('--source') ?? 'held') !== (backfill ? 'backfill' : 'held')
) {
  console.error(
    'usage: pnpm risk:assets-bars <solana|robinhood> [--dry-run] [--source backfill [--registry <file>] [--scope <key>]]',
  );
  process.exit(1);
}
const t0 = Date.now();
const read: {
  pools: Array<PoolBars & { sourceOf?: (hour: string) => string }>;
  summary: Record<string, unknown>;
} = backfill
  ? readBackfill()
  : chain === 'solana'
    ? await readSolana(process.env.RISK_DATA_DIR ?? 'data/risk')
    : await readRobinhood(
        process.env.RISK_EVM_DIR ?? 'data/risk-evm',
        process.env.RISK_UNIVERSE_DIR ?? 'scripts/risk/universe',
      );

function readBackfill() {
  const dataDir = process.env.ASSETS_DATA_DIR ?? 'data/assets';
  if (chain === 'solana') {
    const registryFile = opt('--registry');
    if (!registryFile)
      throw new Error(
        '--source backfill on solana needs --registry <shelf-registry-solana-*.json>',
      );
    return readSolanaBackfill({
      dataDir,
      registry: solanaRegistryPools(registryFile),
      registryFile,
      regimeOfT: solanaRegime(),
    });
  }
  const evmDir = process.env.RISK_EVM_DIR ?? 'data/risk-evm';
  const fetched = JSON.parse(readFileSync(join(dataDir, 'robinhood', 'fetched.json'), 'utf8')) as {
    covered: Record<string, unknown>;
  };
  const scopes = [
    ...new Set(Object.keys(fetched.covered).map((k) => k.split(':')[1] as string)),
  ].filter((k) => k.startsWith('shelf-'));
  const scope = opt('--scope') ?? (scopes.length === 1 ? scopes[0] : undefined);
  if (!scope) throw new Error(`--scope: one of ${scopes.join(', ') || '(no shelf scope fetched)'}`);
  const countDir = join(dataDir, 'robinhood', 'robinhood-logs');
  const countFile = readdirSync(countDir)
    .filter((f) => f.startsWith('count-'))
    .sort()
    .reverse()
    .map(
      (f) =>
        JSON.parse(readFileSync(join(countDir, f), 'utf8')) as {
          scope?: string;
          scopeOf?: { shelf?: { tokens: Array<{ address: string }> } };
        },
    )
    .find((c) => c.scope === scope);
  const shelf = countFile?.scopeOf?.shelf?.tokens.map((t) => t.address);
  if (!shelf) throw new Error(`no count file of scope ${scope} names its shelf`);
  const creation = JSON.parse(
    readFileSync(join(evmDir, 'creation-logs-robinhood.json'), 'utf8'),
  ) as {
    created: Array<{ kind: 'cl' | 'v4'; id: string; token0: string; token1: string }>;
  };
  return readRobinhoodBackfill({
    dataDir,
    creation: creation.created,
    list: JSON.parse(
      readFileSync(opt('--list') ?? 'scripts/risk/assets/robinhood.json', 'utf8'),
    ) as AssetList,
    shelf,
    scope,
    regimeOfT: solanaRegime(),
  });
}
const readS = (Date.now() - t0) / 1000;

const { rows, poolRows, tokens, byToken } = barRows(read, chain, backfill);

let written = 0;
// the backfill's rows against what the table already holds (read-only, so a dry run says it too)
let existing: { same: number; other: number; checked: boolean } = {
  same: 0,
  other: 0,
  checked: false,
};
if (backfill && rows.length) {
  const { db, client } = createDb();
  try {
    const hours = rows.map((r) => (r.hour as Date).getTime());
    const have = await db
      .select({
        address: marketBars.address,
        pool: marketBars.pool,
        hour: marketBars.hour,
        source: marketBars.source,
      })
      .from(marketBars)
      .where(
        and(
          eq(marketBars.chain, chain),
          eq(marketBars.methodVersion, BARS_METHOD_VERSION),
          gte(marketBars.hour, new Date(Math.min(...hours))),
          lte(marketBars.hour, new Date(Math.max(...hours))),
        ),
      );
    const src = new Map(have.map((h) => [`${h.address}|${h.pool}|${h.hour.getTime()}`, h.source]));
    existing = { same: 0, other: 0, checked: true };
    for (const r of rows) {
      const s = src.get(`${r.address}|${r.pool}|${(r.hour as Date).getTime()}`);
      if (s === undefined) continue;
      if (s === r.source) existing.same++;
      else existing.other++;
    }
  } finally {
    await client.end();
  }
}
if (!dry && backfill) {
  const { db, client } = createDb();
  written = await insertBarsKeep(db, rows);
  await client.end();
} else if (!dry) {
  const { db, client } = createDb();
  const cols = Object.keys(rows[0] ?? {}).filter(
    (k) => !['chain', 'address', 'pool', 'hour', 'methodVersion'].includes(k),
  ) as Array<keyof BarRow>;
  const snake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  const set = Object.fromEntries(cols.map((k) => [k, sql.raw(`excluded.${snake(k)}`)]));
  for (let i = 0; i < rows.length; i += 500) {
    const res = await db
      .insert(marketBars)
      .values(rows.slice(i, i + 500))
      .onConflictDoUpdate({
        target: [
          marketBars.chain,
          marketBars.address,
          marketBars.pool,
          marketBars.hour,
          marketBars.methodVersion,
        ],
        set,
      })
      .returning({ h: marketBars.hour });
    written += res.length;
  }
  await client.end();
}

const { perPool, ...summary } = read.summary as { perPool: unknown[] } & Record<string, unknown>;
console.table(
  (tokens as Array<{ volumeUsd: number }>).sort((a, b) => b.volumeUsd - a.volumeUsd).slice(0, 40),
);
console.log(
  JSON.stringify({
    chain,
    dryRun: dry,
    source: backfill ? 'backfill' : 'held',
    methodVersion: BARS_METHOD_VERSION,
    ...summary,
    poolsWithBars: read.pools.filter((p) => p.bars.length).length,
    poolBars: poolRows,
    tokens: byToken.size,
    assetBars: rows.length - poolRows,
    rows: rows.length,
    written,
    ...(backfill ? { alreadyStored: existing } : {}),
    pricedPoolBars: rows.slice(0, poolRows).filter((r) => r.volumeUsd !== null).length,
    unpricedSwaps: rows.slice(0, poolRows).reduce((a, r) => a + (r.unpricedSwaps ?? 0), 0),
    readSeconds: Math.round(readS),
    seconds: Math.round((Date.now() - t0) / 1000),
  }),
);
if (process.env.BARS_PER_POOL) console.table(perPool);
