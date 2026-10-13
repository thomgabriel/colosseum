// PLAN-ASSETS AS.8, series 5: the external daily series for every row, free and without a key (DA8):
// DefiLlama's coin prices (coins.llama.fi) and protocol TVL (api.llama.fi). The count checks, on a sample of
// rows, whether a series exists and how far back it goes; the fetch takes one coin's or one protocol's whole
// daily series to a gzip file with its manifest. Public GETs only; a 4xx or a body that is not the series is
// recorded as the answer, never retried into a key.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { addToManifest, BACKFILL_METHOD_VERSION, type Manifest } from '@colosseum/risk';

export const COINS = 'https://coins.llama.fi';
export const API = 'https://api.llama.fi';

type Get = (url: string) => Promise<{ status: number; body: unknown; bytes: number; ms: number }>;
export const get: Get = async (url) => {
  const t0 = Date.now();
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 200);
  }
  return { status: res.status, body, bytes: text.length, ms: Date.now() - t0 };
};

/** DefiLlama's key of a token: `<chain>:<address>`. */
export const coinKey = (chain: string, address: string) => `${chain}:${address}`;

/** The first price DefiLlama holds for each coin (`/prices/first`), in one GET per batch of keys. */
export async function firstPrices(keys: string[], batch = 50) {
  const out: Record<string, { first: string | null; symbol: string | null }> = {};
  let requests = 0;
  let bytes = 0;
  for (let i = 0; i < keys.length; i += batch) {
    const part = keys.slice(i, i + batch);
    const r = await get(`${COINS}/prices/first/${part.join(',')}`);
    requests++;
    bytes += r.bytes;
    const coins = ((r.body as { coins?: Record<string, { timestamp?: number; symbol?: string }> })
      ?.coins ?? {}) as Record<string, { timestamp?: number; symbol?: string }>;
    for (const k of part) {
      const c = coins[k];
      out[k] = {
        first: c?.timestamp ? new Date(c.timestamp * 1000).toISOString() : null,
        symbol: c?.symbol ?? null,
      };
    }
  }
  return { coins: out, requests, bytes };
}

/** Days a /chart request may span: 500 answered on 2026-10-11, 1,000 returned no point. */
export const CHART_SPAN_DAYS = 400;

/** One coin's daily series from `start`, asked `CHART_SPAN_DAYS` at a time: the points DefiLlama returns. */
export async function dailyChart(key: string, start: number, days: number) {
  const prices: Array<{ timestamp: number; price: number }> = [];
  let bytes = 0;
  let ms = 0;
  let status = 200;
  let requests = 0;
  for (
    let from = start, left = days;
    left > 0;
    from += CHART_SPAN_DAYS * 86_400, left -= CHART_SPAN_DAYS
  ) {
    const span = Math.min(CHART_SPAN_DAYS, left);
    const r = await get(
      `${COINS}/chart/${key}?start=${from}&span=${span}&period=1d&searchWidth=600`,
    );
    requests++;
    bytes += r.bytes;
    ms += r.ms;
    status = r.status;
    const got =
      (
        r.body as {
          coins?: Record<string, { prices?: Array<{ timestamp: number; price: number }> }>;
        }
      )?.coins?.[key]?.prices ?? [];
    for (const p of got)
      if (!prices.length || p.timestamp > (prices.at(-1) as { timestamp: number }).timestamp)
        prices.push(p);
  }
  return { status, prices, bytes, ms, requests };
}

/** A protocol's TVL history (`/protocol/<slug>`): how many daily points, from when. */
export async function protocolTvl(slug: string) {
  const r = await get(`${API}/protocol/${slug}`);
  const tvl = (r.body as { tvl?: Array<{ date: number; totalLiquidityUSD: number }> })?.tvl ?? [];
  return {
    slug,
    status: r.status,
    points: tvl.length,
    first: tvl[0] ? new Date(tvl[0].date * 1000).toISOString() : null,
    last: tvl.at(-1) ? new Date((tvl.at(-1) as { date: number }).date * 1000).toISOString() : null,
    bytes: r.bytes,
    ms: r.ms,
    tvl,
  };
}

/** One series to a gzip file and its manifest. */
export function writeSeries(
  out: string,
  subject: string,
  rows: unknown[],
  source: string,
  covered: { from: number; to: number },
  at: string,
) {
  const safe = subject.replace(/[^A-Za-z0-9_.-]/g, '_');
  const dir = join(out, safe);
  mkdirSync(dir, { recursive: true });
  const text = `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;
  const gz = gzipSync(text);
  writeFileSync(join(dir, 'daily.jsonl.gz'), gz);
  const m0: Manifest = {
    series: 'external-daily',
    chain: subject.startsWith('solana:') ? 'solana' : 'robinhood',
    subject,
    methodVersion: BACKFILL_METHOD_VERSION,
    source,
    provenance: 'live',
    covered: [],
    days: {},
    rows: 0,
    bytes: 0,
    checks: [],
    updatedAt: at,
  };
  const m = addToManifest(
    m0,
    { ...covered, unit: 'second' },
    { all: { rows: rows.length, bytes: gz.length } },
    [{ name: 'non_empty', passed: rows.length > 0, detail: `${rows.length} daily points` }],
    at,
  );
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(m, null, 1)}\n`);
  return { rows: rows.length, gzBytes: gz.length, rowBytes: text.length };
}
