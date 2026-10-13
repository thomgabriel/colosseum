// `pnpm risk:assets-history-import <chainlink|external|all> [--dry-run]` (PLAN-ASSETS AS.13): the backfill's daily
// series and Chainlink rounds (AS.8 series 2 and 5) into the database. Files only (ASSETS_DATA_DIR, default
// data/assets); no network. Rows are inserted, never updated: a row already there is kept, so a second run inserts
// nothing. --dry-run builds and counts and writes nothing.
//
//   chainlink  <dir>/robinhood/chainlink/<proxy>/<day>.jsonl.gz: every round of a feed whose manifest says every
//              round was answered → risk_price_observations, price_source `chainlink:<proxy>` (kept apart from the
//              live reads under `chainlink`, which the API's oracle facts read), the round's updatedAt as its
//              time, the answer over 10^decimals; the token is every row of the asset list and the tracked list
//              that names the proxy, with the decimals those rows give (a feed they disagree on is refused).
//   external   <dir>/external/<subject>/daily.jsonl.gz: a token's DefiLlama daily price → risk_price_observations
//              under `external:defillama`; a protocol's DefiLlama TVL → asset_observations `protocol_tvl_usd`,
//              address `protocol:<slug>` and chain `all_chains` (DefiLlama sums every chain, and the series is the
//              whole protocol's, not a token's vault as AS.5's rows are). A Solana price inside the installed price
//              job's six-day window is held back (`priceJobHoldBack`) and written by a later run once older.
import 'dotenv/config';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assetObservations, createDb, type Db, riskPriceObservations } from '@colosseum/db';
import {
  dailyPoint,
  HISTORY_IMPORT_METHOD_VERSION,
  type Manifest,
  priceJobHoldBack,
  type RoundRow,
  roundPrice,
} from '@colosseum/risk';
import { gzLines } from './bars-backfill';

type PriceRow = typeof riskPriceObservations.$inferInsert;
type FactRow = typeof assetObservations.$inferInsert;

export const CHAINLINK_METHOD = 'chainlink_round_answer_at_updated_at';
export const DEFILLAMA_PRICE_METHOD = 'defillama_coins_chart_daily';
export const DEFILLAMA_TVL_METHOD = 'defillama_protocol_tvl_daily';

const readJson = <T>(f: string): T | null => {
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as T;
  } catch {
    return null;
  }
};

type ListLike = {
  assets: Array<{
    address: string;
    symbol: string;
    oracle: {
      kind: string;
      ref: string;
      decimals?: number | null;
      description?: string | null;
    } | null;
  }>;
};

/** The tokens each Chainlink proxy prices, with its decimals, from the lists that name it. */
export function feedTokens(lists: ListLike[]) {
  const out = new Map<
    string,
    {
      tokens: Array<{ address: string; symbol: string }>;
      decimals: Set<number>;
      description: string | null;
    }
  >();
  for (const l of lists)
    for (const a of l.assets) {
      if (a.oracle?.kind !== 'chainlink') continue;
      const k = a.oracle.ref.toLowerCase();
      const f = out.get(k) ?? { tokens: [], decimals: new Set<number>(), description: null };
      if (!f.tokens.some((t) => t.address === a.address.toLowerCase()))
        f.tokens.push({ address: a.address.toLowerCase(), symbol: a.symbol });
      if (typeof a.oracle.decimals === 'number') f.decimals.add(a.oracle.decimals);
      f.description ??= a.oracle.description ?? null;
      out.set(k, f);
    }
  return out;
}

/** Every round of one feed folder as price observations, or why the feed gives none. */
export function chainlinkRows(
  dir: string,
  feed: string,
  of: ReturnType<typeof feedTokens>,
): { rows: PriceRow[]; skipped: Record<string, number>; refused: string | null } {
  const skipped: Record<string, number> = {};
  const m = readJson<Manifest>(join(dir, feed, 'manifest.json'));
  if (!m) return { rows: [], skipped, refused: 'no_manifest' };
  if (!m.checks.some((c) => c.name === 'every_round_answered'))
    return { rows: [], skipped, refused: 'manifest_without_its_checks' };
  const f = of.get(feed);
  if (!f) return { rows: [], skipped, refused: 'no_list_row_names_the_feed' };
  if (f.decimals.size !== 1) return { rows: [], skipped, refused: 'decimals_not_one_value' };
  if (f.description && !/[/-]\s*USD$/i.test(f.description))
    return { rows: [], skipped, refused: 'not_quoted_in_usd' };
  const decimals = [...f.decimals][0] as number;
  const rows: PriceRow[] = [];
  for (const day of Object.keys(m.days).sort()) {
    const file = join(dir, feed, `${day}.jsonl.gz`);
    if (!existsSync(file)) {
      skipped.day_file_missing = (skipped.day_file_missing ?? 0) + 1;
      continue;
    }
    for (const l of gzLines(file)) {
      const r = JSON.parse(l) as RoundRow;
      const p = roundPrice(r, decimals);
      if ('reason' in p) {
        skipped[p.reason] = (skipped[p.reason] ?? 0) + 1;
        continue;
      }
      for (const t of f.tokens)
        rows.push({
          chain: 'robinhood',
          mint: t.address,
          priceSource: `chainlink:${feed}`,
          observedAt: new Date(p.t * 1000),
          slot: 0,
          price: p.price,
          quote: 'usd',
          ref: feed,
          market: null,
          live: true,
          failedChecks: null,
          sourceTs: new Date(p.t * 1000),
          marketStatus: null,
          methodVersion: HISTORY_IMPORT_METHOD_VERSION,
          source: `${m.source}; round ${r.roundId} (phase ${r.phase}, round ${r.round}) of <ASSETS_DATA_DIR>/robinhood/chainlink/${feed}/${day}.jsonl.gz (backfill-0.1)`,
          method: `${CHAINLINK_METHOD}: the round's answer over 10^${decimals}, at its updatedAt`,
          fetchedAt: new Date(m.updatedAt),
          provenance: 'live',
        });
    }
  }
  return { rows, skipped, refused: null };
}

/** One external subject's daily series as rows of the table it belongs to. */
export function externalRows(
  dir: string,
  folder: string,
  nowT: number,
): { prices: PriceRow[]; facts: FactRow[]; heldBack: number; skipped: Record<string, number> } {
  const out = {
    prices: [] as PriceRow[],
    facts: [] as FactRow[],
    heldBack: 0,
    skipped: {} as Record<string, number>,
  };
  const m = readJson<Manifest>(join(dir, folder, 'manifest.json'));
  const file = join(dir, folder, 'daily.jsonl.gz');
  if (!m || !existsSync(file)) {
    out.skipped.no_manifest_or_file = 1;
    return out;
  }
  const [kind, ...rest] = m.subject.split(':');
  const key = rest.join(':');
  for (const l of gzLines(file)) {
    const p = dailyPoint(JSON.parse(l));
    if ('reason' in p) {
      out.skipped[p.reason] = (out.skipped[p.reason] ?? 0) + 1;
      continue;
    }
    const at = new Date(p.t * 1000);
    if (kind === 'protocol') {
      if (!(p.v >= 0)) {
        out.skipped.negative_tvl = (out.skipped.negative_tvl ?? 0) + 1;
        continue;
      }
      out.facts.push({
        chain: 'all_chains',
        address: `protocol:${key}`,
        metric: 'protocol_tvl_usd',
        value: p.v,
        unit: 'usd',
        nullReason: null,
        observedAt: at,
        height: null,
        detail: {
          what: "DefiLlama's TVL of the whole protocol, every chain it counts summed (not one token's vault)",
          slug: key,
          file: `<ASSETS_DATA_DIR>/external/${folder}/daily.jsonl.gz`,
        },
        methodVersion: HISTORY_IMPORT_METHOD_VERSION,
        source: `${m.source} (backfill-0.1)`,
        method: DEFILLAMA_TVL_METHOD,
        fetchedAt: new Date(m.updatedAt),
        provenance: 'live',
      });
      continue;
    }
    if (kind !== 'solana' && kind !== 'robinhood') {
      out.skipped.unknown_subject = (out.skipped.unknown_subject ?? 0) + 1;
      continue;
    }
    if (!(p.v > 0)) {
      out.skipped.price_not_positive = (out.skipped.price_not_positive ?? 0) + 1;
      continue;
    }
    if (priceJobHoldBack(kind, p.t, nowT)) {
      out.heldBack++;
      continue;
    }
    out.prices.push({
      chain: kind,
      mint: kind === 'robinhood' ? key.toLowerCase() : key,
      priceSource: 'external:defillama',
      observedAt: at,
      slot: 0,
      price: p.v,
      quote: 'usd',
      ref: 'coins.llama.fi/chart',
      market: null,
      live: true,
      failedChecks: null,
      sourceTs: at,
      marketStatus: null,
      methodVersion: HISTORY_IMPORT_METHOD_VERSION,
      source: `${m.source} (backfill-0.1, <ASSETS_DATA_DIR>/external/${folder}/daily.jsonl.gz)`,
      method: DEFILLAMA_PRICE_METHOD,
      fetchedAt: new Date(m.updatedAt),
      provenance: 'live',
    });
  }
  return out;
}

/** Inserts, keeping any row already there; returns how many were new. */
export async function insertKeep(
  db: Pick<Db, 'insert'>,
  prices: PriceRow[],
  facts: FactRow[],
): Promise<{ prices: number; facts: number }> {
  let p = 0;
  let f = 0;
  for (let i = 0; i < prices.length; i += 1000) {
    const r = await db
      .insert(riskPriceObservations)
      .values(prices.slice(i, i + 1000))
      .onConflictDoNothing()
      .returning({ m: riskPriceObservations.mint });
    p += r.length;
  }
  for (let i = 0; i < facts.length; i += 1000) {
    const r = await db
      .insert(assetObservations)
      .values(facts.slice(i, i + 1000))
      .onConflictDoNothing()
      .returning({ a: assetObservations.address });
    f += r.length;
  }
  return { prices: p, facts: f };
}

/** Everything one run would write, with its counts, from the files under `dataDir`. */
export function buildHistory(inp: {
  dataDir: string;
  what: 'chainlink' | 'external' | 'all';
  lists: ListLike[];
  nowT: number;
}) {
  const prices: PriceRow[] = [];
  const facts: FactRow[] = [];
  const report: Record<string, unknown> = {};
  if (inp.what !== 'external') {
    const dir = join(inp.dataDir, 'robinhood', 'chainlink');
    const of = feedTokens(inp.lists);
    const feeds = existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => f.startsWith('0x'))
          .sort()
      : [];
    const per: Array<Record<string, unknown>> = [];
    for (const feed of feeds) {
      const r = chainlinkRows(dir, feed, of);
      prices.push(...r.rows);
      per.push({
        feed,
        tokens:
          of
            .get(feed)
            ?.tokens.map((t) => t.symbol)
            .join(',') ?? null,
        rows: r.rows.length,
        refused: r.refused,
        ...r.skipped,
      });
    }
    report.chainlink = {
      feeds: feeds.length,
      feedsWritten: per.filter((p) => !p.refused).length,
      rows: per.reduce((a, p) => a + (p.rows as number), 0),
      refused: per.filter((p) => p.refused),
    };
  }
  if (inp.what !== 'chainlink') {
    const dir = join(inp.dataDir, 'external');
    const folders = existsSync(dir) ? readdirSync(dir).sort() : [];
    const tally = {
      solana: 0,
      robinhood: 0,
      protocols: 0,
      heldBackSolana: 0,
      subjects: 0,
      skipped: {} as Record<string, number>,
    };
    for (const folder of folders) {
      const r = externalRows(dir, folder, inp.nowT);
      tally.subjects++;
      prices.push(...r.prices);
      facts.push(...r.facts);
      tally.heldBackSolana += r.heldBack;
      for (const p of r.prices) tally[p.chain as 'solana' | 'robinhood']++;
      tally.protocols += r.facts.length;
      for (const [k, v] of Object.entries(r.skipped))
        tally.skipped[k] = (tally.skipped[k] ?? 0) + v;
    }
    report.external = tally;
  }
  return { prices, facts, report };
}

async function main() {
  const args = process.argv.slice(2);
  const what = args.find((a) => !a.startsWith('--')) as 'chainlink' | 'external' | 'all';
  if (!['chainlink', 'external', 'all'].includes(what)) {
    console.error('usage: pnpm risk:assets-history-import <chainlink|external|all> [--dry-run]');
    process.exit(1);
  }
  const dry = args.includes('--dry-run');
  const t0 = Date.now();
  const lists = ['scripts/risk/assets/robinhood.json', 'scripts/risk/universe/robinhood.json'].map(
    (f) => JSON.parse(readFileSync(f, 'utf8')) as ListLike,
  );
  const built = buildHistory({
    dataDir: process.env.ASSETS_DATA_DIR ?? 'data/assets',
    what,
    lists,
    nowT: Math.floor(t0 / 1000),
  });
  let written = { prices: 0, facts: 0 };
  if (!dry) {
    const { db, client } = createDb();
    try {
      written = await insertKeep(db, built.prices, built.facts);
    } finally {
      await client.end();
    }
  }
  console.log(
    JSON.stringify(
      {
        what,
        dryRun: dry,
        methodVersion: HISTORY_IMPORT_METHOD_VERSION,
        ...built.report,
        built: { prices: built.prices.length, facts: built.facts.length },
        inserted: written,
        seconds: Math.round((Date.now() - t0) / 1000),
      },
      null,
      1,
    ),
  );
}

if (import.meta.url === `file://${process.argv[1]}`)
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
