import type { MintAdapter } from './types.js';

export const BRL_LEG_IN_PROGRESS_LABEL = 'BRS mint via Nora: integration in progress';

/** Pre-gate BRL leg: shown in plan, schedule and risk sheet; never executed. */
export const unavailableBrlLeg: MintAdapter = {
  kind: 'unavailable',
  label: BRL_LEG_IN_PROGRESS_LABEL,
  async buildMintTxs() {
    throw new Error(`BRL leg is not executable: ${BRL_LEG_IN_PROGRESS_LABEL}`);
  },
};
