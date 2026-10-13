// The hourly loop on the shelf's tokens (PLAN-ASSETS AS.12, ledger ASSET-3). A list run (`--list`) measures the tracked
// stocks with the pools of the cut; `--list --shelf` adds every other token of the Robinhood Chain shelf
// (scripts/risk/assets/shelf-robinhood.json), with the pools of a committed file written by `pnpm risk-evm:shelf-pools`
// (scripts/risk/assets/shelf-pools-robinhood.json): DexScreener's pairs of the token against the dollar token, of at
// least `minLiquidityUsd`, every one of them. The Uniswap ones go to the same on-chain confirmation as the cut's pools
// (the factory's getPool, the position manager's poolKeys, no hook) when the loop confirms its pool list, and each gets
// a pool row; a pool the chain does not confirm says `not_confirmed_on_chain`. No I/O here.
import type { ChainConfig, TokenConfig } from './config';
import type { ListedPool, ListRun } from './listed';
import { candidates, type DexPair } from './pools';

export const SHELF_POOLS_METHOD_VERSION = 'evm-shelf-pools-0.1';
export const SHELF_POOLS_METHOD = 'dexscreener_pairs_against_the_dollar_token';
/** DexScreener's dexId of Uniswap v3 and v4 on Robinhood Chain, the venue the vault's swap path reaches. */
export const UNISWAP = 'uniswap';

/** A row of the shelf file (shelf.ts of scripts/risk/assets), as far as this reads it. */
export type ShelfRow = { address: string; symbol: string; cls: string | null };

export type ShelfPoolsToken = TokenConfig & {
  cls: string | null;
  pools: ListedPool[];
  /** DexScreener's answer for the token: pairs listed, of them against the dollar token, kept by the floor. */
  dexscreener: { pairs: number; againstDollar: number; kept: number } | { error: string };
};

export type ShelfPoolsFile = {
  chain: string;
  chainId: number;
  methodVersion: typeof SHELF_POOLS_METHOD_VERSION;
  method: typeof SHELF_POOLS_METHOD;
  source: string;
  fetchedAt: string;
  provenance: 'live';
  /** The shelf file, and the time of its volume readings. */
  shelf: { file: string; method: string | null; reading: unknown };
  /** The asset list whose tracked tokens are measured already, so are not repeated here. */
  list: string;
  dollar: { symbol: string; address: string };
  minLiquidityUsd: number;
  counts: {
    shelf: number;
    tracked: number;
    added: number;
    notAdded: number;
    pools: number;
    reachable: number;
  };
  tokens: ShelfPoolsToken[];
  /** Shelf tokens this file does not add, with the reason. */
  notAdded: Array<{ symbol: string; address: string; reason: string }>;
};

const lower = (s: string) => s.toLowerCase();

/**
 * Which shelf tokens the file adds: not the dollar token (the one every quote is in), not a token the list tracks
 * (its pools are the cut's), and only with known decimals. The order is the shelf's.
 */
export function shelfTokens(
  rows: ShelfRow[],
  opts: {
    dollar: { address: string };
    tracked: ReadonlySet<string>;
    decimals: ReadonlyMap<string, number>;
  },
): {
  add: Array<TokenConfig & { cls: string | null }>;
  notAdded: ShelfPoolsFile['notAdded'];
} {
  const add: Array<TokenConfig & { cls: string | null }> = [];
  const notAdded: ShelfPoolsFile['notAdded'] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const a = lower(r.address);
    const no = (reason: string) => notAdded.push({ symbol: r.symbol, address: a, reason });
    if (seen.has(a)) no('listed_twice_on_the_shelf');
    else if (a === lower(opts.dollar.address))
      no('the_dollar_token: every quote is in it, counted as one dollar');
    else if (opts.tracked.has(a)) no('tracked_by_the_list: measured with the cut’s pools');
    else if (!Number.isInteger(opts.decimals.get(a))) no('no_decimals_in_the_asset_list');
    else
      add.push({
        symbol: r.symbol,
        address: a,
        decimals: opts.decimals.get(a) as number,
        cls: r.cls,
      });
    seen.add(a);
  }
  return { add, notAdded };
}

/** A shelf token's pools from DexScreener's pairs: against the dollar token, at least the floor, deepest first. */
export function shelfPoolsOf(
  chain: Pick<ChainConfig, 'dexscreener' | 'dollar' | 'v4'>,
  token: TokenConfig,
  pairs: DexPair[],
  opts: { minLiquidityUsd: number; at: string },
): { pools: ListedPool[]; againstDollar: number } {
  const all = candidates(pairs, chain, token, {
    minLiquidityUsd: 0,
    limit: Number.MAX_SAFE_INTEGER,
  });
  const kept = all.filter((c) => c.liquidityUsd >= opts.minLiquidityUsd);
  return {
    againstDollar: all.length,
    pools: kept.map((c) => ({
      id: c.id,
      kind: c.kind,
      venue: c.dex,
      other: lower(chain.dollar.address),
      otherSymbol: chain.dollar.symbol,
      otherIsStock: false,
      // the vault swaps through Uniswap only (DU3): another venue's pool is kept in the file and never asked, as the
      // cut's unreachable pools are. A Uniswap pool is a candidate: whether the factory names it, or a v4 pool has no
      // hook, is the chain's word when the loop confirms its pools (a pool it does not confirm: `not_confirmed_on_chain`)
      reachable: c.dex === UNISWAP,
      tvlUsd: c.liquidityUsd,
      tvlAt: opts.at,
    })),
  };
}

const fail = (m: string): never => {
  throw new Error(`shelf run: ${m}`);
};

/**
 * A list run with the shelf's other tokens added. Refuses a file of another chain, a token the list already tracks, a
 * symbol the list already uses (the run keys tokens by symbol) and the dollar token.
 */
export function withShelf(
  chain: ChainConfig,
  run: { tokens: TokenConfig[]; listed: ListRun },
  file: ShelfPoolsFile,
  name: string,
): { tokens: TokenConfig[]; listed: ListRun } {
  if (file.chain !== chain.id || file.chainId !== chain.chainId)
    fail(`${name} is for ${file.chain} (${file.chainId}), not ${chain.id}`);
  if (lower(file.dollar.address) !== lower(chain.dollar.address))
    fail(`${name} quotes against ${file.dollar.symbol}, not ${chain.dollar.symbol}`);
  const addresses = new Set(run.tokens.map((t) => lower(t.address)));
  const symbols = new Set(run.tokens.map((t) => t.symbol));
  const pools = { ...run.listed.pools };
  const added: TokenConfig[] = [];
  for (const t of file.tokens) {
    if (lower(t.address) === lower(chain.dollar.address)) fail(`${name} adds the dollar token`);
    if (addresses.has(lower(t.address)))
      fail(`${name} adds ${t.symbol}, which the list tracks: write the file again`);
    if (symbols.has(t.symbol)) fail(`${name} adds a second ${t.symbol}`);
    addresses.add(lower(t.address));
    symbols.add(t.symbol);
    pools[t.symbol] = [...t.pools].sort(
      (x, y) => (y.tvlUsd ?? 0) - (x.tvlUsd ?? 0) || (x.id < y.id ? -1 : 1),
    );
    added.push({ symbol: t.symbol, address: t.address, decimals: t.decimals });
  }
  return {
    tokens: [...run.tokens, ...added],
    listed: {
      ...run.listed,
      pools,
      // a hand-list token the shelf adds (TSM) is read again, by the shelf's pools
      handListNotTracked: run.listed.handListNotTracked.filter(
        (s) => !added.some((t) => t.symbol === s),
      ),
      shelf: { file: name, tokens: added.map((t) => t.symbol) },
    },
  };
}
