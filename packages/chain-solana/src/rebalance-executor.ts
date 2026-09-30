import type { Asset, LegOrder, UnsignedTx } from '@colosseum/schemas';
import { address, type KeyPairSigner } from '@solana/kit';
import type { SignedV0 } from './compose';
import { buildDelegatedSwapTx } from './delegate';
import { buildSwapTx, getQuote } from './jupiter';
import { buildKaminoDepositUnsigned, buildKaminoWithdrawUnsigned } from './kamino';
import type { PriceObservation } from './prices';
import type { SolanaRpc } from './rpc';

export type OrderBuild =
  | {
      order: LegOrder;
      kind: 'delegated';
      signed: SignedV0;
      amountBase: bigint;
      quote: { outAmount: string; priceImpactPct: string };
    }
  | { order: LegOrder; kind: 'user_signed'; txs: UnsignedTx[]; amountBase: bigint }
  | { order: LegOrder; kind: 'unsupported'; reason: string };

const toBase = (usd: number, px: number, decimals: number) =>
  BigInt(Math.floor((usd / px) * 10 ** decimals));

/**
 * Maps a rebalance order to transactions.
 *  - DEX→DEX, delegated: one agent-signed atomic transaction (delegate transfer → swap → output to the owner).
 *  - DEX→DEX, user-signed: one unsigned Jupiter swap for the owner.
 *  - lending→DEX: unsigned Kamino withdrawal (USDC) then unsigned swap USDC→target. DEX→lending: swap to USDC then deposit.
 * Lending legs always need the owner's signature (docs/GATES.md POLICY).
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
  const usdc = assets.get('usdc');
  if (!from || !to || !usdc?.mint) return { order, kind: 'unsupported', reason: 'unknown asset' };
  const owner = address(order.destination);
  const usdcBase = BigInt(Math.floor(order.amountUsd * 1_000_000));
  const desc = (what: string) => `Rebalance (${order.mechanism}): ${what} — ${order.reason}`;
  const unsigned = (
    legAssetId: string,
    kind: UnsignedTx['kind'],
    payload: string,
    description: string,
    lastValidBlockHeight?: number,
  ): UnsignedTx => ({
    legAssetId,
    kind,
    chain: 'solana',
    payload,
    description,
    provenance: 'live',
    lastValidBlockHeight,
  });

  // lending → DEX
  if (from.mintPath === 'lending_deposit' && to.mintPath === 'dex_swap' && to.mint) {
    const w = await buildKaminoWithdrawUnsigned(rpc, owner, usdcBase);
    const q = await getQuote({ inputMint: usdc.mint, outputMint: to.mint, amountBase: usdcBase });
    const sw = await buildSwapTx({ quote: q, userPublicKey: owner });
    return {
      order,
      kind: 'user_signed',
      amountBase: usdcBase,
      txs: [
        unsigned(
          from.id,
          'withdraw',
          w.wire,
          desc(`withdraw ${order.amountUsd.toFixed(2)} USDC from ${from.symbol}`),
          w.lastValidBlockHeight,
        ),
        unsigned(
          to.id,
          'rebalance',
          sw.swapTransaction,
          desc(`buy ${to.symbol} with ${order.amountUsd.toFixed(2)} USDC`),
          sw.lastValidBlockHeight,
        ),
      ],
    };
  }
  // DEX → lending
  if (from.mintPath === 'dex_swap' && from.mint && to.mintPath === 'lending_deposit') {
    const px = prices.get(from.id)?.usdcPerUnit;
    if (!px) return { order, kind: 'unsupported', reason: `no price for ${from.id}` };
    const fromBase = toBase(order.amountUsd, px, from.decimals ?? 6);
    const q = await getQuote({ inputMint: from.mint, outputMint: usdc.mint, amountBase: fromBase });
    const sw = await buildSwapTx({ quote: q, userPublicKey: owner });
    const dep = await buildKaminoDepositUnsigned(rpc, owner, BigInt(q.outAmount));
    return {
      order,
      kind: 'user_signed',
      amountBase: fromBase,
      txs: [
        unsigned(
          from.id,
          'rebalance',
          sw.swapTransaction,
          desc(`sell ${from.symbol} for USDC`),
          sw.lastValidBlockHeight,
        ),
        unsigned(
          to.id,
          'deposit',
          dep.wire,
          desc(`deposit ${(Number(q.outAmount) / 1e6).toFixed(2)} USDC into ${to.symbol}`),
          dep.lastValidBlockHeight,
        ),
      ],
    };
  }
  // DEX → DEX
  if (from.mintPath === 'dex_swap' && to.mintPath === 'dex_swap' && from.mint && to.mint) {
    const px = prices.get(from.id)?.usdcPerUnit;
    if (!px) return { order, kind: 'unsupported', reason: `no price for ${from.id}` };
    const decimals = from.decimals ?? 6;
    const amountBase = toBase(order.amountUsd, px, decimals);
    if (order.mechanism === 'delegated') {
      if (!agent)
        return { order, kind: 'unsupported', reason: 'delegated order but no agent key loaded' };
      const built = await buildDelegatedSwapTx(
        rpc,
        agent,
        owner,
        address(from.mint),
        address(to.mint),
        amountBase,
        decimals,
      );
      return { order, kind: 'delegated', signed: built, amountBase, quote: built.quote };
    }
    const quote = await getQuote({ inputMint: from.mint, outputMint: to.mint, amountBase });
    const swap = await buildSwapTx({ quote, userPublicKey: owner });
    return {
      order,
      kind: 'user_signed',
      amountBase,
      txs: [
        unsigned(
          to.id,
          'rebalance',
          swap.swapTransaction,
          desc(`sell ${from.symbol} for ${to.symbol} (${order.amountUsd.toFixed(2)} USD)`),
          swap.lastValidBlockHeight,
        ),
      ],
    };
  }
  return { order, kind: 'unsupported', reason: `no path from ${from.mintPath} to ${to.mintPath}` };
}
