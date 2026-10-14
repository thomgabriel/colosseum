import { createMockAdapter, mockAddress } from '@colosseum/chain-mock';
import {
  ChainError,
  type ChainId,
  parseChainConfigs,
  type VaultPosition,
} from '@colosseum/schemas';
import { describe, expect, it, vi } from 'vitest';
import type { ChainEntry } from './chains';
import { Refusal } from './errors';
import { leftoverSales } from './shared';

// A follow whose version and what the vault still holds of the assets it drops come to more than the
// vault's lines sells those leftovers first, before the accept (gate SHARED-RULES-V2): 16 lines on
// Solana, 24 on an EVM vault. Where a leftover cannot be sold now, the follow is refused in plain words.

function entryOn(chain: ChainId): ChainEntry {
  const adapter = createMockAdapter({ chain });
  return {
    chain,
    mode: 'mock',
    provenance: 'mock',
    source: 'chain-mock',
    config: parseChainConfigs({})[chain],
    adapter,
    mock: adapter.mock,
  };
}

const position = (asset: string, raw = '1000000'): VaultPosition => ({
  asset,
  raw,
  multiplier: '1',
  display: '1',
  targetBps: 0,
  lastKeeperAt: null,
  valueUsd: '1',
  weightBps: 0,
  driftBps: 0,
});
/** `n` assets of a version, by made-up ids: a version's assets are never quoted. */
const version = (chain: ChainId, n: number) =>
  Array.from({ length: n }, (_, i) => ({ asset: `${chain}:v${i}`, weightBps: 50 }));
const vaultOf = (chain: ChainId, held: string[]) => ({
  owner: mockAddress(chain, 'owner'),
  cash: position(`${chain}:usdc`),
  positions: held.map((a) => position(a)),
});
const LISTED = ['spy', 'nvda', 'tsla', 'gold', 'yield'];

describe('the sales a follow makes before its accept', () => {
  it('sells nothing while the version and the leftovers fit the vault’s lines', async () => {
    const solana = entryOn('solana');
    const held = LISTED.slice(0, 4).map((s) => `solana:${s}`);
    expect(await leftoverSales(solana, vaultOf('solana', held), version('solana', 12))).toEqual([]);
    const robinhood = entryOn('robinhood');
    const eight = [...LISTED, 'x1', 'x2', 'x3'].map((s) => `robinhood:${s}`);
    expect(
      await leftoverSales(robinhood, vaultOf('robinhood', eight), version('robinhood', 16)),
    ).toEqual([]);
    // An asset the version keeps is no leftover, and neither is one the vault holds none of.
    const kept = [...version('solana', 15).map((t) => t.asset), 'solana:spy'];
    const vault = vaultOf('solana', kept);
    vault.positions.push(position('solana:nvda', '0'));
    expect(await leftoverSales(solana, vault, version('solana', 15))).toEqual([]);
  });

  it('past them, sells every leftover for cash, all of it, each with a minimum, in steps the chain takes', async () => {
    const solana = entryOn('solana');
    const held = LISTED.map((s) => `solana:${s}`);
    const steps = await leftoverSales(solana, vaultOf('solana', held), version('solana', 12));
    const trades = steps.flatMap((s) => s.trades ?? []);
    expect(steps.every((s) => s.kind === 'swap' && s.chain === 'solana')).toBe(true);
    expect(trades.map((t) => t.sell).sort()).toEqual([...held].sort());
    expect(trades.every((t) => t.buy === 'solana:usdc' && t.amountInRaw === '1000000')).toBe(true);
    for (const s of steps) {
      expect(s.expected).toHaveLength(s.trades?.length ?? -1);
      for (const e of s.expected ?? []) {
        expect(BigInt(e.minOutRaw)).toBeGreaterThan(0n);
        expect(BigInt(e.minOutRaw)).toBeLessThanOrEqual(BigInt(e.outRaw));
      }
      expect(s.trades?.length ?? 0).toBeLessThanOrEqual(solana.adapter.capabilities.maxTradesPerTx);
    }
    // The 16-asset swap of SHARED-RULES-V2 on a vault with no room beside its sixteen: one leftover.
    const one = await leftoverSales(
      solana,
      vaultOf('solana', [...version('solana', 15).map((t) => t.asset), 'solana:spy']),
      [...version('solana', 15), { asset: 'solana:nvda', weightBps: 50 }],
    );
    expect(one.flatMap((s) => s.trades ?? []).map((t) => t.sell)).toEqual(['solana:spy']);
  });

  it('refuses in plain words where a leftover cannot be sold now: not listed, or no quote', async () => {
    const solana = entryOn('solana');
    const held = [...LISTED.slice(0, 4), 'gone'].map((s) => `solana:${s}`);
    const refusal = await leftoverSales(
      solana,
      vaultOf('solana', held),
      version('solana', 12),
    ).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(Refusal);
    expect((refusal as Refusal).status).toBe(409);
    expect((refusal as Refusal).message).toMatch(
      /17 lines, more than the vault's 16, and solana:gone cannot be sold now.*Sell or withdraw it, then follow/,
    );
    vi.spyOn(solana.adapter, 'quote').mockRejectedValue(
      new ChainError('MarketClosed', 'the market is closed'),
    );
    const closed = await leftoverSales(
      solana,
      vaultOf(
        'solana',
        LISTED.map((s) => `solana:${s}`),
      ),
      version('solana', 12),
    ).catch((e: unknown) => e);
    expect((closed as Refusal).message).toMatch(/cannot be sold now: the market is closed/);
  });
});
