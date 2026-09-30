import type { Asset, PlanLeg, UnsignedTx } from '@colosseum/schemas';

export interface ExecutionContext {
  wallet: string;
  rpcUrl: string;
}

/** One executor per asset kind / mint path. Returns unsigned transactions; never signs. */
export interface LegExecutor {
  readonly mintPath: Asset['mintPath'];
  buildTxs(leg: PlanLeg, asset: Asset, ctx: ExecutionContext): Promise<UnsignedTx[]>;
}

/**
 * Abstract mint path for the BRL leg. Pre-gate the only implementation is `unavailableBrlLeg`.
 * After G-Nora passes, a NoraMintAdapter implements this interface and nothing upstream changes.
 */
export interface MintAdapter {
  readonly kind: 'issuer_mint' | 'dex_swap' | 'unavailable';
  readonly label: string;
  buildMintTxs(amountUsd: number, ctx: ExecutionContext): Promise<UnsignedTx[]>;
}
