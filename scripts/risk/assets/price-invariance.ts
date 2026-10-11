import 'dotenv/config';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createDb, riskPriceObservations } from '@colosseum/db';
import {
  assetRowObservation,
  compareJobRows,
  type ExternalPrice,
  hourlyReferencePrices,
  lendingRowObservation,
  type MetricSources,
  type PriceObservation,
  type PriceSourceId,
  priceJobReferences,
  pricesToWrite,
  type ReferencePrice,
  rowsFromAnswers,
  type SolanaPriceMode,
} from '@colosseum/risk';
import { and, eq, gte, lte } from 'drizzle-orm';
import { RISK_HOME } from '../lib-lending';
import { observationKey } from '../prices/db';
import { buildPriceInputs, type StoredObservation } from '../prices/lib';
import { readPriceJobState } from './metrics-db';
import { decodeAnswers, type ListFile } from './metrics-run';

// PLAN-ASSETS AS.5: the proof that the aggregators' prices this work may write leave the installed hourly price job
// (`com.colosseum.risk-prices`, scripts/risk/prices/job.ts) writing the same reference prices, byte for byte, for every
// asset it already values. It runs the job's own steps at a chosen time, read only: the window of Solana
// observations the job would read (the table's last six days and the collectors' files of the last three under
// RISK_HOME, flags as the job sets them), then lib.ts' buildPriceInputs and the job's hourly loop, once as it is and
// once with each set of prices added (none, the `unresolved` filter, all). The rows are compared as JSON. It also
// runs the pure copy of those steps (packages/risk priceJobReferences) and checks it gives the job's rows, so the
// test on a frozen window (tests/risk-assets-metrics.test.ts) tests the job's arithmetic.
//   tsx scripts/risk/assets/price-invariance.ts --answers <solana answers.jsonl.gz> [--now <iso>] [--out <file>]
//                                               [--freeze <fixture.json.gz> --mints a,b,c --hours 52]
// It writes nothing to the database.

const args = process.argv.slice(2);
const opt = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const answersFile = opt('--answers');
if (!answersFile) throw new Error('--answers <solana answers file> is needed');
const P = { fileDays: 3, windowSec: 6 * 86400, refreshSec: 2 * 86400 }; // job.ts
const now = Math.floor((opt('--now') ? Date.parse(opt('--now') as string) : Date.now()) / 1000);
const fetchedAt = new Date(now * 1000);
process.env.RISK_HOLIDAYS ??= join(RISK_HOME, 'us-market-holidays.json');

const { db, client } = createDb();
const t0 = Date.now();
// ------------------------------------------------------------------------------- the job's window, read only
const inDb = await db
  .select()
  .from(riskPriceObservations)
  .where(
    and(
      gte(riskPriceObservations.observedAt, new Date((now - P.windowSec) * 1000)),
      lte(riskPriceObservations.observedAt, fetchedAt),
      eq(riskPriceObservations.chain, 'solana'),
    ),
  );
const window = new Map<string, StoredObservation>();
const flagInDb = new Map<string, boolean>();
for (const r of inDb) {
  const o: StoredObservation = {
    chain: r.chain,
    mint: r.mint,
    priceSource: r.priceSource as PriceSourceId,
    t: Math.floor(r.observedAt.getTime() / 1000),
    slot: r.slot,
    price: r.price,
    quote: r.quote,
    ref: r.ref,
    market: r.market,
    method: r.method,
    ...(r.failedChecks ? { failedChecks: r.failedChecks.split(',') } : {}),
    source: r.source,
    fetchedAt: r.fetchedAt.toISOString(),
    methodVersion: r.methodVersion,
    provenance: 'live',
  };
  window.set(observationKey(o), o);
  flagInDb.set(observationKey(o), r.live);
}
let fromFiles = 0;
for (const [dir, map] of [
  ['lending', lendingRowObservation],
  ['assets', assetRowObservation],
] as const)
  for (let d = 0; d < P.fileDays; d++) {
    const day = new Date((now - d * 86400) * 1000).toISOString().slice(0, 10);
    const f = join(RISK_HOME, dir, `${day}.jsonl`);
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line) continue;
      let row: Record<string, unknown>;
      try {
        row = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const o = map(row);
      if (!o || o.t < now - P.windowSec || o.t > now) continue;
      const s: StoredObservation = {
        ...o,
        source: dir,
        fetchedAt: fetchedAt.toISOString(),
        methodVersion: 'prices-0.1',
        provenance: 'live',
      };
      const k = observationKey(s);
      if (window.has(k)) continue;
      window.set(k, s);
      fromFiles++;
    }
  }

// --------------------------------------------------------------------------------------- the prices to add
const A = decodeAnswers(readFileSync(answersFile));
const sources = JSON.parse(
  readFileSync('scripts/risk/assets/metrics.sources.json', 'utf8'),
) as MetricSources;
const list = JSON.parse(readFileSync('scripts/risk/assets/solana.json', 'utf8')) as ListFile;
const { prices } = rowsFromAnswers(list.assets, sources, A);
const solana = prices.filter((p) => p.chain === 'solana' && p.t <= now);
const state = await readPriceJobState(db, RISK_HOME);
await client.end();

/** job.ts after its first step: buildPriceInputs, the table's flags winning, then the hourly loop. */
function jobRows(obs: readonly StoredObservation[]) {
  const copies = obs.map((o) => ({ ...o }));
  const inputs = buildPriceInputs(copies);
  for (const o of inputs.observations) {
    const was = flagInDb.get(observationKey(o));
    if (was === true) delete o.live;
    else if (was === false) o.live = false;
  }
  const lastHour = Math.floor(inputs.index.last / 3600) * 3600;
  const rows: ReferencePrice[] = [];
  for (const [mint, first] of [...inputs.index.first].sort(([a], [b]) => a.localeCompare(b)))
    for (const r of hourlyReferencePrices(
      inputs.index,
      inputs.ctx,
      mint,
      Math.max(first, now - P.refreshSec),
      lastHour,
    ))
      rows.push(r);
  return { rows, lastHour, params: inputs.ctx.params };
}
const asStored = (p: ExternalPrice): StoredObservation => ({
  ...p,
  methodVersion: 'asset-metrics-0.1',
  provenance: 'live',
});
const base = [...window.values()];
const timed = <T>(f: () => T) => {
  const t = Date.now();
  const v = f();
  return { v, seconds: (Date.now() - t) / 1000 };
};
const before = timed(() => jobRows(base));
const variants: Record<string, unknown> = {};
for (const mode of ['none', 'unresolved', 'all'] as SolanaPriceMode[]) {
  const { write, held } = pricesToWrite(solana, {
    mode,
    resolved: new Set(state.resolved),
    jobNewestT: state.newestT,
  });
  const after = timed(() => jobRows([...base, ...write.map(asStored)]));
  variants[mode] = {
    pricesAdded: write.length,
    held,
    lastHourBefore: new Date(before.v.lastHour * 1000).toISOString(),
    lastHourAfter: new Date(after.v.lastHour * 1000).toISOString(),
    seconds: after.seconds,
    ...compareJobRows(before.v.rows, after.v.rows),
  };
}
// the pure copy of the job's steps gives the job's rows on this window
const P0 = before.v.params;
const replica = priceJobReferences({
  // a row of the table carries its stored flag; a row of the files none, so the computed one stands, as in the job
  observations: base.map((o) => {
    const { live: _l, ...rest } = o;
    const k = observationKey(o);
    return flagInDb.has(k) ? { ...rest, live: flagInDb.get(k) } : rest;
  }) as PriceObservation[],
  calendar: JSON.parse(readFileSync(process.env.RISK_HOLIDAYS as string, 'utf8')),
  parMints: P0.parMints,
  continuousMints: P0.continuousMints,
  usdStableMints: Object.keys(P0.maxAgeSecByMint),
  now,
  refreshSec: P.refreshSec,
  wallNow: Math.floor(Date.now() / 1000),
});
const replicaCheck = compareJobRows(before.v.rows, replica.rows);

const proof = {
  kind: 'asset-metrics-price-invariance',
  now: fetchedAt.toISOString(),
  answers: answersFile,
  window: {
    observations: base.length,
    fromTable: inDb.length,
    fromFiles,
    from: new Date((now - P.windowSec) * 1000).toISOString(),
  },
  job: {
    rows: before.v.rows.length,
    assets: new Set(before.v.rows.map((r) => r.mint)).size,
    seconds: before.seconds,
  },
  jobState: {
    resolved: state.resolved.length,
    newestT: state.newestT ? new Date(state.newestT * 1000).toISOString() : null,
  },
  candidatePrices: solana.length,
  variants,
  replica: {
    identical: replicaCheck.identical,
    changed: replicaCheck.changed,
    added: replicaCheck.added,
    removed: replicaCheck.removed,
    lastHour: replica.lastHour === before.v.lastHour,
  },
  seconds: (Date.now() - t0) / 1000,
};
console.log(JSON.stringify(proof, null, 1));
const out = opt('--out');
if (out) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(proof, null, 1)}\n`);
}

// ------------------------------------------------------------------------------------ the frozen test window
const freeze = opt('--freeze');
if (freeze) {
  const mints = new Set((opt('--mints') ?? '').split(',').filter(Boolean));
  const hours = Number(opt('--hours') ?? 52);
  const keep = base.filter((o) => mints.has(o.mint) && o.t >= now - hours * 3600);
  const quotes = new Set(keep.map((o) => o.quote).filter((q) => q !== 'usd'));
  // a quote token's own observations come along, so a price quoted in it converts as in the job
  const extra = base.filter(
    (o) => quotes.has(o.mint) && !mints.has(o.mint) && o.t >= now - hours * 3600,
  );
  const obs = [...keep, ...extra].map((o) => ({
    chain: o.chain,
    mint: o.mint,
    priceSource: o.priceSource,
    t: o.t,
    slot: o.slot,
    price: o.price,
    quote: o.quote,
    ref: o.ref,
    market: o.market,
    method: o.method,
    ...(o.failedChecks ? { failedChecks: o.failedChecks } : {}),
    ...(flagInDb.has(observationKey(o)) ? { live: flagInDb.get(observationKey(o)) } : {}),
  }));
  const cand = solana.filter(
    (p) => mints.has(p.mint) || (opt('--new') ?? '').split(',').includes(p.mint),
  );
  writeFileSync(
    freeze,
    gzipSync(
      JSON.stringify({
        about:
          'A frozen window of the Solana price observations the installed price job reads, and aggregator prices read the same hour (scripts/risk/assets/price-invariance.ts --freeze). Real rows of the local database.',
        now,
        refreshSec: P.refreshSec,
        calendar: JSON.parse(readFileSync(process.env.RISK_HOLIDAYS as string, 'utf8')),
        parMints: P0.parMints,
        continuousMints: P0.continuousMints,
        usdStableMints: Object.keys(P0.maxAgeSecByMint),
        resolved: state.resolved,
        jobNewestT: state.newestT,
        observations: obs,
        prices: cand,
      }),
    ),
  );
  console.error(
    `froze ${obs.length} observations of ${mints.size} mints and ${cand.length} prices into ${freeze}`,
  );
}
