import type { Asset, LegOrder, UnsignedTx } from '@colosseum/schemas';
import { address, type KeyPairSigner } from '@solana/kit';
import type { SignedV0 } from './compose.js';
import { buildDelegatedSwapTx } from './delegate.js';
import { buildSwapTx, getQuote } from './jupiter.js';
import type { PriceObservation } from './prices.js';
import type { SolanaRpc } from './rpc.js';

export type OrderBuild =
  | {
      order: LegOrder;
      kind: 'delegated';
      signed: SignedV0;
      amountBase: bigint;
      quote: { outAmount: string; priceImpactPct: string };
    }
  | { order: LegOrder; kind: 'user_signed'; tx: UnsignedTx; amountBase: bigint }
  | { order: LegOrder; kind: 'unsupported'; reason: string };

/**
 * Maps a rebalance order to a transaction. DEX→DEX orders: delegated (agent signs, output to the owner) or
 * user-signed (unsigned Jupiter swap for the owner). Orders touching a lending deposit need withdraw/deposit
 * instructions (D7-AM) and are reported as unsupported for now, never silently dropped.
 */
export async function buildOrderTx(
  rpc: SolanaRpc,
  order: LegOrder,
  assets: Map<string, Asset>,
  prices: Map<string, PriceObservation>,
  agent?: KeyPairSigner,
): Promise<OrderBuild> {
  const from = assets.get(order.fromAssetId);
  const to = assets.get(order.toAssetId);
  if (!from?.mint || !to?.mint || from.mintPath !== 'dex_swap' || to.mintPath !== 'dex_swap') {
    return {
      order,
      kind: 'unsupported',
      reason:
        'only DEX→DEX orders are executable in this slot; lending withdraw/deposit lands in D7-AM',
    };
  }
  const px = prices.get(from.id)?.usdcPerUnit;
  if (!px) return { order, kind: 'unsupported', reason: `no price for ${from.id}` };
  const decimals = from.decimals ?? 6;
  const amountBase = BigInt(Math.floor((order.amountUsd / px) * 10 ** decimals));
  if (order.mechanism === 'delegated') {
    if (!agent)
      return { order, kind: 'unsupported', reason: 'delegated order but no agent key loaded' };
    const built = await buildDelegatedSwapTx(
      rpc,
      agent,
      address(order.destination),
      address(from.mint),
      address(to.mint),
      amountBase,
      decimals,
    );
    return { order, kind: 'delegated', signed: built, amountBase, quote: built.quote };
  }
  const quote = await getQuote({ inputMint: from.mint, outputMint: to.mint, amountBase });
  const swap = await buildSwapTx({ quote, userPublicKey: order.destination });
  return {
    order,
    kind: 'user_signed',
    amountBase,
    tx: {
      legAssetId: to.id,
      kind: 'rebalance',
      chain: 'solana',
      payload: swap.swapTransaction,
      description: `Rebalance: sell ${from.symbol} for ${to.symbol} (${order.amountUsd.toFixed(2)} USD): ${order.reason}`,
      provenance: 'live',
      lastValidBlockHeight: swap.lastValidBlockHeight,
    },
  };
}
