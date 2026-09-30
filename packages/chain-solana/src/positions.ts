import type { Asset } from '@colosseum/schemas';
import { type Address, address } from '@solana/kit';
import { tokenAccountState } from './delegate.js';
import { KAMINO_MAIN_MARKET } from './kamino.js';
import { getUsdcPrice, type PriceObservation } from './prices.js';
import type { SolanaRpc } from './rpc.js';

export type ChainPosition = {
  assetId: string;
  amount: number;
  valueUsd: number;
  price: PriceObservation;
  source: string;
  observedAt: string;
};

/** Live positions of `wallet` across the registry: token balances plus Kamino main-market deposits, valued in USDC. */
export async function readPositions(
  rpc: SolanaRpc,
  wallet: Address,
  assets: Map<string, Asset>,
): Promise<ChainPosition[]> {
  const usdc = assets.get('usdc');
  if (!usdc?.mint) throw new Error('registry: usdc');
  const usdcMint = usdc.mint;
  const out: ChainPosition[] = [];
  const observedAt = new Date().toISOString();
  for (const a of assets.values()) {
    if (!a.mint || a.mintPath === 'lending_deposit' || a.mintPath === 'unavailable') continue;
    const st = await tokenAccountState(rpc, wallet, address(a.mint), a.decimals ?? 6);
    if (!st || st.amount <= 0) continue;
    const price = await getUsdcPrice(a, usdcMint);
    out.push({
      assetId: a.id,
      amount: st.amount,
      valueUsd: st.amount * price.usdcPerUnit,
      price,
      source: 'getTokenAccountsByOwner',
      observedAt,
    });
  }
  const kamino = [...assets.values()].find((a) => a.mintPath === 'lending_deposit');
  if (kamino) {
    const sdk = await import('@kamino-finance/klend-sdk');
    const market = await sdk.KaminoMarket.load(
      rpc,
      KAMINO_MAIN_MARKET,
      sdk.DEFAULT_RECENT_SLOT_DURATION_MS,
    );
    if (market) {
      try {
        const ob = await market.getUserVanillaObligation(wallet);
        const usdcDeposit = [...ob.deposits.values()].find(
          (d) =>
            market.getReserveByAddress(d.reserveAddress)?.getLiquidityMint() === address(usdcMint),
        );
        if (usdcDeposit) {
          const amount = Number(usdcDeposit.amount.toString()) / 1e6;
          const price = await getUsdcPrice(kamino, usdcMint);
          out.push({
            assetId: kamino.id,
            amount,
            valueUsd: amount,
            price,
            source: 'klend-sdk getUserVanillaObligation',
            observedAt,
          });
        }
      } catch {
        // no obligation yet
      }
    }
  }
  return out;
}
