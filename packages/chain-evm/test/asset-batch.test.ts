import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeFunctionData, encodeFunctionResult, getAddress, keccak256, toBytes } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  AddAssetsFile,
  assetBatch,
  assetConfigOf,
  listedAsFiled,
  recordEntryOf,
  safeBatchFile,
  safeChecksum,
  TIMELOCK_BATCH_ABI,
} from '../src/vault/asset-batch';
import { EvmDeploymentRecord } from '../src/vault/deployment';
import { VAULT_FACTORY_ABI } from '../src/vault/generated/abi';

// The tokens the Safe lists after the deploy, as one timelock batch: the file they come from, the two
// calls the Safe signs, the Transaction Builder's files, and the record's pending entries. Nothing here
// reads a chain; `contracts/test/fork/RobinhoodForkAddAssets.t.sol` runs the same batch on a fork.

const ROOT = join(import.meta.dirname, '..', '..', '..');
const text = readFileSync(
  join(ROOT, 'contracts', 'script', 'config', '4663-assets-2.json'),
  'utf8',
);
const file = AddAssetsFile.parse(JSON.parse(text));
const record = EvmDeploymentRecord.parse(
  JSON.parse(readFileSync(join(ROOT, 'deployments', 'robinhood-mainnet.json'), 'utf8')),
);
const batch = assetBatch(file);

describe('the committed file of more tokens', () => {
  it('names the deployed factory, its timelock and Safe, and only tokens the deploy did not list', () => {
    expect(file.chainId).toBe(record.evmChainId);
    expect(file.factory).toBe(record.contracts.factory);
    expect(file.timelock).toBe(record.timelock?.address);
    expect(file.delay).toBe(record.timelock?.minDelay);
    expect(file.cashToken).toBe(record.cash.address);
    expect(file.priceBoundBps).toBe(record.priceBoundBps);
    const listed = new Set(record.assets.map((a) => a.address));
    for (const a of file.assets) expect(listed.has(a.token), a.symbol).toBe(false);
    expect(new Set(file.assets.map((a) => a.token)).size).toBe(file.assets.length);
    expect(new Set(file.assets.map((a) => a.feed)).size).toBe(file.assets.length);
    expect(text).not.toContain('TODO');
  });

  it('holds every token to the bar the nine met: a pool that fills $1,000, a largest trade and a feed', () => {
    for (const a of file.assets) {
      expect(a.maxTradeUsd, a.symbol).toBeGreaterThanOrEqual(1_000);
      expect(a.source, a.symbol).toBe(1);
      expect(a.feedDecimals, a.symbol).toBe(8);
      expect(a.maxAge, a.symbol).toBe(93_600);
      // The keeper is off on this mainnet.
      expect([a.flags, a.minPrice, a.maxPrice], a.symbol).toEqual([0, 0, 0]);
      // A stock or a fund trades in the US session; a crypto token always.
      expect(a.session, a.symbol).toBe(a.kind === 'crypto' ? 0 : 1);
    }
  });
});

describe('the batch', () => {
  it('is one setAsset on the factory per token, with the file’s settings, in the file’s order', () => {
    expect(batch.targets).toEqual(file.assets.map(() => file.factory));
    expect(batch.values.every((v) => v === 0n)).toBe(true);
    batch.payloads.forEach((payload, i) => {
      const call = decodeFunctionData({ abi: VAULT_FACTORY_ABI, data: payload });
      expect(call.functionName).toBe('setAsset');
      const [token, config] = call.args as unknown as [string, Record<string, unknown>];
      const a = file.assets[i];
      expect(token.toLowerCase()).toBe(a?.token);
      expect(config.maxWeightBps).toBe(a?.maxWeightBps);
      expect(String(config.feed).toLowerCase()).toBe(a?.feed);
    });
  });

  it('is scheduled with the timelock’s own delay and executed as the same operation', () => {
    const schedule = decodeFunctionData({ abi: TIMELOCK_BATCH_ABI, data: batch.schedule });
    const execute = decodeFunctionData({ abi: TIMELOCK_BATCH_ABI, data: batch.execute });
    expect(schedule.functionName).toBe('scheduleBatch');
    expect(execute.functionName).toBe('executeBatch');
    expect(schedule.args?.slice(0, 5)).toEqual(execute.args);
    expect(schedule.args?.[5]).toBe(172_800n);
    expect(schedule.args?.[3]).toBe(`0x${'0'.repeat(64)}`);
    expect(schedule.args?.[4]).toBe(keccak256(toBytes(file.salt)));
    expect(batch.scheduleHash).toBe(keccak256(batch.schedule));
  });
});

describe("the Transaction Builder's files", () => {
  const made = safeBatchFile({
    chainId: 4663,
    safe: file.safe,
    to: file.timelock,
    data: batch.schedule,
    name: 'schedule',
    description: 'a test',
    createdAt: Date.parse(file.measured.at(-1)?.at ?? ''),
  });

  it('carry the one call, from the Safe to the timelock, with no value', () => {
    expect(made.chainId).toBe('4663');
    expect(made.meta.createdFromSafeAddress.toLowerCase()).toBe(file.safe);
    expect(made.transactions[0]?.to.toLowerCase()).toBe(file.timelock);
    expect(made.transactions).toEqual([
      {
        to: getAddress(file.timelock),
        value: '0',
        data: batch.schedule,
        contractMethod: null,
        contractInputsValues: null,
      },
    ]);
  });

  it('carry the checksum the Transaction Builder checks: its name aside, any change shows', () => {
    expect(made.meta.checksum).toBe(safeChecksum(made));
    expect(safeChecksum({ ...made, meta: { ...made.meta, name: 'renamed' } })).toBe(
      made.meta.checksum,
    );
    const changed = structuredClone(made);
    if (changed.transactions[0]) changed.transactions[0].data = batch.execute;
    expect(safeChecksum(changed)).not.toBe(made.meta.checksum);
  });
});

describe("the record's pending tokens", () => {
  it('are the file’s tokens the record does not list yet, with the batch’s operation', () => {
    const listed = new Set(record.assets.map((a) => a.address));
    const want = file.assets
      .filter((a) => !listed.has(a.token))
      .map((a) => recordEntryOf(a, batch.operationId));
    expect(JSON.parse(JSON.stringify(record.pending ?? []))).toEqual(want);
  });

  it('move only when the batch has run and the chain lists a token with the file’s settings', () => {
    const answer = (a: (typeof file.assets)[number], change = {}) =>
      encodeFunctionResult({
        abi: VAULT_FACTORY_ABI,
        functionName: 'asset',
        result: { ...assetConfigOf(a), ...change },
      });
    const [first, second] = file.assets;
    if (!first || !second) throw new Error('the file lists at least two tokens');
    const configs: Record<string, `0x${string}` | null> = Object.fromEntries(
      file.assets.map((a) => [a.token, null]),
    );
    configs[first.token] = answer(first);
    expect(listedAsFiled(file, { operationDone: false, configs })).toEqual([]);
    expect(listedAsFiled(file, { operationDone: true, configs })).toEqual([first.token]);
    configs[second.token] = answer(second, { maxWeightBps: second.maxWeightBps + 50 });
    expect(() => listedAsFiled(file, { operationDone: true, configs })).toThrow(/other settings/);
  });
});
