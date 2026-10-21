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
// A new key is inserted; a key an earlier run of this import wrote is replaced when the row now differs (a pool
// resolved since, a pricing method added); a key of another source (AS.7's held history) is never touched. A
// re-run on the same files changes nothing; a run after the fetch moved on adds the new days, and a key it wrote
// that the build no longer produces (a day no longer whole, a pool moved) is withdrawn (reconcileBackfillBars).
// The held path below never writes over a row of the backfill.
//
// --lookups-only [--since-hours <n>] [--drop-old-pool-bars] (the hosted bars job): writes only the rows the asset
// lookups read (lookup-rows.ts): the token rows of the last n hours (default 72), with an empty `detail`, and the
// rows of each token's top five pools (from the newest `pool_tvl_usd` readings in the same database) of the last
// POOL_BAR_HOURS. --drop-old-pool-bars then deletes the chain's held pool bars older than that, never a row of
// the backfill: the hosted database keeps a pool's bars for two days, its tokens' for 31 (DB-RETENTION). Both are
// refused on a database on this machine, which keeps every bar, unless --local-rehearsal names it a scratch one.
// Every --lookups-only run writes complete hours only: an hour is written once the walk's head is past its end.
//
// --walk <dir> (robinhood, with --lookups-only; the hourly hosted bars job, gate HOURLY-BARS): first walks the Swap
// events of the cut's pools since the folder's last head on the chain's public endpoint into <dir>, the job's own
// folder (scripts/risk-evm/recent-walk.ts: about the last 30 hours, never the loop's history/), then builds the bars
// from <dir> and writes the complete hours after the first RECENT_CONTEXT_HOURS of its span that no earlier run wrote
// (<dir>/written.json). A dry run walks too (the folder is the job's own) and records nothing as written.
import 'dotenv/config';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDb, marketBars } from '@colosseum/db';
import { BARS_METHOD_VERSION } from '@colosseum/risk';
import type { AssetList } from '@colosseum/schemas';
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { CHAINS, type ChainConfig } from '../../risk-evm/config';
import type { CutRow } from '../../risk-evm/cut';
import { historyPools } from '../../risk-evm/history';
import { acquireLock } from '../../risk-evm/loop';
import { RECENT_CONTEXT_HOURS, runRecentWalk, writableHours } from '../../risk-evm/recent-walk';
import { createRpc } from '../../risk-evm/rpc';
import {
  readPoolTokens,
  readRobinhoodBackfill,
  readSolanaBackfill,
  solanaRegistryPools,
} from './bars-backfill';
import { type PoolBars, readRobinhood, readSolana, solanaRegime } from './bars-read';
import {
  type BarRow,
  barRows,
  isBackfillSource,
  reconcileBackfillBars,
  upsertBackfillBars,
} from './bars-rows';
import {
  countOldPoolBars,
  dropOldPoolBars,
  isLocalDatabase,
  lookupRows,
  POOL_BAR_HOURS,
  readTopPools,
} from './lookup-rows';

const args = process.argv.slice(2);
const chain = args.find((a) => !a.startsWith('--'));
const dry = args.includes('--dry-run');
const opt = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const backfill = opt('--source') === 'backfill';
const lookupsOnly = args.includes('--lookups-only');
const sinceHours = Number(opt('--since-hours') ?? 72);
const dropOld = args.includes('--drop-old-pool-bars');
const localRehearsal = args.includes('--local-rehearsal');
const walkDir = opt('--walk');
if (
  (chain !== 'solana' && chain !== 'robinhood') ||
  (opt('--source') ?? 'held') !== (backfill ? 'backfill' : 'held') ||
  (lookupsOnly && backfill) ||
  ((args.includes('--since-hours') || dropOld || localRehearsal) && !lookupsOnly) ||
  (args.includes('--walk') &&
    (!walkDir || walkDir.startsWith('--') || !lookupsOnly || chain !== 'robinhood')) ||
  !Number.isFinite(sinceHours) ||
  sinceHours < 1
) {
  console.error(
    'usage: pnpm risk:assets-bars <solana|robinhood> [--dry-run] [--source backfill [--registry <file>] [--scope <key>] | --lookups-only [--since-hours <n>] [--drop-old-pool-bars] [--local-rehearsal] [--walk <dir> (robinhood)]]',
  );
  process.exit(1);
}
// --lookups-only empties `detail` and --drop-old-pool-bars deletes held pool bars: for the hosted database alone. A
// database on this machine keeps every bar (the backfill's and the held history's), so it is refused there unless the
// run says it is a rehearsal on a scratch database.
if (lookupsOnly && !localRehearsal && isLocalDatabase(process.env.DATABASE_URL)) {
  console.error(
    'refusing --lookups-only on a database on this machine (DATABASE_URL unset, localhost or 127.0.0.1): it is for the hosted database; --local-rehearsal for a scratch one',
  );
  process.exit(1);
}
const t0 = Date.now();
// --walk: the job's own walk of the last hours, before the bars are read from it (one run at a time)
let walk: Record<string, unknown> | null = null;
let releaseWalk: (() => void) | null = null;
if (walkDir) {
  const evmDir = process.env.RISK_EVM_DIR ?? 'data/risk-evm';
  const listDir = process.env.RISK_UNIVERSE_DIR ?? 'scripts/risk/universe';
  const rh = CHAINS.find((c) => c.id === 'robinhood') as ChainConfig;
  const list = JSON.parse(readFileSync(join(listDir, `${rh.id}.json`), 'utf8')) as AssetList;
  const cut = JSON.parse(readFileSync(join(evmDir, list.inputs.cut ?? ''), 'utf8')) as {
    chain: string;
    pools: CutRow[];
  };
  releaseWalk = acquireLock(join(walkDir, 'run.lock'), 2 * 3_600_000);
  if (!releaseWalk) {
    console.error(`another run holds ${join(walkDir, 'run.lock')}`);
    process.exit(1);
  }
  // the chain's public endpoint, never an address from the environment (a paid one): the walk is a few
  // thousand blocks an hour
  const rpc = createRpc(rh.rpcDefault, { timeoutMs: 120_000 });
  try {
    walk = await runRecentWalk(
      {
        rpc,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        log: (e) => {
          if (e.event !== 'window')
            console.log(JSON.stringify({ at: new Date().toISOString(), ...e }));
        },
        now: () => new Date(),
      },
      rh,
      historyPools(cut, rh),
      walkDir,
    );
  } catch (e) {
    releaseWalk();
    throw e;
  }
}
const read: {
  pools: Array<PoolBars & { sourceOf?: (hour: string) => string }>;
  daysOnDisk?: { first: string; last: string } | null;
  summary: Record<string, unknown>;
  span?: { fromT: number; headT: number };
} = backfill
  ? readBackfill()
  : chain === 'solana'
    ? await readSolana(process.env.RISK_DATA_DIR ?? 'data/risk')
    : await readRobinhood(
        process.env.RISK_EVM_DIR ?? 'data/risk-evm',
        process.env.RISK_UNIVERSE_DIR ?? 'scripts/risk/universe',
        walkDir ? { historyRoot: walkDir } : {},
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
    resolved: readPoolTokens(dataDir),
  });
}
const readS = (Date.now() - t0) / 1000;

const { rows, poolRows, tokens, byToken } = barRows(read, chain, backfill);

// --lookups-only: the rows the asset lookups read and no other (lookup-rows.ts), their top pools from the same
// database's newest `pool_tvl_usd` readings
const startedAt = Date.now();
let toWrite: BarRow[] = rows;
let lookups: { topPools: number; tokenRows: number; poolRows: number; dropped: number } | null =
  null;
// --walk: the hours an earlier run wrote (written.json), so each hour is written once
const writtenFile = walkDir ? join(walkDir, 'written.json') : null;
const writtenThrough =
  writtenFile && existsSync(writtenFile)
    ? Date.parse((JSON.parse(readFileSync(writtenFile, 'utf8')) as { through: string }).through)
    : null;
let hours: { from: number; to: number } | null = null;
if (lookupsOnly) {
  const { db, client } = createDb();
  try {
    const top = await readTopPools(db, chain);
    // complete hours only; from the job's own walk, not the first hours of its span, nor an hour written before
    const span = read.span;
    if (span) {
      const w = walkDir ? writableHours(span, RECENT_CONTEXT_HOURS) : writableHours(span, 0);
      hours = {
        from: Math.max(w.from * 1000, writtenThrough === null ? 0 : writtenThrough + 3_600_000),
        to: w.to * 1000,
      };
    }
    const inHours = hours
      ? rows.filter((r) => {
          const t = (r.hour as Date).getTime();
          return t >= (hours as { from: number }).from && t < (hours as { to: number }).to;
        })
      : rows;
    toWrite = lookupRows(inHours, top, {
      since: new Date(startedAt - sinceHours * 3_600_000),
      poolSince: new Date(startedAt - POOL_BAR_HOURS * 3_600_000),
    });
    const tokenRows = toWrite.filter((r) => r.pool === 'asset').length;
    lookups = { topPools: top.size, tokenRows, poolRows: toWrite.length - tokenRows, dropped: 0 };
    // a dry run says what --drop-old-pool-bars would delete
    if (dry && dropOld)
      lookups.dropped = await countOldPoolBars(
        db,
        chain,
        new Date(startedAt - POOL_BAR_HOURS * 3_600_000),
      );
  } finally {
    await client.end();
  }
}

let written = 0;
let replaced = 0;
// the backfill's rows against what the table already holds (read-only, so a dry run says it too)
let existing: {
  equalSource: number;
  earlierImport: number;
  otherSource: number;
  checked: boolean;
} = {
  equalSource: 0,
  earlierImport: 0,
  otherSource: 0,
  checked: false,
};
if (backfill && rows.length) {
  const { db, client } = createDb();
  try {
    // a fold, not Math.min(...hours): a month of a chain's bars is past the arguments a call takes (2026-10-14)
    let first = Number.POSITIVE_INFINITY;
    let last = Number.NEGATIVE_INFINITY;
    for (const r of rows) {
      const t = (r.hour as Date).getTime();
      if (t < first) first = t;
      if (t > last) last = t;
    }
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
          gte(marketBars.hour, new Date(first)),
          lte(marketBars.hour, new Date(last)),
        ),
      );
    const src = new Map(have.map((h) => [`${h.address}|${h.pool}|${h.hour.getTime()}`, h.source]));
    existing = { equalSource: 0, earlierImport: 0, otherSource: 0, checked: true };
    for (const r of rows) {
      const s = src.get(`${r.address}|${r.pool}|${(r.hour as Date).getTime()}`);
      if (s === undefined) continue;
      if (s === r.source) existing.equalSource++;
      else if (isBackfillSource(s)) existing.earlierImport++;
      else existing.otherSource++;
    }
  } finally {
    await client.end();
  }
}
// the backfill's own rows the build no longer produces, in the days on disk: withdrawn (counted in a dry run)
let withdrawn: { stored: number; withdrawn: number } | null = null;
if (backfill && read.daysOnDisk) {
  const { db, client } = createDb();
  try {
    withdrawn = await reconcileBackfillBars(
      db,
      chain,
      rows,
      {
        from: new Date(`${read.daysOnDisk.first}T00:00:00Z`),
        to: new Date(`${read.daysOnDisk.last}T23:00:00Z`),
      },
      dry,
    );
  } finally {
    await client.end();
  }
}
if (!dry && backfill) {
  const { db, client } = createDb();
  const r = await upsertBackfillBars(db, rows);
  written = r.inserted;
  replaced = r.replaced;
  await client.end();
} else if (!dry) {
  const { db, client } = createDb();
  const cols = Object.keys(toWrite[0] ?? {}).filter(
    (k) => !['chain', 'address', 'pool', 'hour', 'methodVersion'].includes(k),
  ) as Array<keyof BarRow>;
  const snake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  const set = Object.fromEntries(cols.map((k) => [k, sql.raw(`excluded.${snake(k)}`)]));
  for (let i = 0; i < toWrite.length; i += 500) {
    const res = await db
      .insert(marketBars)
      .values(toWrite.slice(i, i + 500))
      .onConflictDoUpdate({
        target: [
          marketBars.chain,
          marketBars.address,
          marketBars.pool,
          marketBars.hour,
          marketBars.methodVersion,
        ],
        set,
        // never over a row the backfill import wrote (AS.13): the held history fills only its own keys
        setWhere: sql.raw(
          "not (market_bars.source like '<ASSETS_DATA_DIR>/%' or market_bars.source like '%in the asset backfill''s day files%')",
        ),
      })
      .returning({ h: marketBars.hour });
    written += res.length;
  }
  if (lookups && dropOld)
    lookups.dropped = await dropOldPoolBars(
      db,
      chain,
      new Date(startedAt - POOL_BAR_HOURS * 3_600_000),
    );
  await client.end();
  // the newest hour written, so the next run starts after it (a token row of it went in)
  if (writtenFile && hours) {
    const newest = toWrite
      .filter((r) => r.pool === 'asset')
      .reduce((m, r) => Math.max(m, (r.hour as Date).getTime()), Number.NEGATIVE_INFINITY);
    if (Number.isFinite(newest))
      writeFileSync(writtenFile, JSON.stringify({ through: new Date(newest).toISOString() }));
  }
}
releaseWalk?.();

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
    ...(lookups
      ? {
          lookupsOnly: {
            sinceHours,
            poolBarHours: POOL_BAR_HOURS,
            ...(hours
              ? {
                  hours: {
                    from: new Date(hours.from).toISOString(),
                    toExclusive: new Date(hours.to).toISOString(),
                  },
                }
              : {}),
            ...lookups,
          },
        }
      : {}),
    ...(walk ? { walk } : {}),
    written,
    ...(backfill
      ? { replaced, withdrawn, daysOnDisk: read.daysOnDisk, alreadyStored: existing }
      : {}),
    pricedPoolBars: rows.slice(0, poolRows).filter((r) => r.volumeUsd !== null).length,
    unpricedSwaps: rows.slice(0, poolRows).reduce((a, r) => a + (r.unpricedSwaps ?? 0), 0),
    readSeconds: Math.round(readS),
    seconds: Math.round((Date.now() - t0) / 1000),
  }),
);
if (process.env.BARS_PER_POOL) console.table(perPool);
