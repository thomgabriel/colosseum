import type { Asset, UnsignedTx } from '@colosseum/schemas';
import { type Address, address } from '@solana/kit';
import { buildSwapTx, getQuote } from './jupiter.js';
import { buildKaminoDepositUnsigned } from './kamino.js';
import type { SolanaRpc } from './rpc.js';

export type PlanLegInput = { assetId: string; amountUsd: number; executionId?: string };
export type ExecutionPlan = {
  wallet: string;
  fundingAssetId: 'usdc' | 'usdt';
  legs: PlanLegInput[];
};
export type LegBuildResult = {
  leg: PlanLegInput;
  tx?: UnsignedTx;
  skipped?: string;
  error?: string;
};

/**
 * Plan → ordered unsigned transaction set for the user's wallet. One transaction per leg (a Kamino deposit cannot
 * share a transaction with a Jupiter swap). Legs are independent: a failure to build one is reported and the rest
 * still build. Order: USDT→USDC conversion first (when funding is USDT), then DEX swaps, then lending deposits.
 * Legs whose asset is `unavailable` (the pre-gate BRL leg) are skipped with a label, never executed.
 */
export async function buildPlanTransactions(
  rpc: SolanaRpc,
  plan: ExecutionPlan,
  assets: Map<string, Asset>,
): Promise<LegBuildResult[]> {
  const usdc = assets.get('usdc');
  if (!usdc?.mint) throw new Error('registry: usdc missing');
  const wallet = address(plan.wallet);
  const results: LegBuildResult[] = [];

  if (plan.fundingAssetId === 'usdt') {
    const usdt = assets.get('usdt');
    if (!usdt?.mint) throw new Error('registry: usdt missing');
    const total = plan.legs.reduce((s, l) => s + l.amountUsd, 0);
    results.push(
      await buildSwapLeg(
        rpc,
        wallet,
        { assetId: 'usdt->usdc', amountUsd: total },
        usdt.mint,
        usdc.mint,
        'swap',
        `Convert ${total.toFixed(2)} USDT to USDC for funding`,
      ),
    );
  }

  const order = (a: Asset) =>
    a.mintPath === 'dex_swap' ? 0 : a.mintPath === 'lending_deposit' ? 1 : 2;
  const legs = [...plan.legs].sort(
    (x, y) =>
      order(assets.get(x.assetId) ?? ({ mintPath: 'unavailable' } as Asset)) -
      order(assets.get(y.assetId) ?? ({ mintPath: 'unavailable' } as Asset)),
  );

  for (const leg of legs) {
    const asset = assets.get(leg.assetId);
    if (!asset) {
      results.push({ leg, error: `unknown asset ${leg.assetId}` });
      continue;
    }
    if (asset.mintPath === 'unavailable') {
      results.push({ leg, skipped: asset.metadata.label ?? 'not executable' });
      continue;
    }
    if (asset.id === 'usdc') {
      results.push({ leg, skipped: 'cash buffer stays as USDC' });
      continue;
    }
    try {
      if (asset.mintPath === 'dex_swap' && asset.mint) {
        results.push(
          await buildSwapLeg(
            rpc,
            wallet,
            leg,
            usdc.mint,
            asset.mint,
            'swap',
            `Buy ${asset.symbol} with ${leg.amountUsd.toFixed(2)} USDC via Jupiter`,
          ),
        );
      } else if (asset.mintPath === 'lending_deposit') {
        const built = await buildKaminoDepositUnsigned(rpc, wallet, toBase(leg.amountUsd));
        results.push({
          leg,
          tx: {
            legAssetId: asset.id,
            kind: 'deposit',
            chain: 'solana',
            payload: built.wire,
            description: `Deposit ${leg.amountUsd.toFixed(2)} USDC into Kamino Lend (main market)`,
            provenance: 'live',
            executionId: leg.executionId,
            lastValidBlockHeight: built.lastValidBlockHeight,
          },
        });
      } else {
        results.push({ leg, error: `no executor for mint path ${asset.mintPath}` });
      }
    } catch (e) {
      results.push({ leg, error: String(e).slice(0, 500) });
    }
  }
  return results;
}

const toBase = (usd: number) => BigInt(Math.round(usd * 1_000_000));

async function buildSwapLeg(
  rpc: SolanaRpc,
  wallet: Address,
  leg: PlanLegInput,
  inputMint: string,
  outputMint: string,
  kind: 'swap',
  description: string,
): Promise<LegBuildResult> {
  const quote = await getQuote({ inputMint, outputMint, amountBase: toBase(leg.amountUsd) });
  const built = await buildSwapTx({ quote, userPublicKey: wallet });
  return {
    leg,
    tx: {
      legAssetId: leg.assetId,
      kind,
      chain: 'solana',
      payload: built.swapTransaction,
      description: `${description} (expected out ${quote.outAmount} base units, impact ${Number(quote.priceImpactPct).toFixed(4)}%)`,
      provenance: 'live',
      executionId: leg.executionId,
      lastValidBlockHeight: built.lastValidBlockHeight,
    },
  };
}
