import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@colosseum/db';
import { ASSET_METRICS, type MetricSources, type SolanaPriceMode } from '@colosseum/risk';
import { readRobinhoodMetrics, robinhoodDiscoveryDir } from '../../risk-evm/assets-metrics';
import { parseMetrics } from './metrics-io';
import { type ListFile, printSummary, runChain } from './metrics-run';
import { readSolanaMetrics } from './metrics-solana';

// PLAN-ASSETS AS.5 — the metrics import: every metric of every row of a chain's asset list, from free sources, into
// asset_observations, and the aggregators' prices into risk_price_observations as the price job allows.
//
//   pnpm risk:assets-import <solana|robinhood|all> [--dry-run] [--metrics a,b] [--from <answers.jsonl.gz>]
//                           [--data-dir <dir>] [--solana-prices none|unresolved|all]
//
//   --dry-run        reads and prints; writes nothing (no row, no answers file, no run-log line)
//   --metrics        some of: supply_total, supply_issuer, holders_top20_share, pool_tvl_usd, dex_volume_24h_usd,
//                    protocol_tvl_usd, exchange_rate, yield_realised_30d, yield_quoted, price_usd (all by default)
//   --from           build from a saved run's answers, with no network (one chain); a second pass inserts nothing
//   --data-dir       where answers and runs.jsonl go (ASSETS_DATA_DIR, else data/assets)
//   --answers-out    also write the answers to this file (<chain> is replaced), a dry run included
//   --only           read only these tokens (symbols or addresses, comma-separated): a try, or a fixture's run
//   --show           print the rows and prices of these tokens (symbols or addresses, comma-separated)
//   --solana-prices  none (default): no Solana price is written, every one is kept in the answers; unresolved: the
//                    prices of assets the installed price job does not value, no later than its newest hour; all:
//                    every price (it changes that job's rows for the assets it values: never the default)
//
// Solana reads SOLANA_RPC_URL through dotenv: run it with DOTENV_CONFIG_PATH=<main checkout>/.env. Robinhood Chain
// reads the public RPC (RISK_EVM_RH_RPC_URL replaces it) outside UTC minutes 1 to 14, and the discovery file under
// RISK_EVM_DIR (read only).

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const which = args[0];
if (!which || !['solana', 'robinhood', 'all'].includes(which)) {
  console.error(
    'usage: pnpm risk:assets-import <solana|robinhood|all> [--dry-run] [--metrics a,b] [--from <file>]',
  );
  process.exit(1);
}
const from = opt('--from');
if (from && which === 'all') throw new Error('--from takes one chain');
const solanaPrices = (opt('--solana-prices') ?? 'none') as SolanaPriceMode;
if (!['none', 'unresolved', 'all'].includes(solanaPrices))
  throw new Error(`--solana-prices ${solanaPrices}`);
const { metrics, prices } = parseMetrics(opt('--metrics'), ASSET_METRICS);
const dryRun = args.includes('--dry-run');
const dataDir = opt('--data-dir') ?? process.env.ASSETS_DATA_DIR ?? join('data', 'assets');
const SOURCES_FILE = 'scripts/risk/assets/metrics.sources.json';
const sources = JSON.parse(readFileSync(SOURCES_FILE, 'utf8')) as MetricSources;
const riskHome = process.env.RISK_HOME ?? join(homedir(), '.colosseum', 'risk');
const log = (l: string) => console.error(l);

const { db, client } = createDb();
try {
  const chains: Array<'solana' | 'robinhood'> =
    which === 'all' ? ['solana', 'robinhood'] : [which as 'solana' | 'robinhood'];
  for (const chain of chains) {
    const listFile = `scripts/risk/assets/${chain}.json`;
    const list = JSON.parse(readFileSync(listFile, 'utf8')) as ListFile;
    // --only <symbols or addresses>: a part of the list, to try a read or to freeze a fixture; never a job's run
    const only = opt('--only')?.split(',');
    if (only)
      list.assets = list.assets.filter((a) => only.includes(a.symbol) || only.includes(a.address));
    const {
      summary: s,
      rows,
      prices: px,
    } = await runChain({
      chain,
      list,
      listFile,
      sources,
      sourcesFile: SOURCES_FILE,
      metrics,
      prices,
      solanaPrices,
      dryRun,
      from,
      answersOut: opt('--answers-out')?.replace('<chain>', chain),
      dataDir,
      db,
      kind: 'import',
      log,
      read: ({ reads, listMeta }) =>
        chain === 'solana'
          ? readSolanaMetrics({
              list: list.assets,
              sources,
              metrics,
              prices,
              db,
              riskHome,
              reads,
              list_: listMeta,
              sourcesFile: SOURCES_FILE,
              log,
            })
          : readRobinhoodMetrics({
              list: list.assets,
              sources,
              metrics,
              prices,
              db,
              reads,
              listMeta,
              sourcesFile: SOURCES_FILE,
              discovery: { dir: robinhoodDiscoveryDir() },
              log,
            }),
    });
    printSummary(s, log);
    // --show <symbol or address>: the rows and prices of those tokens, for a person to read
    const show = opt('--show')?.split(',');
    if (show) {
      const hit = new Set(
        list.assets
          .filter((a) => show.includes(a.symbol) || show.includes(a.address))
          .map((a) => a.address),
      );
      for (const r of rows.filter((x) => hit.has(x.address))) console.log(JSON.stringify(r));
      for (const p of px.filter((x) => hit.has(x.mint))) console.log(JSON.stringify(p));
    }
  }
} finally {
  await client.end();
}
