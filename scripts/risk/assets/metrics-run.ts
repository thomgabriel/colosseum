import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { Db } from '@colosseum/db';
import {
  ASSET_METRICS,
  type AssetMetric,
  type MetricAnswers,
  type MetricAsset,
  type MetricSources,
  metricCounts,
  pricesToWrite,
  rowsFromAnswers,
  type SolanaPriceMode,
} from '@colosseum/risk';
import { changedOnly, latestRows, writeRun } from './metrics-db';
import { Reads } from './metrics-io';

// PLAN-ASSETS AS.5 and AS.6: one run of one chain, shared by the import (`pnpm risk:assets-import`) and the hourly
// jobs: read (or take the answers of a saved run), turn the answers into rows, keep a supply that has not moved out
// (facts at every change), hold back the Solana prices the price job must not see, save the answers, write, and log
// the run. A dry run reads and prints and writes nothing: no row, no answers file, no line in the run log.

export type ListFile = {
  chain: 'solana' | 'robinhood';
  fetchedAt: string;
  method: string;
  assets: MetricAsset[];
};

export type RunOptions = {
  chain: 'solana' | 'robinhood';
  list: ListFile;
  listFile: string;
  sources: MetricSources;
  sourcesFile: string;
  metrics: AssetMetric[];
  prices: boolean;
  solanaPrices: SolanaPriceMode;
  dryRun: boolean;
  /** A saved run's answers to build from, with no network. */
  from?: string;
  /** Also write the answers here, dry run or not (a file for a person or a fixture, never the database). */
  answersOut?: string;
  /** Where the answers and the run log go: `<dataDir>/<chain>/metrics/<stamp>.jsonl.gz`, `<dataDir>/runs.jsonl`. */
  dataDir: string;
  db: Db;
  read: (o: {
    reads: Reads;
    list: ListFile;
    listMeta: { file: string; fetchedAt: string; method: string };
  }) => Promise<MetricAnswers>;
  log: (l: string) => void;
  kind: 'import' | 'job';
  /**
   * Whether the run may still touch the database, asked once the reads are done (the hosted job's write window,
   * write-window.ts): when not, it reads nothing more from it and writes nothing; the answers are kept.
   */
  mayWrite?: () => boolean;
  /** The daily parts this run was asked (metrics-schedule.ts), for the run log. */
  daily?: string[];
};

/** One line per read: the header first, then each answer under its name. */
export function encodeAnswers(A: MetricAnswers): Buffer {
  const { kind, chain, stamp, startedAt, list, sources, metrics, rpcLabel, ...rest } = A;
  const lines = [
    JSON.stringify({ kind, chain, stamp, startedAt, list, sources, metrics, rpcLabel }),
  ];
  for (const [read, value] of Object.entries(rest))
    if (value !== undefined) lines.push(JSON.stringify({ read, value }));
  return gzipSync(`${lines.join('\n')}\n`);
}

export function decodeAnswers(buf: Buffer): MetricAnswers {
  const [head, ...rest] = gunzipSync(buf).toString('utf8').split('\n').filter(Boolean);
  if (!head) throw new Error('an empty answers file');
  const A = JSON.parse(head) as MetricAnswers;
  if (A.kind !== 'asset-metrics-answers') throw new Error(`not an answers file: ${A.kind}`);
  for (const l of rest) {
    const { read, value } = JSON.parse(l) as { read: keyof MetricAnswers; value: unknown };
    (A as Record<string, unknown>)[read] = value;
  }
  return A;
}

export async function runChain(o: RunOptions) {
  const t0 = Date.now();
  const reads = new Reads();
  const listMeta = { file: o.listFile, fetchedAt: o.list.fetchedAt, method: o.list.method };
  let A: MetricAnswers;
  if (o.from) {
    A = decodeAnswers(readFileSync(o.from));
    if (A.chain !== o.chain) throw new Error(`${o.from} is a ${A.chain} run, not ${o.chain}`);
    o.log(`${o.chain}: built from ${o.from}, with no network`);
  } else A = await o.read({ reads, list: o.list, listMeta });
  const built = rowsFromAnswers(o.list.assets, o.sources, A);

  // past the write window nothing more is read from the database or written to it: the next run reads again
  const skipped =
    !o.dryRun && o.mayWrite && !o.mayWrite()
      ? 'past the write window: nothing written; the next run reads and writes again'
      : null;
  if (skipped) o.log(`${o.chain}: ${skipped}`);
  // facts at every change: a row equal to the newest stored one, and less than a day after it, is not written
  const { keep, unchanged } = skipped
    ? { keep: built.rows, unchanged: 0 }
    : changedOnly(built.rows, await latestRows(o.db, o.chain));
  const job = A.prices?.job;
  const priced = pricesToWrite(built.prices, {
    mode: o.solanaPrices,
    resolved: new Set(job?.resolved ?? []),
    jobNewestT: job?.newestT ?? null,
  });
  if (o.chain === 'solana' && A.prices && !job)
    throw new Error('Solana prices with no price-job state in the answers');

  let answersFile: string | null = null;
  if (!o.dryRun && !o.from) {
    answersFile = join(o.dataDir, o.chain, 'metrics', `${A.stamp}.jsonl.gz`);
    mkdirSync(dirname(answersFile), { recursive: true });
    writeFileSync(answersFile, encodeAnswers(A));
  }
  if (o.answersOut) {
    mkdirSync(dirname(o.answersOut), { recursive: true });
    writeFileSync(o.answersOut, encodeAnswers(A));
  }
  const written = await writeRun(o.db, keep, priced.write, { dryRun: o.dryRun || !!skipped });

  const refused: Record<string, number> = {};
  for (const r of built.refusals)
    refused[`${r.priceSource} ${r.reason}`] = (refused[`${r.priceSource} ${r.reason}`] ?? 0) + 1;
  const bySource: Record<string, number> = {};
  for (const p of built.prices) bySource[p.priceSource] = (bySource[p.priceSource] ?? 0) + 1;
  const summary = {
    kind: `asset-metrics-${o.kind}`,
    chain: o.chain,
    at: new Date(t0).toISOString(),
    stamp: A.stamp,
    seconds: Math.round((Date.now() - t0) / 100) / 10,
    dryRun: o.dryRun,
    from: o.from ?? null,
    answers: answersFile,
    metrics: A.metrics,
    ...(o.daily ? { daily: o.daily } : {}),
    cutShort: A.cutShort ?? [],
    ...(A.timedOut?.length ? { timedOut: A.timedOut } : {}),
    ...(skipped ? { skipped } : {}),
    rows: built.rows.length,
    counts: metricCounts(built.rows),
    unchangedNotWritten: unchanged,
    prices: {
      read: bySource,
      refused,
      held: priced.held,
      toWrite: priced.write.length,
      solanaPrices: o.solanaPrices,
    },
    written,
    reads: reads.list(),
    errorsByToken: built.errorsByToken,
    tokensWithErrors: Object.keys(built.errorsByToken).length,
    methodVersion: built.rows[0]?.methodVersion ?? null,
  };
  if (!o.dryRun) {
    mkdirSync(o.dataDir, { recursive: true });
    appendFileSync(join(o.dataDir, 'runs.jsonl'), `${JSON.stringify(summary)}\n`);
  }
  return { summary, rows: built.rows, prices: built.prices };
}

export type RunSummary = Awaited<ReturnType<typeof runChain>>['summary'];

/** The counts of a run, as lines for a person. */
export function printSummary(s: RunSummary, log: (l: string) => void) {
  log(`${s.chain}: ${s.rows} rows${s.dryRun ? ' (dry run: nothing written)' : ''}, ${s.seconds} s`);
  for (const m of ASSET_METRICS) {
    const c = s.counts[m];
    if (!c) continue;
    const nulls = Object.entries(c.null)
      .sort((a, b) => b[1] - a[1])
      .map(([r, n]) => `${r} ${n}`)
      .join(', ');
    log(`  ${m}: value ${c.value}${nulls ? `; null ${nulls}` : ''}`);
  }
  log(`  rows equal to the newest stored ones, not written: ${s.unchangedNotWritten}`);
  log(
    `  prices read ${JSON.stringify(s.prices.read)}, refused ${JSON.stringify(s.prices.refused)}, held ${JSON.stringify(s.prices.held)}, to write ${s.prices.toWrite}`,
  );
  log(
    `  written: asset_observations ${s.written.observations.inserted} of ${s.written.observations.asked}, risk_price_observations ${s.written.prices.inserted} of ${s.written.prices.asked}`,
  );
  for (const r of s.reads)
    log(`  read ${r.name}: ${r.calls} calls, ${r.seconds} s, ${r.errors} errors, ${r.rows} rows`);
  if (s.tokensWithErrors) log(`  tokens with a read error: ${s.tokensWithErrors}`);
  if (s.answers) log(`  answers: ${s.answers}`);
}
