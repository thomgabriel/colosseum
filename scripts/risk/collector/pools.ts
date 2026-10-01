// Pool snapshot collector (Step 2). Bundled by scripts/risk/collector/install.sh into a single file that
// launchd runs from ~/.colosseum (macOS blocks launchd agents from reading ~/Documents). Every run:
//   Tier A pools: re-read pool headers (and, for DLMM / CPMM, the bins / vaults that swaps change),
//   rebuild state from cached tick maps, check the liquidity invariant, simulate sell and buy curves.
//   Tier B pools: the same, once an hour.
//   Tick / bin account lists are re-discovered hourly with getProgramAccounts, or at once when the
//   invariant shows the cached map is stale (an LP added or removed liquidity: recorded as an event).
// Writes JSONL rows with source, fetchedAt, method, method_version. Never retries a failed run itself.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  bandTicksFor,
  CLMM_POSITION_POOL_OFFSET,
  CLMM_POSITION_SIZE,
  CLMM_TICK_ARRAY_POOL_OFFSET,
  type ClState,
  clmmState,
  clSim,
  concentration,
  cpSim,
  DLMM_BIN_ARRAY_PAIR_OFFSET,
  decodeClmmAmmConfig,
  decodeClmmPool,
  decodeClmmPosition,
  decodeClmmTickArray,
  decodeCpmmAmmConfig,
  decodeCpmmPool,
  decodeDlmmBinArray,
  decodeDlmmPair,
  decodeWhirlpool,
  decodeWpPosition,
  decodeWpTickArray,
  dlmmFeeRate,
  dlmmSim,
  inBandWeight,
  type PoolSim,
  usdCurves,
  WP_DYNAMIC_TICK_ARRAY_POOL_OFFSET,
  WP_FIXED_TICK_ARRAY_POOL_OFFSET,
  WP_POSITION_POOL_OFFSET,
  WP_POSITION_SIZE,
  whirlpoolState,
  withoutPositions,
} from '@colosseum/risk';

export const COLLECTOR_METHOD_VERSION = 'pools-0.1';
const HOME = process.env.RISK_HOME ?? join(homedir(), '.colosseum', 'risk');
const RPC_URL = process.env.SOLANA_RPC_URL ?? '';
const NOTIONALS = [100, 500, 2_500, 10_000, 50_000, 250_000, 1_000_000, 5_000_000];
const BAND_PCT = 0.02;
const CHILD_REFRESH_MIN = 60;
const RAW_TOP_SHARE = 0.8;
/** LP-withdrawal alarm: in-band depth drop (policy input) when the tick map changed in the same run. */
const WITHDRAWAL_ALARM = Number(process.env.RISK_WITHDRAWAL_ALARM ?? 0.2);
/** LP-exit stress: number of largest in-band positions removed (policy input). */
const LP_EXIT_N = Number(process.env.RISK_LP_EXIT_N ?? 3);
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const SOL = 'So11111111111111111111111111111111111111112';

type RegPool = {
  address: string;
  venue: 'raydium_clmm' | 'orca_whirlpool' | 'meteora_dlmm' | 'raydium_cpmm';
  program: string;
  assetMint: string;
  assetSymbol: string;
  quoteMint: string;
  quoteSymbol: string | null;
  exitPath: string;
  assetIsToken0: number;
  vault0: string;
  vault1: string;
  decimals0: number;
  decimals1: number;
  transferFeeBps0: number;
  transferFeeBps1: number;
  tvlUsd: number;
  tier: 'A' | 'B';
};
type Cache = {
  children: Record<string, string[]>;
  childrenAt: Record<string, string>;
  /** Decoded initialized ticks [tick, liquidityNet] for concentrated-liquidity pools. */
  ticks: Record<string, Array<[number, number]>>;
  configs: Record<string, string>;
  /** Last in-band (±2%) sell depth in quote UI units, per pool. */
  lastDepth?: Record<string, number>;
};
const isCl = (p: RegPool) => p.venue === 'raydium_clmm' || p.venue === 'orca_whirlpool';

const stats = { calls: 0, retries429: 0, errors: 0 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  for (let attempt = 0; attempt < 6; attempt++) {
    stats.calls++;
    try {
      const res = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(30_000),
      });
      const j = (await res.json().catch(() => ({ error: { code: res.status } }))) as {
        result?: T;
        error?: { code?: number; message?: string };
      };
      if (res.status === 429 || j.error?.code === 429) {
        stats.retries429++;
        await sleep(500 * 2 ** attempt);
        continue;
      }
      if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
      return j.result as T;
    } catch (e) {
      stats.errors++;
      if (attempt === 5) throw e;
      await sleep(500 * 2 ** attempt);
    }
  }
  throw new Error(`${method}: rate-limited after 6 attempts`);
}
const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
async function getMultiple(keys: string[]): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < keys.length; i += 100) {
    const batch = keys.slice(i, i + 100);
    const r = await rpc<{
      context: { slot: number };
      value: Array<{ data: [string, string] } | null>;
    }>('getMultipleAccounts', [batch, { encoding: 'base64' }]);
    lastSlot = r.context.slot;
    r.value.forEach((v, k) => {
      if (v) out.set(batch[k] as string, b64(v.data[0]));
    });
  }
  return out;
}
let lastSlot = 0;
async function discoverChildren(p: RegPool): Promise<string[]> {
  const filters: number[] =
    p.venue === 'raydium_clmm'
      ? [CLMM_TICK_ARRAY_POOL_OFFSET]
      : p.venue === 'orca_whirlpool'
        ? [WP_FIXED_TICK_ARRAY_POOL_OFFSET, WP_DYNAMIC_TICK_ARRAY_POOL_OFFSET]
        : p.venue === 'meteora_dlmm'
          ? [DLMM_BIN_ARRAY_PAIR_OFFSET]
          : [];
  const keys: string[] = [];
  for (const offset of filters) {
    const r = await rpc<Array<{ pubkey: string }>>('getProgramAccounts', [
      p.program,
      {
        encoding: 'base64',
        dataSlice: { offset: 0, length: 0 },
        filters: [{ memcmp: { offset, bytes: p.address } }],
      },
    ]);
    keys.push(...r.map((a) => a.pubkey));
  }
  return keys;
}

type Built = {
  sim: PoolSim;
  invariantRelErr: number | null;
  activeLiquidity: string | null;
  cl?: ClState;
  assetIs0?: boolean;
};
function decodeTicks(p: RegPool, head: Uint8Array, kids: Uint8Array[]): Array<[number, number]> {
  if (p.venue === 'raydium_clmm') {
    return kids
      .map(decodeClmmTickArray)
      .filter((a) => a !== null && a.pool === p.address)
      .flatMap((a) => (a?.ticks ?? []).map((t): [number, number] => [t.tick, t.liquidityNet]));
  }
  const ts = decodeWhirlpool(head).tickSpacing;
  return kids
    .map((k) => decodeWpTickArray(k, ts))
    .filter((a) => a !== null && a.pool === p.address)
    .flatMap((a) => (a?.ticks ?? []).map((t): [number, number] => [t.tick, t.liquidityNet]));
}

function build(
  p: RegPool,
  head: Uint8Array,
  kids: Uint8Array[],
  ticks: Array<[number, number]>,
  cfg: Uint8Array | undefined,
  vaults: [Uint8Array | undefined, Uint8Array | undefined],
): Built {
  const fees = {
    asset: {
      bps: p.assetIsToken0 ? p.transferFeeBps0 : p.transferFeeBps1,
      maximumFee: Number.MAX_SAFE_INTEGER,
    },
    quote: {
      bps: p.assetIsToken0 ? p.transferFeeBps1 : p.transferFeeBps0,
      maximumFee: Number.MAX_SAFE_INTEGER,
    },
  };
  const inv = (s: ClState) => {
    const rebuilt = s.ticks
      .filter((t) => t.tick <= s.tickCurrent)
      .reduce((a, t) => a + t.liquidityNet, 0);
    return s.liquidity > 0 ? Math.abs(rebuilt - s.liquidity) / s.liquidity : rebuilt === 0 ? 0 : 1;
  };
  if (p.venue === 'raydium_clmm') {
    const h = decodeClmmPool(head);
    const fee = cfg ? decodeClmmAmmConfig(cfg).tradeFeeRate : 0;
    const s = clmmState(h, fee, [
      {
        pool: p.address,
        startTickIndex: 0,
        ticks: ticks.map(([tick, liquidityNet]) => ({ tick, liquidityNet })),
      },
    ]);
    return {
      sim: clSim(s, h.mint0 === p.assetMint, fees),
      invariantRelErr: inv(s),
      activeLiquidity: h.liquidity.toString(),
    };
  }
  if (p.venue === 'orca_whirlpool') {
    const h = decodeWhirlpool(head);
    const s = whirlpoolState(h, [
      {
        pool: p.address,
        startTickIndex: 0,
        kind: 'fixed',
        ticks: ticks.map(([tick, liquidityNet]) => ({ tick, liquidityNet })),
      },
    ]);
    return {
      sim: clSim(s, h.mintA === p.assetMint, fees),
      invariantRelErr: inv(s),
      activeLiquidity: h.liquidity.toString(),
    };
  }
  if (p.venue === 'meteora_dlmm') {
    const h = decodeDlmmPair(head);
    const bins = kids
      .map(decodeDlmmBinArray)
      .filter((a) => a.pair === p.address)
      .flatMap((a) => a.bins);
    return {
      sim: dlmmSim(
        { activeId: h.activeId, feeRate: dlmmFeeRate(h), bins },
        h.mintX === p.assetMint,
        fees,
      ),
      invariantRelErr: null,
      activeLiquidity: null,
    };
  }
  const h = decodeCpmmPool(head);
  const c = cfg ? decodeCpmmAmmConfig(cfg) : { tradeFeeRate: 0, creatorFeeRate: 0 };
  const amt = (d?: Uint8Array) =>
    d && d.length >= 72 ? Number(new DataView(d.buffer, d.byteOffset).getBigUint64(64, true)) : 0;
  const r0 = amt(vaults[0]) - Number(h.owed0);
  const r1 = amt(vaults[1]) - Number(h.owed1);
  const assetIs0 = h.mint0 === p.assetMint;
  const feeRate = (c.tradeFeeRate + (h.enableCreatorFee ? c.creatorFeeRate : 0)) / 1e6;
  return {
    sim: cpSim(assetIs0 ? r0 : r1, assetIs0 ? r1 : r0, feeRate, fees),
    invariantRelErr: null,
    activeLiquidity: null,
  };
}

async function main() {
  if (!RPC_URL) throw new Error('SOLANA_RPC_URL not set (see ~/.colosseum/risk/env)');
  const started = Date.now();
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const reg = JSON.parse(readFileSync(join(HOME, 'registry.json'), 'utf8')) as { pools: RegPool[] };
  const cachePath = join(HOME, 'cache.json');
  const cache: Cache = existsSync(cachePath)
    ? (JSON.parse(readFileSync(cachePath, 'utf8')) as Cache)
    : { children: {}, childrenAt: {}, ticks: {}, configs: {} };
  cache.ticks ??= {};
  cache.lastDepth ??= {};
  const hourly = now.getUTCMinutes() < 5 || process.env.RISK_FORCE_ALL === '1';
  const due = reg.pools.filter((p) => p.tier === 'A' || hourly);
  const totalTvl = reg.pools.reduce((s, p) => s + (p.tvlUsd ?? 0), 0);
  let cum = 0;
  const rawSet = new Set<string>();
  for (const p of [...reg.pools].sort((a, b) => b.tvlUsd - a.tvlUsd)) {
    if (cum >= RAW_TOP_SHARE * totalTvl) break;
    cum += p.tvlUsd;
    rawSet.add(p.address);
  }

  // children: re-discover account lists hourly or when missing; CL tick maps are re-read on the same cadence
  const refreshCl = new Set<string>();
  for (const p of due) {
    const at = cache.childrenAt[p.address];
    const stale = !at || now.getTime() - Date.parse(at) > CHILD_REFRESH_MIN * 60_000;
    if (p.venue !== 'raydium_cpmm' && stale) {
      cache.children[p.address] = await discoverChildren(p);
      cache.childrenAt[p.address] = now.toISOString();
      if (isCl(p)) refreshCl.add(p.address);
      await sleep(150);
    }
    if (isCl(p) && !cache.ticks[p.address]) refreshCl.add(p.address);
  }
  // headers, configs, children, vaults in batched reads
  const heads = await getMultiple(due.map((p) => p.address));
  const cfgKeys = new Set<string>();
  for (const p of due) {
    const h = heads.get(p.address);
    if (!h) continue;
    if (p.venue === 'raydium_clmm') cfgKeys.add(decodeClmmPool(h).ammConfig);
    if (p.venue === 'raydium_cpmm') cfgKeys.add(decodeCpmmPool(h).ammConfig);
  }
  const missingCfg = [...cfgKeys].filter((k) => !cache.configs[k]);
  const cfgs = await getMultiple(missingCfg);
  for (const [k, v] of cfgs) cache.configs[k] = Buffer.from(v).toString('base64');
  const childKeys = due
    .filter((p) => p.venue === 'meteora_dlmm' || refreshCl.has(p.address))
    .flatMap((p) => cache.children[p.address] ?? []);
  const vaultKeys = due
    .filter((p) => p.venue === 'raydium_cpmm')
    .flatMap((p) => [p.vault0, p.vault1]);
  const kids = await getMultiple([...childKeys, ...vaultKeys]);
  const slot = lastSlot;

  // USD value of SOL for SOL-quoted pools: Jupiter Price API v3, recorded on every row as quoteUsdSource.
  let solUsd = 0;
  let solSource = '';
  try {
    const r = (await (await fetch(`https://lite-api.jup.ag/price/v3?ids=${SOL}`)).json()) as Record<
      string,
      { usdPrice?: number }
    >;
    solUsd = r[SOL]?.usdPrice ?? 0;
    solSource = 'lite-api.jup.ag/price/v3';
  } catch {
    solSource = 'unavailable';
  }

  const outDir = join(HOME, 'pools');
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${day}.jsonl`);
  const events = join(HOME, 'events.jsonl');
  let rows = 0;
  let refetched = 0;
  const failures: string[] = [];
  for (const p of due) {
    const head = heads.get(p.address);
    if (!head) {
      failures.push(`${p.address}: header missing`);
      continue;
    }
    try {
      const cfgKey =
        p.venue === 'raydium_clmm'
          ? decodeClmmPool(head).ammConfig
          : p.venue === 'raydium_cpmm'
            ? decodeCpmmPool(head).ammConfig
            : '';
      const cfg =
        cfgKey && cache.configs[cfgKey] ? b64(cache.configs[cfgKey] as string) : undefined;
      const childData = (cache.children[p.address] ?? [])
        .map((k) => kids.get(k))
        .filter((d): d is Uint8Array => !!d);
      if (isCl(p) && refreshCl.has(p.address))
        cache.ticks[p.address] = decodeTicks(p, head, childData);
      let built = build(p, head, childData, cache.ticks[p.address] ?? [], cfg, [
        kids.get(p.vault0),
        kids.get(p.vault1),
      ]);
      let staleThisRun = false;
      if (built.invariantRelErr !== null && built.invariantRelErr > 1e-9) {
        staleThisRun = true;
        // cached tick map is stale: an LP changed liquidity in range. Re-discover and rebuild.
        const before = built.invariantRelErr;
        cache.children[p.address] = await discoverChildren(p);
        cache.childrenAt[p.address] = now.toISOString();
        const fresh = await getMultiple(cache.children[p.address] as string[]);
        cache.ticks[p.address] = decodeTicks(p, head, [...fresh.values()]);
        built = build(p, head, [...fresh.values()], cache.ticks[p.address] ?? [], cfg, [
          undefined,
          undefined,
        ]);
        refetched++;
        appendFileSync(
          events,
          `${JSON.stringify({ kind: 'tick_map_stale', pool: p.address, asset: p.assetSymbol, invariantBefore: before, invariantAfter: built.invariantRelErr, fetchedAt: now.toISOString(), slot })}\n`,
        );
      }
      const quoteUsd =
        p.quoteMint === USDC || p.quoteMint === USDT ? 1 : p.quoteMint === SOL ? solUsd : 0;
      const decAsset = p.assetIsToken0 ? p.decimals0 : p.decimals1;
      const decQuote = p.assetIsToken0 ? p.decimals1 : p.decimals0;
      const curves =
        quoteUsd > 0 ? usdCurves(built.sim, decAsset, decQuote, quoteUsd, NOTIONALS) : null;
      const depth = built.sim.depthWithin(BAND_PCT);
      appendFileSync(
        file,
        `${JSON.stringify({
          pool: p.address,
          venue: p.venue,
          asset: p.assetSymbol,
          assetMint: p.assetMint,
          quote: p.quoteSymbol,
          exitPath: p.exitPath,
          tier: p.tier,
          fetchedAt: now.toISOString(),
          slot,
          midQuotePerAsset: built.sim.midRaw * 10 ** (decAsset - decQuote),
          quoteUsd,
          quoteUsdSource: p.quoteMint === SOL ? solSource : quoteUsd === 1 ? 'stable_par' : 'none',
          midUsd: curves?.midUsd ?? null,
          depth2pct: {
            sellQuoteOut: depth.sellQuoteOut / 10 ** decQuote,
            buyAssetOut: depth.buyAssetOut / 10 ** decAsset,
          },
          activeLiquidity: built.activeLiquidity,
          invariantRelErr: built.invariantRelErr,
          sell: curves?.sell ?? null,
          buy: curves?.buy ?? null,
          source:
            'Solana RPC getMultipleAccounts (pool, tick/bin arrays, vaults); decoded by @colosseum/risk',
          method: `simulate_${p.venue}`,
          methodVersion: COLLECTOR_METHOD_VERSION,
          provenance: 'live',
        })}\n`,
      );
      rows++;
      const depthNow = depth.sellQuoteOut / 10 ** decQuote;
      const depthPrev = cache.lastDepth?.[p.address];
      if (staleThisRun && depthPrev && depthNow < (1 - WITHDRAWAL_ALARM) * depthPrev) {
        appendFileSync(
          events,
          `${JSON.stringify({ kind: 'lp_withdrawal', pool: p.address, asset: p.assetSymbol, quote: p.quoteSymbol, depth2pctBefore: depthPrev, depth2pctAfter: depthNow, dropShare: 1 - depthNow / depthPrev, alarm: WITHDRAWAL_ALARM, fetchedAt: now.toISOString(), slot })}\n`,
        );
      }
      (cache.lastDepth as Record<string, number>)[p.address] = depthNow;
      if (hourly && rawSet.has(p.address) && built.cl && quoteUsd > 0) {
        try {
          const [size, offset] =
            p.venue === 'raydium_clmm'
              ? [CLMM_POSITION_SIZE, CLMM_POSITION_POOL_OFFSET]
              : [WP_POSITION_SIZE, WP_POSITION_POOL_OFFSET];
          const raw = await rpc<Array<{ pubkey: string; account: { data: [string, string] } }>>(
            'getProgramAccounts',
            [
              p.program,
              {
                encoding: 'base64',
                filters: [{ dataSize: size }, { memcmp: { offset, bytes: p.address } }],
              },
            ],
          );
          const decode = p.venue === 'raydium_clmm' ? decodeClmmPosition : decodeWpPosition;
          const ps = raw
            .map((a) => decode(a.pubkey, b64(a.account.data[0])))
            .filter((x) => x.pool === p.address && x.liquidity > 0);
          const tickNow = built.cl.tickCurrent;
          const c = concentration(ps, tickNow, BAND_PCT);
          const w = bandTicksFor(BAND_PCT);
          const top = [...ps]
            .sort((x, y) => inBandWeight(y, tickNow, w) - inBandWeight(x, tickNow, w))
            .slice(0, LP_EXIT_N);
          const stressed = usdCurves(
            clSim(withoutPositions(built.cl, top), built.assetIs0 ?? true, {}),
            decAsset,
            decQuote,
            quoteUsd,
            NOTIONALS,
          );
          mkdirSync(join(HOME, 'lp'), { recursive: true });
          appendFileSync(
            join(HOME, 'lp', `${day}.jsonl`),
            `${JSON.stringify({ pool: p.address, venue: p.venue, asset: p.assetSymbol, quote: p.quoteSymbol, fetchedAt: now.toISOString(), slot, bandPct: BAND_PCT, ...c, lpExitN: LP_EXIT_N, topPositions: top.map((x) => ({ address: x.address, nftMint: x.nftMint, tickLower: x.tickLower, tickUpper: x.tickUpper, liquidity: x.liquidity })), sellBase: curves?.sell ?? null, sellWithoutTopN: stressed.sell, source: 'Solana RPC getProgramAccounts (positions)', method: 'lp_concentration_positions', methodVersion: COLLECTOR_METHOD_VERSION, provenance: 'live' })}\n`,
          );
        } catch (e) {
          failures.push(`${p.address} lp: ${String(e).slice(0, 100)}`);
        }
      }
      if (refreshCl.has(p.address) && rawSet.has(p.address)) {
        const rawDir = join(HOME, 'raw', day, String(now.getUTCHours()).padStart(2, '0'));
        mkdirSync(rawDir, { recursive: true });
        const childRaw = Object.fromEntries(
          (cache.children[p.address] ?? []).map((k) => [
            k,
            Buffer.from(kids.get(k) ?? []).toString('base64'),
          ]),
        );
        writeFileSync(
          join(rawDir, `${p.address}.json.gz`),
          gzipSync(
            JSON.stringify({
              pool: p.address,
              venue: p.venue,
              slot,
              fetchedAt: now.toISOString(),
              head: Buffer.from(head).toString('base64'),
              children: childRaw,
              config: cfgKey ? cache.configs[cfgKey] : null,
            }),
          ),
        );
      }
    } catch (e) {
      failures.push(`${p.address}: ${String(e).slice(0, 120)}`);
    }
  }
  writeFileSync(cachePath, JSON.stringify(cache));
  const summary = {
    kind: 'run',
    fetchedAt: now.toISOString(),
    slot,
    due: due.length,
    hourly,
    rows,
    refetched,
    failures: failures.length,
    failureSample: failures.slice(0, 3),
    rpc: stats,
    seconds: Math.round((Date.now() - started) / 1000),
    methodVersion: COLLECTOR_METHOD_VERSION,
  };
  appendFileSync(join(HOME, 'runs.jsonl'), `${JSON.stringify(summary)}\n`);
  console.log(JSON.stringify(summary));
}

await main();
