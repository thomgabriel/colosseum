import type { Asset, PlanLeg, UnsignedTx } from '@colosseum/schemas';

/** Plan-to-calldata stub. Built for one partner chain only if decision EVM-S1 is approved (docs/GATES.md). */
export async function buildCalldata(_leg: PlanLeg, _asset: Asset): Promise<UnsignedTx[]> {
  throw new Error('EVM adapter not built: decision EVM-S1 is OPEN (docs/GATES.md)');
}
