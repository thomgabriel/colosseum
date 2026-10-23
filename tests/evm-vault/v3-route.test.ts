import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  deploymentAssets,
  deploymentLimits,
  deploymentPools,
  EvmDeploymentRecord,
  isV3Pool,
  poolOf,
  swapCalldata,
} from '@colosseum/chain-evm/vault';
import type { ApprovedStep, EvmDeployment, Loaded } from '@colosseum/sdk';
import { deploymentsOf, evmVaultAddress, guardTransaction, isGuardRefusal } from '@colosseum/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hexDecode } from '../../packages/sdk/src/bytes';
import { BASKET_ID, calls, evmTx, OWNER } from '../../packages/sdk/test/evm';

// Gate V3-ROUTE: QQQ, MU, AMD, INTC and SLV, listed on Robinhood Chain mainnet with a Uniswap v3 pool
// and no v4 one, are shown and traded. The builder's own bytes for each (packages/chain-evm, from the
// committed record) go through the guard with the committed mainnet deployment (packages/sdk), the
// file the app signs with: a buy and a sale of each pass, and the same bytes for another asset do not.
// Nothing here asks a node.

const ROOT = join(import.meta.dirname, '..', '..');
const record = EvmDeploymentRecord.parse(
  JSON.parse(readFileSync(join(ROOT, 'deployments', 'robinhood-mainnet.json'), 'utf8')),
);
const pools = deploymentPools(record);
const live = deploymentsOf('mainnet').robinhood as Loaded<EvmDeployment>;
const FIVE = ['QQQ', 'MU', 'AMD', 'INTC', 'SLV'];
const DEADLINE = 1_792_775_000n;
const cash = record.cash.address as `0x${string}`;

/** The guard's word on one owner swap of `sell` for `buy` with the builder's own route; null: passes. */
function guardOn(sell: string, buy: string, amountIn: bigint, data: `0x${string}`) {
  const token = (id: string) => (live.assets[id]?.token ?? '').toLowerCase();
  const step: ApprovedStep = {
    legId: 'leg-v3',
    chain: 'robinhood',
    owner: OWNER,
    basketId: BASKET_ID,
    kind: 'swap',
    trades: [{ sell, buy, inRaw: String(amountIn), minOutRaw: '1' }],
  };
  const tx = evmTx(step, {
    to: evmVaultAddress(live, OWNER, BASKET_ID),
    data: calls.ownerSwap(
      [[live.routers[0] ?? '', token(sell), token(buy), amountIn, 1n, hexDecode(data)]],
      DEADLINE,
    ),
    chainId: 4663,
  });
  try {
    guardTransaction({
      step,
      tx: { ...tx, provenance: 'live', preview: { ...tx.preview, provenance: 'live' } },
      deployment: live,
      consents: [],
    });
    return null;
  } catch (e) {
    if (isGuardRefusal(e)) return e;
    throw e;
  }
}

describe('the five Robinhood Chain tokens whose money is in Uniswap v3', () => {
  afterEach(() => vi.useRealTimers());
  const five = record.assets.filter((a) => FIVE.includes(a.symbol));

  it('are in the catalog the API lists, with their largest trade and their average pool', () => {
    expect(five.map((a) => a.symbol)).toEqual(FIVE);
    const listed = deploymentAssets(record);
    for (const a of five) {
      const row = listed.find((r) => r.id === a.id);
      expect(row, a.symbol).toMatchObject({ provenance: 'live', priceKind: 'chainlink' });
      expect(deploymentLimits(record).maxTradeUsd[a.address], a.symbol).toBe(a.maxTradeUsd);
      expect(deploymentLimits(record).average?.[a.address]?.pool, a.symbol).toBe(a.v3Pool?.pool);
    }
    // DELL stays held back (its v4 pool still costs over 1% at $1,000), and nothing else is hidden.
    expect((record.hidden ?? []).map((h) => h.symbol)).toEqual(['DELL']);
    expect(listed.map((r) => r.symbol)).not.toContain('DELL');
  });

  it("route through their own v3 pool, and the guard passes the builder's bytes, a buy and a sale", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Number(DEADLINE - 300n) * 1000);
    for (const a of five) {
      const token = a.address as `0x${string}`;
      const pool = poolOf(pools, cash, token);
      expect(isV3Pool(pool) && pool.v3Pool, a.symbol).toBe(a.v3Pool?.pool);
      const buy = swapCalldata(pools, {
        tokenIn: cash,
        tokenOut: token,
        amountIn: 500_000_000n,
        deadline: DEADLINE,
      });
      expect(
        guardOn(record.cash.id, a.id, 500_000_000n, buy)?.message ?? null,
        a.symbol,
      ).toBeNull();
      const sale = swapCalldata(pools, {
        tokenIn: token,
        tokenOut: cash,
        amountIn: 10n ** 17n,
        deadline: DEADLINE,
      });
      expect(guardOn(a.id, record.cash.id, 10n ** 17n, sale)?.message ?? null, a.symbol).toBeNull();
    }
  });

  it("refuses one token's v3 bytes for another, and a v3 route for a token whose pool is v4", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Number(DEADLINE - 300n) * 1000);
    const [qqq, mu] = five;
    if (!qqq || !mu) throw new Error('the five are not listed');
    // QQQ's bytes (fee 500) under a step that buys MU (fee 3000): another token and another pool.
    const qqqBytes = swapCalldata(pools, {
      tokenIn: cash,
      tokenOut: qqq.address as `0x${string}`,
      amountIn: 500_000_000n,
      deadline: DEADLINE,
    });
    expect(guardOn(record.cash.id, mu.id, 500_000_000n, qqqBytes)?.code).toBe('asset');
    // NVDA's own route is a v4 swap; the v3 shape for it is refused.
    const nvda = record.assets.find((a) => a.symbol === 'NVDA');
    if (!nvda) throw new Error('NVDA is not listed');
    const v3ForNvda = swapCalldata(
      {
        ...pools,
        byToken: {
          ...pools.byToken,
          [nvda.address]: { v3Pool: qqq.v3Pool?.pool as `0x${string}`, fee: 100 },
        },
      },
      {
        tokenIn: cash,
        tokenOut: nvda.address as `0x${string}`,
        amountIn: 500_000_000n,
        deadline: DEADLINE,
      },
    );
    expect(guardOn(record.cash.id, nvda.id, 500_000_000n, v3ForNvda)?.code).toBe('route');
  });
});
