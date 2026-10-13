// The cost cap of a metered endpoint (scripts/risk/assets/backfill-cost.ts): every request priced by its compute
// units before it is sent, the spend kept on disk across runs, and a clean, resumable stop at the cap.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CU_UNKNOWN,
  cuOf,
  meteredBatch,
  USD_PER_MILLION_CU,
} from '../../scripts/risk/assets/backfill-cost';
import { BudgetStop } from '../../scripts/risk/assets/backfill-gate';

const fake = async (rs: Array<{ method: string }>) => rs.map(() => ({ result: '0x1' }));

describe('the cost of a metered endpoint', () => {
  it('prices each request by its method, an unknown one as the dearest, and records it', async () => {
    const ledgerFile = join(mkdtempSync(join(tmpdir(), 'cost-')), 'ledger.json');
    const b = meteredBatch(fake, { ledgerFile, capUsd: 5, endpoint: 'TEST_RPC' });
    await b([
      { method: 'eth_getLogs', params: [] },
      { method: 'eth_blockNumber', params: [] },
      { method: 'eth_somethingNew', params: [] },
    ]);
    const l = JSON.parse(readFileSync(ledgerFile, 'utf8'));
    expect(l.cu).toBe(75 + 10 + CU_UNKNOWN);
    expect(l.usd).toBeCloseTo(((75 + 10 + CU_UNKNOWN) / 1e6) * USD_PER_MILLION_CU, 12);
    expect(l.byMethod.eth_getLogs).toEqual({ requests: 1, cu: 75 });
    expect(cuOf('eth_call')).toBe(26);
  });

  it('stops before the batch that would cross the cap, and the next run reads what was spent', async () => {
    const ledgerFile = join(mkdtempSync(join(tmpdir(), 'cost-')), 'ledger.json');
    // a cap of exactly two eth_getLogs
    const cap = ((2 * 75) / 1e6) * USD_PER_MILLION_CU;
    const run1 = meteredBatch(fake, { ledgerFile, capUsd: cap, endpoint: 'TEST_RPC' });
    await run1([{ method: 'eth_getLogs', params: [] }]);
    const run2 = meteredBatch(fake, { ledgerFile, capUsd: cap, endpoint: 'TEST_RPC' });
    await run2([{ method: 'eth_getLogs', params: [] }]);
    await expect(run2([{ method: 'eth_getLogs', params: [] }])).rejects.toBeInstanceOf(BudgetStop);
    expect(JSON.parse(readFileSync(ledgerFile, 'utf8')).requests).toBe(2);
  });
});
