// `tsx scripts/risk/assets/freeze-bars-fixture.ts` (PLAN-ASSETS AS.7): freezes a few real hours of the held
// swap history for tests/risk-layer/assets-bars.test.ts, under fixtures/risk/assets/bars/. No RPC, no write
// outside the fixture folder.
//   solana.json     NVDAx, 2026-09-05 06:00Z: its USDC pool on Raydium CLMM (the stock is token 0) and its
//                   SOL pool (the stock is token 1), every transaction row of the hour with the pool's swap
//                   events, and each pool's hourly row (history-replay-0.1) for that hour
//   robinhood.json  three hours of four pools: a v4 USDG pool with a swap that logged no side (2026-09-22
//                   22:00Z), a v4 pool whose quote's decimals the registry does not give (2026-09-19 01:00Z),
//                   and SPY's USDG pool and its NVDA-quoted pool (2026-09-06 02:00Z); every Swap of those
//                   hours and the hour's row the flow import wrote (hourly/<pool>.jsonl)
// RISK_DATA_DIR and RISK_EVM_DIR as for pnpm risk:assets-bars.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PoolEvent } from '@colosseum/risk';
import type { AssetList } from '@colosseum/schemas';
import { CHAINS, type ChainConfig } from '../../risk-evm/config';
import type { CutRow } from '../../risk-evm/cut';
import { historyPools, poolDecimals, type SwapRow } from '../../risk-evm/history';
import { lines, solanaMeta } from './bars-read';

const OUT = 'fixtures/risk/assets/bars';
mkdirSync(OUT, { recursive: true });
const inHour = (t: number, hour: string) => Math.floor(t / 3600) * 3600 * 1000 === Date.parse(hour);

// Solana
const solDir = join(process.env.RISK_DATA_DIR ?? 'data/risk', 'history-full');
const SOL_HOUR = '2026-09-05T06:00:00.000Z';
const SOL_POOLS = [
  '49iMatQtoyabsYAQc8GafVq6aeBFVDxSRH44oiatyyw6',
  '38rXq2BuwdNcfnwydw6S2srpNK9N4gVzf39f69suPMsF',
];
const meta = (await solanaMeta(solDir)).filter((m) => SOL_POOLS.includes(m.address));
type SolRow = { s: string; q: number; sl: number; t: number; ev: PoolEvent[] | null };
const solana = {
  about:
    "Real rows of Step 5b's history (data/risk/history-full, history-full-0.1) for one hour of two NVDAx pools, each row cut to the pool's own swap events, and each pool's hourly row (history-replay-0.1) for that hour. Frozen for tests/risk-layer/assets-bars.test.ts.",
  hour: SOL_HOUR,
  pools: meta.map((m) => {
    const rows: SolRow[] = [];
    for (const l of lines(join(solDir, 'events', m.address, `${SOL_HOUR.slice(0, 10)}.jsonl`))) {
      const r = JSON.parse(l) as SolRow;
      if (!inHour(r.t, SOL_HOUR)) continue;
      const ev = (r.ev ?? []).filter((e) => e.kind === 'swap' && e.pool === m.address);
      if (ev.length) rows.push({ s: r.s, q: r.q, sl: r.sl, t: r.t, ev });
    }
    const hourly = [...lines(join(solDir, 'hourly', `${m.address}.jsonl`))]
      .map(
        (l) =>
          JSON.parse(l) as {
            hour: string;
            regime: string;
            quoteUsd: number | null;
            quoteUsdMethod: string | null;
            provenance: string;
          },
      )
      .find((h) => h.hour === SOL_HOUR);
    return {
      meta: m,
      hourly: hourly
        ? {
            hour: hourly.hour,
            regime: hourly.regime,
            quoteUsd: hourly.quoteUsd,
            quoteUsdMethod: hourly.quoteUsdMethod,
            provenance: hourly.provenance,
          }
        : null,
      rows,
    };
  }),
};
writeFileSync(join(OUT, 'solana.json'), `${JSON.stringify(solana, null, 1)}\n`);

// Robinhood Chain
const evmDir = process.env.RISK_EVM_DIR ?? 'data/risk-evm';
const chain = CHAINS.find((c) => c.id === 'robinhood') as ChainConfig;
const list = JSON.parse(readFileSync('scripts/risk/universe/robinhood.json', 'utf8')) as AssetList;
const cut = JSON.parse(readFileSync(join(evmDir, list.inputs.cut ?? ''), 'utf8')) as {
  chain: string;
  pools: CutRow[];
};
const universeFile = readdirSync(evmDir)
  .filter((f) => f.startsWith('universe-robinhood-') && f.endsWith('.json'))
  .sort()
  .at(-1) as string;
const universe = JSON.parse(readFileSync(join(evmDir, universeFile), 'utf8')) as {
  tokens: Array<{ address: string; decimals: number }>;
};
const dec = new Map(universe.tokens.map((t) => [t.address.toLowerCase(), t.decimals]));
const all = historyPools(cut, chain);
const PICK: Array<{ pool: string; hour: string; why: string }> = [
  {
    pool: '0x98dbe86895a576f964c039c9e35c50a24f02de508e308207ec38efbe8b63f35e',
    hour: '2026-09-22T22:00:00.000Z',
    why: 'v4 pool against USDG with a swap that logged nothing going in',
  },
  {
    pool: '0x70acec10bf24e34d490f4562e642bf1dd389378344e98b1f49a2d4f171490c23',
    hour: '2026-09-19T01:00:00.000Z',
    why: "v4 pool whose quote's decimals the issuer registry does not give",
  },
  {
    pool: '0xcb410a0728986ba05737420556d5fe128ffd6739823cc92fc745d37bad4b313f',
    hour: '2026-09-06T02:00:00.000Z',
    why: "SPY against USDG, the same hour as SPY's NVDA-quoted pool",
  },
  {
    pool: '0xbc732a1a0baabce2574ec2bca24fccad8e2c38a061a37cefc17a2fd12809394f',
    hour: '2026-09-06T02:00:00.000Z',
    why: 'SPY against NVDA: the quote priced from NVDA’s own dollar pool that hour',
  },
];
const root = join(evmDir, 'history', 'robinhood');
const robinhood = {
  about:
    "Real Swap events of RU.14's walk (history-evm-0.1) for one hour of each of four pools, with the hour's row the flow import wrote (hourly/<pool>.jsonl: quoteUsd and its method), the pool as the cut gives it and its decimals as the issuer registry gives them. Frozen for tests/risk-layer/assets-bars.test.ts.",
  universe: universeFile,
  cut: list.inputs.cut,
  pools: PICK.map(({ pool, hour, why }) => {
    const p = all.find((x) => x.address === pool);
    if (!p) throw new Error(`${pool} is not in the cut`);
    const swaps: SwapRow[] = [];
    for (const l of lines(join(root, 'swaps', pool, `${hour.slice(0, 10)}.jsonl`))) {
      const s = JSON.parse(l) as SwapRow;
      if (inHour(s.t, hour)) swaps.push(s);
    }
    const row = [...lines(join(root, 'hourly', `${pool}.jsonl`))]
      .map(
        (l) =>
          JSON.parse(l) as { hour: string; quoteUsd: number | null; quoteUsdMethod: string | null },
      )
      .find((h) => h.hour === hour);
    return {
      why,
      hour,
      pool: p,
      decimals: poolDecimals(p, chain, (a) => dec.get(a)),
      assetDecimals: dec.get(p.asset.toLowerCase()) ?? null,
      hourly: row ? { quoteUsd: row.quoteUsd, quoteUsdMethod: row.quoteUsdMethod } : null,
      swaps,
    };
  }),
};
writeFileSync(join(OUT, 'robinhood.json'), `${JSON.stringify(robinhood, null, 1)}\n`);
console.log(
  JSON.stringify({
    solana: solana.pools.map((p) => ({ pool: p.meta.address, rows: p.rows.length })),
    robinhood: robinhood.pools.map((p) => ({ pool: p.pool.address, swaps: p.swaps.length })),
  }),
);
