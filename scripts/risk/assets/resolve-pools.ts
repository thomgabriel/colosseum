// `pnpm risk:assets-resolve-pools [--dry-run]` (PLAN-ASSETS AS.13): the tokens of every Robinhood Chain pool the
// backfill holds swaps of and RU.2's creation logs do not name, read once from the chain and kept for reuse in
// <ASSETS_DATA_DIR>/robinhood/pool-tokens.json (not committed), so `pnpm risk:assets-bars robinhood --source
// backfill` can file their swaps. The reads are PoolResolver's (`poolTokensOf`): token0(), token1() and factory()
// of a v3-style pool, poolKeys(id) of the v4 position manager, through Multicall3, 400 calls a request.
//
// Only through the backfill's own metered endpoint: ROBINHOOD_BACKFILL_RPC_URL (run with DOTENV_CONFIG_PATH at
// the main checkout's .env; this file never reads it, and never prints the URL). Every request is priced into
// <ASSETS_DATA_DIR>/robinhood/cost-ledger.json under ROBINHOOD_BACKFILL_USD_CAP (default $5), the ledger and the
// cap the running logs fetch shares (backfill-cost.ts). Without that variable the command refuses to run.
// A pool already in the file is not asked again; --dry-run counts the pools and the requests and asks nothing.
import 'dotenv/config';
import './backfill-env';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { type Deps, poolTokensOf } from '../../risk-evm/backfill-logs';
import { CHAINS, type ChainConfig, rpcFor } from '../../risk-evm/config';
import { rpcOver } from '../../risk-evm/replay';
import { createRpc, type Rpc } from '../../risk-evm/rpc';
import { cuOf, meteredBatch, USD_PER_MILLION_CU } from './backfill-cost';
import { BACKFILL_ENDPOINTS, KEEP_QUIET_MINUTES } from './backfill-env';
import { POOL_TOKENS_FILE, type PoolTokensFile, readPoolTokens } from './bars-backfill';

/** No endpoint's URL is printed: an error or a log line naming one shows `<url>` instead. */
const redact = (x: string) => x.replace(/(https?|wss?):\/\/[^\s"']+/g, '<url>');

async function main() {
  const dry = process.argv.includes('--dry-run');
  const out = process.env.ASSETS_DATA_DIR ?? 'data/assets';
  const evm = process.env.RISK_EVM_DIR ?? 'data/risk-evm';
  const chain = CHAINS.find((c) => c.id === 'robinhood') as ChainConfig;
  const root = join(out, 'robinhood');
  const creation = JSON.parse(readFileSync(join(evm, 'creation-logs-robinhood.json'), 'utf8')) as {
    created: Array<{ id: string }>;
  };
  const known = new Set(creation.created.map((c) => c.id.toLowerCase()));
  const have = readPoolTokens(out);
  const subjects = readdirSync(join(root, 'swaps'))
    .map((s) => s.toLowerCase())
    .filter((s) => !known.has(s) && !have[s])
    .sort()
    .map((s): [string, 'cl' | 'v4'] => [s, s.length === 66 ? 'v4' : 'cl']);
  const calls = subjects.reduce((a, [, k]) => a + (k === 'v4' ? 1 : 3), 0);
  const requests = Math.ceil(calls / 400);
  const estimate = {
    pools: subjects.length,
    v4: subjects.filter(([, k]) => k === 'v4').length,
    cl: subjects.filter(([, k]) => k === 'cl').length,
    calls,
    requests,
    usd: +(((requests * cuOf('eth_call')) / 1e6) * USD_PER_MILLION_CU).toFixed(6),
  };
  if (dry || !subjects.length) {
    console.log(
      JSON.stringify({ dryRun: dry, alreadyResolved: Object.keys(have).length, estimate }, null, 1),
    );
    return;
  }
  if (!BACKFILL_ENDPOINTS.robinhood)
    throw new Error(
      'ROBINHOOD_BACKFILL_RPC_URL is not set: this command asks only the metered backfill endpoint',
    );
  const ledgerFile = join(root, 'cost-ledger.json');
  const ledgerUsd = () =>
    existsSync(ledgerFile)
      ? (JSON.parse(readFileSync(ledgerFile, 'utf8')) as { usd: number }).usd
      : 0;
  const before = ledgerUsd();
  const clientFor = (timeoutMs: number): Rpc => {
    const plain = createRpc(rpcFor(chain).url, { timeoutMs, retries: 0 });
    return rpcOver(
      meteredBatch(plain.batch, {
        ledgerFile,
        capUsd: Number(process.env.ROBINHOOD_BACKFILL_USD_CAP ?? 5),
        endpoint: BACKFILL_ENDPOINTS.robinhood as string,
      }),
      plain.stats,
    );
  };
  const deps: Deps = {
    rpc: clientFor(120_000),
    rpcFor: clientFor,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => new Date(),
    log: (e) => console.error(redact(JSON.stringify({ at: new Date().toISOString(), ...e }))),
    quietMinutes: KEEP_QUIET_MINUTES,
  };
  const file: PoolTokensFile = {
    chain: 'robinhood',
    source: `Robinhood Chain eth_call by Multicall3 through ${BACKFILL_ENDPOINTS.robinhood} (metered): token0(), token1() and factory() of each v3-style pool, poolKeys(id) of the v4 position manager ${chain.v4?.positionManager}`,
    method: 'pool_tokens_by_multicall_at_head (PoolResolver, poolTokensOf)',
    provenance: 'live',
    updatedAt: new Date().toISOString(),
    pools: { ...have },
  };
  const save = () => {
    file.updatedAt = new Date().toISOString();
    mkdirSync(root, { recursive: true });
    const tmp = join(root, `${POOL_TOKENS_FILE}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(file)}\n`);
    renameSync(tmp, join(root, POOL_TOKENS_FILE));
  };
  let asked = 0;
  // 4,000 pools a piece, saved after each, so a run stopped by the cap keeps what it read
  for (let i = 0; i < subjects.length; i += 4000) {
    const part = subjects.slice(i, i + 4000);
    const got = await poolTokensOf(deps, chain, part);
    asked += got.requests;
    const at = new Date().toISOString();
    for (const [k, t] of got.pools) file.pools[k] = { ...t, resolvedAt: at };
    save();
    deps.log({ event: 'piece', pools: Object.keys(file.pools).length, requests: asked });
  }
  const pools = Object.values(file.pools);
  console.log(
    JSON.stringify(
      {
        estimate,
        requests: asked,
        resolved: pools.filter((p) => p.token0 && p.token1).length,
        notAPool: pools.filter((p) => !p.token0 || !p.token1).length,
        otherVenue: pools.filter((p) => p.kind === 'cl' && p.token0 && p.uniswap === false).length,
        ledgerUsd: { before, after: ledgerUsd() },
        file: join(root, POOL_TOKENS_FILE),
      },
      null,
      1,
    ),
  );
}

if (import.meta.url === `file://${process.argv[1]}`)
  main().catch((e) => {
    console.error(redact(e instanceof Error ? e.message : String(e)));
    process.exit(1);
  });
