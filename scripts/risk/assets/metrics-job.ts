import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@colosseum/db';
import {
  type AssetMetric,
  type MetricSources,
  metricPlan,
  type SolanaPriceMode,
} from '@colosseum/risk';
import robinhoodMainnet from '../../../deployments/robinhood-mainnet.json';
import robinhoodTestnet from '../../../deployments/robinhood-testnet.json';
import solanaDevnet from '../../../deployments/solana-devnet.json';
import { readRobinhoodMetrics } from '../../risk-evm/assets-metrics';
import { CHAINS, rpcFor } from '../../risk-evm/config';
import sourcesJson from './metrics.sources.json';
import { type ListFile, printSummary, runChain } from './metrics-run';
import {
  type DeployRecord,
  dailyDue,
  dailyParts,
  type MetricsScope,
  runPlan,
  servedAssets,
} from './metrics-schedule';
import { readSolanaMetrics } from './metrics-solana';
import {
  exitCleanlyWhenOffline,
  exitOffline,
  hostOf,
  type NetTarget,
  waitForNetwork,
} from './network-wait';
import robinhoodList from './robinhood.json';
import shelfRobinhood from './shelf-robinhood.json';
import shelfSolana from './shelf-solana.json';
import solanaList from './solana.json';
import { outsideWriteWindow, parseWriteWindow, readDeadline } from './write-window';

// PLAN-ASSETS AS.6 — the hourly job of one chain's asset metrics: `com.colosseum.assets-solana` (minute 44) and
// `com.colosseum.assets-robinhood` (minute 38), each installed beside the collectors by its own installer
// (scripts/risk/assets/install-job-solana.sh, scripts/risk-evm/install-assets-job.sh), which edits none of their
// files and reloads none of their jobs (gate PRICE-JOB). Every hour it reads the hourly metrics and the prices; each
// daily part (supply_issuer, holders_top20_share, dex_volume_24h_usd, and in the hosted job SOL's supply) when no run
// in the last 23 hours read it in full (metrics-schedule.ts). The lists, the shelves, the deploy records and the
// reviewed map are put inside the bundle when it is built, because a launchd agent cannot read ~/Documents: a new
// list needs a new install.
//
// The installer writes into the bundle the chain (ASSET_METRICS_CHAIN), the folder of its answers and run log
// (ASSET_METRICS_DIR, no default here), and on Robinhood Chain the extract of the discovery file it made
// (ASSET_METRICS_RH_DISCOVERY); for the hosted job (`--hosted`, gate ASSET-METRICS amended 2026-10-22) also the rows
// it reads (ASSET_METRICS_SCOPE=served: the rows the asset lookups answer for) and its write window
// (ASSET_METRICS_WRITE_WINDOW=10-25: a run started outside minutes 10 to 25 UTC does nothing; its slow reads stop
// 90 s before :25 and what they did not reach is read the next hour; past :25 it writes nothing). A scheduled hosted
// run waits up to two minutes for the network, and a run with none ends with one line, not a crash. By hand:
//   ASSET_METRICS_CHAIN=solana ASSET_METRICS_DIR=<a folder of your own> DOTENV_CONFIG_PATH=<main>/.env \
//     tsx scripts/risk/assets/metrics-job.ts [--dry-run | --plan] [--scope all|served] [--write-window 10-25]
//   --dry-run  reads and prints; writes nothing (no row, no file, no run-log line)
//   --plan     loads the bundle, the list and the map, and prints what a run would read; no network, no database

const args = process.argv.slice(2);
const opt = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const chain = process.env.ASSET_METRICS_CHAIN as 'solana' | 'robinhood' | undefined;
if (chain !== 'solana' && chain !== 'robinhood')
  throw new Error('ASSET_METRICS_CHAIN is solana or robinhood');
const dir = process.env.ASSET_METRICS_DIR;
if (!dir)
  throw new Error('ASSET_METRICS_DIR names the folder of the answers and the run log: no default');
const dryRun = args.includes('--dry-run');
const scope = (opt('--scope') ?? process.env.ASSET_METRICS_SCOPE ?? 'all') as MetricsScope;
if (scope !== 'all' && scope !== 'served')
  throw new Error(`the scope is all or served, not ${scope}`);
const windowText = opt('--write-window') ?? process.env.ASSET_METRICS_WRITE_WINDOW;
const window = windowText ? parseWriteWindow(windowText) : null;
if (windowText && !window)
  throw new Error(`--write-window is <from>-<to> in minutes, not ${windowText}`);
const sources = sourcesJson as unknown as MetricSources;
const fullList = (chain === 'solana' ? solanaList : robinhoodList) as unknown as ListFile;
// the hosted job reads only the rows the asset lookups answer for (metrics-schedule.ts)
const list: ListFile =
  scope === 'served'
    ? {
        ...fullList,
        assets: servedAssets(
          chain,
          fullList.assets,
          (chain === 'solana' ? shelfSolana : shelfRobinhood).rows.map((r) => r.address),
          [robinhoodMainnet, robinhoodTestnet, solanaDevnet] as DeployRecord[],
        ),
      }
    : fullList;
const listFile = `scripts/risk/assets/${chain}.json`;
const sourcesFile = 'scripts/risk/assets/metrics.sources.json';
// a job writes no Solana price unless told `unresolved`; `all` changes the price job's rows and is refused here
const solanaPrices = (process.env.ASSET_METRICS_SOLANA_PRICES ?? 'none') as SolanaPriceMode;
if (solanaPrices !== 'none' && solanaPrices !== 'unresolved')
  throw new Error(`ASSET_METRICS_SOLANA_PRICES is none or unresolved, not ${solanaPrices}`);
const log = (l: string) => console.error(l);

const runLog = join(dir, 'runs.jsonl');
const parts = dailyParts(scope, chain);
const due = dailyDue(
  existsSync(runLog) ? readFileSync(runLog, 'utf8') : '',
  chain,
  Date.now(),
  parts,
);
const { metrics, skipReads, daily } = runPlan(due, parts);

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
      of: fullList.assets.length,
      scope,
      list: list.fetchedAt,
      daily,
      skipReads: [...skipReads],
      window,
      metrics,
      plan: reads,
      dir,
    }),
  );
  process.exit(0);
}

// a scheduled hosted run: inside its window, and with the network, or it does nothing
const t0 = Date.now();
let deadline: number | undefined;
if (window && !dryRun) {
  if (outsideWriteWindow(t0, t0, window)) {
    console.log(
      JSON.stringify({
        kind: 'asset-metrics-job',
        chain,
        at: new Date(t0).toISOString(),
        skipped: `started outside minutes ${window.from} to ${window.to} UTC: nothing read or written; the next run reads`,
      }),
    );
    process.exit(0);
  }
  deadline = readDeadline(t0, window);
  const rpcHost = hostOf(
    chain === 'solana'
      ? process.env.SOLANA_RPC_URL
      : rpcFor(CHAINS.find((c) => c.id === 'robinhood') as (typeof CHAINS)[number]).url,
  );
  const dbHost = hostOf(process.env.DATABASE_URL);
  const targets: NetTarget[] = [
    ...(rpcHost ? [{ host: rpcHost, port: 443 }] : []),
    ...(dbHost ? [{ host: dbHost }] : []),
  ];
  exitCleanlyWhenOffline(`asset-metrics-${chain}`, targets);
  const offline = await waitForNetwork(targets, {
    until: Math.min(t0 + 120_000, deadline),
    log,
  });
  if (offline) exitOffline(`asset-metrics-${chain}`, offline);
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
    daily,
    ...(window ? { mayWrite: () => !outsideWriteWindow(t0, Date.now(), window) } : {}),
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
            skipReads,
            deadline,
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
            deadline,
          }),
  });
  printSummary(summary, log);
  console.log(JSON.stringify({ ...summary, reads: undefined, errorsByToken: undefined }));
} finally {
  await client.end();
}
