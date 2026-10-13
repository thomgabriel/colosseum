import { readFileSync, writeFileSync } from 'node:fs';
import { CHAINS } from './config';
import type { DexPair } from './pools';
import {
  SHELF_POOLS_METHOD,
  SHELF_POOLS_METHOD_VERSION,
  type ShelfPoolsFile,
  type ShelfPoolsToken,
  type ShelfRow,
  shelfPoolsOf,
  shelfTokens,
} from './shelf';

// `pnpm risk-evm:shelf-pools [--out <file>] [--min-pool-usd 10000]` (PLAN-ASSETS AS.12, ledger ASSET-3): the pools of
// the Robinhood Chain shelf's tokens that the asset list does not track, for the hourly loop's `--list --shelf`
// (shelf.ts says what the loop does with them). Reads scripts/risk/assets/shelf-robinhood.json (the shelf),
// scripts/risk/universe/robinhood.json (the tracked stocks) and scripts/risk/assets/robinhood.json (decimals); asks
// DexScreener's token-pairs/v1/robinhood/<token> once per added token, one call every 1.1 seconds, a failed call once
// more after 5 seconds. Public GETs only: no RPC call, no key. Writes scripts/risk/assets/shelf-pools-robinhood.json
// (committed: the loop reads it at its start, as it reads the list), or --out.
const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const SHELF = 'scripts/risk/assets/shelf-robinhood.json';
const LIST = 'scripts/risk/universe/robinhood.json';
const ASSETS = 'scripts/risk/assets/robinhood.json';
const out = opt('--out') ?? 'scripts/risk/assets/shelf-pools-robinhood.json';
/** The hourly loop's own floor for a DexScreener pool (collect.ts MIN_POOL_USD). */
const minLiquidityUsd = Number(opt('--min-pool-usd') ?? 10_000);
const chain = CHAINS.find((c) => c.id === 'robinhood');
if (!chain) throw new Error('robinhood is not in config.ts');
const read = <T>(f: string) => JSON.parse(readFileSync(f, 'utf8')) as T;
const shelf = read<{ rows: ShelfRow[]; method?: string; reading?: unknown }>(SHELF);
const list = read<{ assets: Array<{ address: string }> }>(LIST);
const assets = read<{ assets: Array<{ address: string; decimals: number | null }> }>(ASSETS);
const { add, notAdded } = shelfTokens(shelf.rows, {
  dollar: chain.dollar,
  tracked: new Set(list.assets.map((a) => a.address.toLowerCase())),
  decimals: new Map(
    assets.assets
      .filter((a) => a.decimals !== null)
      .map((a) => [a.address.toLowerCase(), a.decimals as number]),
  ),
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const URL = `https://api.dexscreener.com/token-pairs/v1/${chain.dexscreener}`;
async function pairsOf(address: string): Promise<DexPair[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${URL}/${address}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as unknown;
      if (!Array.isArray(body)) throw new Error('not a list of pairs');
      return body as DexPair[];
    } catch (e) {
      if (attempt >= 1) throw e;
      await sleep(5_000);
    }
  }
}
const tokens: ShelfPoolsToken[] = [];
for (const t of add) {
  const at = new Date().toISOString();
  try {
    const pairs = await pairsOf(t.address);
    const { pools, againstDollar } = shelfPoolsOf(chain, t, pairs, { minLiquidityUsd, at });
    tokens.push({
      ...t,
      pools,
      dexscreener: { pairs: pairs.length, againstDollar, kept: pools.length },
    });
  } catch (e) {
    tokens.push({ ...t, pools: [], dexscreener: { error: String(e).slice(0, 200) } });
  }
  await sleep(1_100);
}
const file: ShelfPoolsFile = {
  chain: chain.id,
  chainId: chain.chainId,
  methodVersion: SHELF_POOLS_METHOD_VERSION,
  method: SHELF_POOLS_METHOD,
  source: `${URL}/{token} (public, no key)`,
  fetchedAt: new Date().toISOString(),
  provenance: 'live',
  shelf: { file: SHELF, method: shelf.method ?? null, reading: shelf.reading ?? null },
  list: LIST,
  dollar: { symbol: chain.dollar.symbol, address: chain.dollar.address.toLowerCase() },
  minLiquidityUsd,
  counts: {
    shelf: shelf.rows.length,
    tracked: notAdded.filter((n) => n.reason.startsWith('tracked_by_the_list')).length,
    added: tokens.length,
    notAdded: notAdded.length,
    pools: tokens.reduce((n, t) => n + t.pools.length, 0),
    reachable: tokens.reduce((n, t) => n + t.pools.filter((p) => p.reachable).length, 0),
  },
  tokens,
  notAdded,
};
writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      out,
      counts: file.counts,
      tokens: tokens.map(
        (t) =>
          `${t.symbol} ${t.pools.filter((p) => p.reachable).length} of ${t.pools.length} pools on Uniswap${'error' in t.dexscreener ? ` (${t.dexscreener.error})` : ''}`,
      ),
      notAdded: notAdded.filter((n) => !n.reason.startsWith('tracked_by_the_list')),
    },
    null,
    1,
  ),
);
