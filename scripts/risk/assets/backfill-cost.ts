import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Rpc } from '../../risk-evm/rpc';
import { BudgetStop } from './backfill-gate';

// What the backfill spends on a metered endpoint (Alchemy, for Robinhood Chain), and the cap it stops at
// (Rodrigo, 2026-10-13: five dollars to start, then the expected cost). Every request is priced before it is sent
// by Alchemy's compute units (CU) per method, at the dearest rate on record, and added to a ledger on disk that
// every run reads, so the cap holds across runs and a stopped run resumes where it stood. A request whose CU the
// table does not hold is priced as the dearest method. The figures are an estimate: the dashboard's bill rules.

/** Compute units per method (Alchemy's documented examples; unknown methods priced as eth_getLogs). */
export const CU_PER_METHOD: Record<string, number> = {
  eth_blockNumber: 10,
  eth_chainId: 0,
  eth_call: 26,
  eth_getBlockByNumber: 16,
  eth_getLogs: 75,
};
export const CU_UNKNOWN = 75;
/** Dollars a million CU: $0.45 published, $0.525 reported for 2026; the higher is used. */
export const USD_PER_MILLION_CU = 0.525;

export type CostLedger = {
  endpoint: string;
  usdPerMillionCu: number;
  cu: number;
  usd: number;
  requests: number;
  byMethod: Record<string, { requests: number; cu: number }>;
  updatedAt: string;
};

export const cuOf = (method: string) => CU_PER_METHOD[method] ?? CU_UNKNOWN;

/** A batch that prices its requests, refuses past the cap (BudgetStop, resumable), and records what it spent. */
export function meteredBatch(
  batch: Rpc['batch'],
  opts: { ledgerFile: string; capUsd: number; endpoint: string; now?: () => Date },
): Rpc['batch'] {
  const now = opts.now ?? (() => new Date());
  const read = (): CostLedger =>
    existsSync(opts.ledgerFile)
      ? (JSON.parse(readFileSync(opts.ledgerFile, 'utf8')) as CostLedger)
      : {
          endpoint: opts.endpoint,
          usdPerMillionCu: USD_PER_MILLION_CU,
          cu: 0,
          usd: 0,
          requests: 0,
          byMethod: {},
          updatedAt: now().toISOString(),
        };
  return async (requests) => {
    const ledger = read();
    const cu = requests.reduce((a, r) => a + cuOf(r.method), 0);
    const usd = (cu / 1e6) * USD_PER_MILLION_CU;
    if (ledger.usd + usd > opts.capUsd)
      throw new BudgetStop([
        `the cost cap of $${opts.capUsd} on ${opts.endpoint}: $${ledger.usd.toFixed(4)} spent, the next batch $${usd.toFixed(4)} (${opts.ledgerFile})`,
      ]);
    const replies = await batch(requests);
    for (const r of requests) {
      ledger.byMethod[r.method] ??= { requests: 0, cu: 0 };
      const m = ledger.byMethod[r.method] as { requests: number; cu: number };
      m.requests++;
      m.cu += cuOf(r.method);
    }
    ledger.cu += cu;
    ledger.usd = (ledger.cu / 1e6) * USD_PER_MILLION_CU;
    ledger.requests += requests.length;
    ledger.updatedAt = now().toISOString();
    mkdirSync(dirname(opts.ledgerFile), { recursive: true });
    writeFileSync(opts.ledgerFile, `${JSON.stringify(ledger, null, 1)}\n`);
    return replies;
  };
}
