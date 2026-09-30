import { KAMINO_API, KAMINO_MAIN_MARKET, MINTS, nowIso, print } from '../lib.js';

// V1: live yields with source + method. Kamino = protocol API (main market USDC reserve, on-chain derived).
// USDY / syrupUSDC = issuer figures are not machine-readable today; aggregator (DefiLlama) is the D1 stand-in,
// to be replaced by realised-30d from on-chain price in D4-PM. Values are observations, never plan facts.
const fetchedAt = nowIso();
const kaminoUrl = `${KAMINO_API}/kamino-market/${KAMINO_MAIN_MARKET}/reserves/metrics`;
const reserves = (await (await fetch(kaminoUrl)).json()) as Array<Record<string, unknown>>;
const usdc = reserves.find(
  (r) => r.liquidityTokenMint === MINTS.USDC && Number(r.totalSupplyUsd) > 1_000_000,
);
print({
  id: 'V1a',
  item: 'Kamino USDC supply APY (main market)',
  status: usdc ? 'pass' : 'fail',
  how: kaminoUrl,
  value: usdc
    ? {
        reserve: usdc.reserve,
        supplyApy: usdc.supplyApy,
        totalSupplyUsd: usdc.totalSupplyUsd,
        method: 'protocol_api',
      }
    : null,
  fetchedAt,
});

const llama = (await (await fetch('https://yields.llama.fi/pools')).json()) as {
  data: Array<Record<string, unknown>>;
};
const pick = (pred: (p: Record<string, unknown>) => boolean) => llama.data.find(pred);
const usdy = pick(
  (p) => p.project === 'ondo-yield-assets' && p.chain === 'Solana' && p.symbol === 'USDY',
);
// DefiLlama lists the Maple Syrup USDC pool as project=maple, symbol=USDC (Ethereum). Solana syrupUSDC is a bridged share of it.
const syrup = pick((p) => p.project === 'maple' && p.chain === 'Ethereum' && p.symbol === 'USDC');
print({
  id: 'V1b',
  item: 'USDY yield (aggregator stand-in)',
  status: usdy ? 'partial' : 'fail',
  how: 'https://yields.llama.fi/pools (project=ondo-yield-assets, chain=Solana)',
  value: usdy
    ? { apy: usdy.apy, tvlUsd: usdy.tvlUsd, pool: usdy.pool, method: 'aggregator_defillama' }
    : null,
  fetchedAt,
  note: 'issuer page shows inconsistent APY labels; replace with realised_30d from on-chain price in D4-PM',
});
print({
  id: 'V1c',
  item: 'syrupUSDC yield (aggregator stand-in)',
  status: syrup ? 'partial' : 'fail',
  how: 'https://yields.llama.fi/pools (project=maple, chain=Ethereum, symbol=USDC = Syrup USDC pool)',
  value: syrup
    ? {
        apy: syrup.apy,
        chain: syrup.chain,
        tvlUsd: syrup.tvlUsd,
        pool: syrup.pool,
        method: 'aggregator_defillama',
      }
    : null,
  fetchedAt,
  note: 'Maple app blocks non-browser fetch and api.maple.finance/v2/graphql has introspection disabled; replace with realised_30d from syrupUSDC/USDC exchange rate in D4-PM',
});
