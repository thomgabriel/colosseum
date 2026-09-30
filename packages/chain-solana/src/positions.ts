import type { Asset } from '@colosseum/schemas';
import { type Address, address } from '@solana/kit';
import { tokenAccountState } from './delegate';
import { KAMINO_MAIN_MARKET } from './kamino';
import { getUsdcPrice, type PriceObservation } from './prices';
import type { SolanaRpc } from './rpc';

export type ChainPosition = {
  assetId: string;
  amount: number;
  valueUsd: number;
  price: PriceObservation;
  source: string;
  observedAt: string;
};

/** Live positions of `wallet` across the registry: token balances plus Kamino main-market deposits, valued in USDC. */
export type PositionsRead = {
  positions: ChainPosition[];
  errors: Array<{ assetId: string; error: string }>;
};

export async function readPositions(
  rpc: SolanaRpc,
  wallet: Address,
  assets: Map<string, Asset>,
): Promise<PositionsRead> {
  const errors: Array<{ assetId: string; error: string }> = [];
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
    let lastErr = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const sdk = await import('@kamino-finance/klend-sdk');
        const market = await sdk.KaminoMarket.load(
          rpc,
          KAMINO_MAIN_MARKET,
          sdk.DEFAULT_RECENT_SLOT_DURATION_MS,
        );
        if (!market) throw new Error('market load returned null');
        let deposits: Array<{ mintAddress: Address; amount: { toString(): string } }> = [];
        try {
          const ob = await market.getUserVanillaObligation(wallet);
          deposits = [...ob.deposits.values()];
        } catch (e) {
          // No obligation yet is a legitimate zero; any other failure is retried and then reported.
          if (!/not found|does not exist|null/i.test(String(e))) throw e;
        }
        const usdcDeposit = deposits.find((d) => d.mintAddress === address(usdcMint));
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
        lastErr = '';
        break;
      } catch (e) {
        lastErr = String(e).slice(0, 200);
        await new Promise((r) => setTimeout(r, 700));
      }
    }
    if (lastErr) errors.push({ assetId: kamino.id, error: lastErr });
  }
  return { positions: out, errors };
}
