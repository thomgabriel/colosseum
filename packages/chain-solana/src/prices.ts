import type { Asset } from '@colosseum/schemas';
import { getQuote } from './jupiter';

export type PriceObservation = {
  assetId: string;
  usdcPerUnit: number;
  source: string;
  method: string;
  fetchedAt: string;
  provenance: 'live';
};

/**
 * USDC price per unit from a Jupiter sell quote of one unit (DEX-realisable value, not an oracle mark).
 * USDC and Kamino USDC deposits are 1 by construction (the deposit is denominated in USDC).
 */
export async function getUsdcPrice(asset: Asset, usdcMint: string): Promise<PriceObservation> {
  const fetchedAt = new Date().toISOString();
  if (asset.id === 'usdc' || asset.mintPath === 'lending_deposit') {
    return {
      assetId: asset.id,
      usdcPerUnit: 1,
      source: 'unit',
      method: 'usdc_denominated',
      fetchedAt,
      provenance: 'live',
    };
  }
  if (!asset.mint || !asset.decimals) throw new Error(`asset ${asset.id} has no mint/decimals`);
  const one = 10n ** BigInt(asset.decimals);
  const q = await getQuote({
    inputMint: asset.mint,
    outputMint: usdcMint,
    amountBase: one,
    slippageBps: 50,
  });
  return {
    assetId: asset.id,
    usdcPerUnit: Number(q.outAmount) / 1e6,
    source: 'https://api.jup.ag/swap/v1/quote',
    method: 'jupiter_sell_quote_1_unit',
    fetchedAt,
    provenance: 'live',
  };
}
