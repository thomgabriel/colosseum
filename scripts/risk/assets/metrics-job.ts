import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@colosseum/db';
import {
  ASSET_METRICS,
  type AssetMetric,
  METRIC_CADENCE,
  type MetricSources,
  metricPlan,
  type SolanaPriceMode,
} from '@colosseum/risk';
import { readRobinhoodMetrics } from '../../risk-evm/assets-metrics';
import sourcesJson from './metrics.sources.json';
import { type ListFile, printSummary, runChain } from './metrics-run';
import { readSolanaMetrics } from './metrics-solana';
import robinhoodList from './robinhood.json';
import solanaList from './solana.json';

// PLAN-ASSETS AS.6 — the hourly job of one chain's asset metrics: `com.colosseum.assets-solana` (minute 44) and
// `com.colosseum.assets-robinhood` (minute 38), each installed beside the collectors by its own installer
// (scripts/risk/assets/install-job-solana.sh, scripts/risk-evm/install-assets-job.sh), which edits none of their
// files and reloads none of their jobs (gate PRICE-JOB). Every hour it reads the hourly metrics and the prices; the
// daily ones (supply_issuer, holders_top20_share, dex_volume_24h_usd) when the run log holds no run of them in the
// last 23 hours. The lists and the reviewed map are put inside the bundle when it is built, because a launchd agent
// cannot read ~/Documents: a new list needs a new install.
//
// The installer writes into the bundle the chain (ASSET_METRICS_CHAIN), the folder of its answers and run log
// (ASSET_METRICS_DIR, no default here), and on Robinhood Chain the extract of the discovery file it made
// (ASSET_METRICS_RH_DISCOVERY). By hand:
//   ASSET_METRICS_CHAIN=solana ASSET_METRICS_DIR=<a folder of your own> DOTENV_CONFIG_PATH=<main>/.env \
//     tsx scripts/risk/assets/metrics-job.ts [--dry-run | --plan]
//   --dry-run  reads and prints; writes nothing (no row, no file, no run-log line)
//   --plan     loads the bundle, the list and the map, and prints what a run would read; no network, no database

const DAILY_WITHIN_MS = 23 * 3600 * 1000;
const args = process.argv.slice(2);
const chain = process.env.ASSET_METRICS_CHAIN as 'solana' | 'robinhood' | undefined;
if (chain !== 'solana' && chain !== 'robinhood')
  throw new Error('ASSET_METRICS_CHAIN is solana or robinhood');
const dir = process.env.ASSET_METRICS_DIR;
if (!dir)
  throw new Error('ASSET_METRICS_DIR names the folder of the answers and the run log: no default');
const dryRun = args.includes('--dry-run');
const sources = sourcesJson as unknown as MetricSources;
const list = (chain === 'solana' ? solanaList : robinhoodList) as unknown as ListFile;
const listFile = `scripts/risk/assets/${chain}.json`;
const sourcesFile = 'scripts/risk/assets/metrics.sources.json';
// a job writes no Solana price unless told `unresolved`; `all` changes the price job's rows and is refused here
const solanaPrices = (process.env.ASSET_METRICS_SOLANA_PRICES ?? 'none') as SolanaPriceMode;
if (solanaPrices !== 'none' && solanaPrices !== 'unresolved')
  throw new Error(`ASSET_METRICS_SOLANA_PRICES is none or unresolved, not ${solanaPrices}`);
const log = (l: string) => console.error(l);

/** Whether the daily metrics ran, not as a dry run, in the last 23 hours: the run log says. */
function dailyDue(): boolean {
  const f = join(dir as string, 'runs.jsonl');
  if (!existsSync(f)) return true;
  const now = Date.now();
  for (const line of readFileSync(f, 'utf8').trim().split('\n').reverse()) {
    try {
      const r = JSON.parse(line) as {
        kind?: string;
        chain?: string;
        dryRun?: boolean;
        at?: string;
        metrics?: string[];
      };
      if (r.kind !== 'asset-metrics-job' || r.chain !== chain || r.dryRun) continue;
      if (now - Date.parse(r.at ?? '') > DAILY_WITHIN_MS) return true;
      if (r.metrics?.includes('holders_top20_share') || r.metrics?.includes('dex_volume_24h_usd'))
        return false;
    } catch {
      // the last line may be being written
    }
  }
  return true;
}

const daily = dailyDue();
const metrics = ASSET_METRICS.filter((m: AssetMetric) => METRIC_CADENCE[m] === 'hourly' || daily);

if (args.includes('--plan')) {
  const reads: Record<string, number> = {};
  for (const a of list.assets)
    for (const [m, p] of Object.entries(metricPlan(a, { sources })))
      if (metrics.includes(m as AssetMetric)) {
        const k = 'read' in p ? `read ${p.read}` : `null ${p.reason}`;
        reads[k] = (reads[k] ?? 0) + 1;
      }
  console.log(
    JSON.stringify({
      chain,
      rows: list.assets.length,
      list: list.fetchedAt,
      daily,
      metrics,
      plan: reads,
      dir,
    }),
  );
  process.exit(0);
}

const { db, client } = createDb();
try {
  const { summary } = await runChain({
    chain,
    list,
    listFile,
    sources,
    sourcesFile,
    metrics,
    prices: true,
    solanaPrices,
    dryRun,
    dataDir: dir,
    db,
    kind: 'job',
    log,
    read: ({ reads, listMeta }) =>
      chain === 'solana'
        ? readSolanaMetrics({
            list: list.assets,
            sources,
            metrics,
            prices: true,
            db,
            riskHome: process.env.RISK_HOME ?? join(homedir(), '.colosseum', 'risk'),
            reads,
            list_: listMeta,
            sourcesFile,
            log,
          })
        : readRobinhoodMetrics({
            list: list.assets,
            sources,
            metrics,
            prices: true,
            db,
            reads,
            listMeta,
            sourcesFile,
            discovery: process.env.ASSET_METRICS_RH_DISCOVERY
              ? { extractFile: process.env.ASSET_METRICS_RH_DISCOVERY }
              : { dir: process.env.RISK_EVM_DIR ?? join('data', 'risk-evm') },
            log,
          }),
  });
  printSummary(summary, log);
  console.log(JSON.stringify({ ...summary, reads: undefined, errorsByToken: undefined }));
} finally {
  await client.end();
}
