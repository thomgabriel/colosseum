import type { Asset, YieldObservation } from '@colosseum/schemas';
import { applyHaircut } from '../assets/haircuts';

const KAMINO_API = 'https://api.kamino.finance';
const KAMINO_MAIN = '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF';
const KAMINO_USDC_RESERVE = 'D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59';

export type YieldFetchResult = { observation?: YieldObservation; error?: string };

/** Kamino main-market USDC supply APY from the protocol API (on-chain derived). */
export async function fetchKaminoUsdc(asset: Asset): Promise<YieldFetchResult> {
  const url = `${KAMINO_API}/kamino-market/${KAMINO_MAIN}/reserves/metrics`;
  const rows = (await (await fetch(url)).json()) as Array<{ reserve: string; supplyApy: string }>;
  const r = rows.find((x) => x.reserve === KAMINO_USDC_RESERVE);
  if (!r) return { error: 'USDC reserve not in metrics' };
  const quoted = Number(r.supplyApy);
  const { haircutYield, rule } = applyHaircut(asset, 'protocol_api', quoted);
  return {
    observation: {
      assetId: asset.id,
      quotedYield: quoted,
      haircutYield,
      haircutRule: rule.id,
      source: url,
      method: 'protocol_api',
      fetchedAt: new Date().toISOString(),
      provenance: 'live',
    },
  };
}

/**
 * Realised 30-day yield from the token's USD price path (USDY and syrupUSDC accrue by price, not rebasing).
 * Source: DefiLlama coins price history for the Solana mint (aggregated DEX/oracle prices). Annualised.
 */
export async function fetchRealised30d(asset: Asset): Promise<YieldFetchResult> {
  if (!asset.mint) return { error: 'no mint' };
  const url = `https://coins.llama.fi/chart/solana:${asset.mint}?span=31&period=1d`;
  const d = (await (await fetch(url)).json()) as {
    coins: Record<string, { prices: Array<{ timestamp: number; price: number }> }>;
  };
  const coin = Object.values(d.coins ?? {})[0];
  const prices = coin?.prices ?? [];
  if (prices.length < 20) return { error: `insufficient price history (${prices.length} points)` };
  const first = prices[0];
  const last = prices[prices.length - 1];
  if (!first || !last || first.price <= 0) return { error: 'bad price points' };
  const days = (last.timestamp - first.timestamp) / 86400;
  if (days < 20) return { error: `window too short (${days.toFixed(1)} days)` };
  const quoted = (last.price / first.price) ** (365 / days) - 1;
  const { haircutYield, rule } = applyHaircut(asset, 'realised_30d', quoted);
  return {
    observation: {
      assetId: asset.id,
      quotedYield: quoted,
      haircutYield,
      haircutRule: rule.id,
      source: url,
      method: 'realised_30d',
      fetchedAt: new Date().toISOString(),
      provenance: 'live',
    },
  };
}

/** Aggregator stand-in (DefiLlama yields) for issuer-reported rates; labelled and haircut harder. */
export async function fetchAggregator(
  asset: Asset,
  pick: (p: Record<string, unknown>) => boolean,
): Promise<YieldFetchResult> {
  const url = 'https://yields.llama.fi/pools';
  const d = (await (await fetch(url)).json()) as { data: Array<Record<string, unknown>> };
  const pool = d.data.find(pick);
  if (!pool) return { error: 'pool not found in aggregator' };
  const quoted = Number(pool.apy) / 100;
  const { haircutYield, rule } = applyHaircut(asset, 'aggregator_defillama', quoted);
  return {
    observation: {
      assetId: asset.id,
      quotedYield: quoted,
      haircutYield,
      haircutRule: rule.id,
      source: `${url}#${String(pool.pool)}`,
      method: 'aggregator_defillama',
      fetchedAt: new Date().toISOString(),
      provenance: 'live',
    },
  };
}

/** Zero-yield assets still get an observation so the UI can show source and timestamp for the zero. */
export function zeroYield(asset: Asset, why: string): YieldObservation {
  const { haircutYield, rule } = applyHaircut(asset, 'by_construction', 0);
  return {
    assetId: asset.id,
    quotedYield: 0,
    haircutYield,
    haircutRule: rule.id,
    source: why,
    method: 'by_construction',
    fetchedAt: new Date().toISOString(),
    provenance: 'live',
  };
}

/** All yield observations for the registry, primary method first with labelled fallbacks. Never throws for one asset. */
export async function fetchAllYields(assets: Asset[]): Promise<{
  observations: YieldObservation[];
  errors: Array<{ assetId: string; error: string }>;
}> {
  const observations: YieldObservation[] = [];
  const errors: Array<{ assetId: string; error: string }> = [];
  for (const a of assets) {
    try {
      if (a.kind === 'equity') observations.push(zeroYield(a, 'equity: no coupon (xStocks FAQ)'));
      else if (a.kind === 'brl_stable')
        observations.push(zeroYield(a, 'BRL stablecoin: 1:1, no yield'));
      else if (a.kind === 'cash') observations.push(zeroYield(a, 'cash buffer'));
      else if (a.mintPath === 'lending_deposit') {
        const r = await fetchKaminoUsdc(a);
        if (r.observation) observations.push(r.observation);
        else errors.push({ assetId: a.id, error: r.error ?? 'unknown' });
      } else {
        const realised = await fetchRealised30d(a);
        if (realised.observation) observations.push(realised.observation);
        else errors.push({ assetId: a.id, error: `realised_30d: ${realised.error}` });
        const agg = await fetchAggregator(
          a,
          a.id === 'usdy'
            ? (p) =>
                p.project === 'ondo-yield-assets' && p.chain === 'Solana' && p.symbol === 'USDY'
            : (p) => p.project === 'maple' && p.chain === 'Ethereum' && p.symbol === 'USDC',
        );
        if (agg.observation) observations.push(agg.observation);
        else errors.push({ assetId: a.id, error: `aggregator: ${agg.error}` });
      }
    } catch (e) {
      errors.push({ assetId: a.id, error: String(e).slice(0, 200) });
    }
  }
  return { observations, errors };
}
