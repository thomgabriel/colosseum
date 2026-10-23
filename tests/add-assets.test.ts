import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AddAssetsFile, EvmDeploymentRecord } from '@colosseum/chain-evm/vault';
import { readDeploymentFile } from '@colosseum/sdk';
import { describe, expect, it } from 'vitest';
import { heldToFile, promote, recordFor, safeFiles, safeListFile } from '../scripts/ops/add-assets';

// More tokens on Robinhood Chain mainnet through the timelock: the record keeps them under `pending`,
// which nothing that trades or shows reads, until the chain lists them; then they move to `assets` and
// into the guard's file together. Nothing here reads a chain.

const ROOT = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const file = AddAssetsFile.parse(JSON.parse(read('contracts/script/config/4663-assets-2.json')));
// The factory of 2026-10-12, its record and the guard's file as they stood before the redeploy took both.
const record = JSON.parse(read('deployments/robinhood-mainnet-2026-10-12.json'));
const guard = JSON.parse(read('tests/fixtures/mainnet-records/guard-2026-10-12.json'));

describe('the tokens the Safe lists after the deploy', () => {
  it("are the record's pending tokens, exactly as the file makes them", () => {
    expect(() => heldToFile(record, file)).not.toThrow();
    const edited = structuredClone(record);
    edited.pending[0].maxTradeUsd += 1;
    expect(() => heldToFile(edited, file)).toThrow(/not the file's/);
  });

  it('never go into the guard’s file of another factory: the redeploy’s', () => {
    const now = JSON.parse(read('packages/sdk/deployments/mainnet.json'));
    expect(() => promote(record, now, [record.pending[0].address])).toThrow(/another factory/);
    // Nor into one that names none, and never from a record that names none.
    const none = structuredClone(guard);
    delete none.chains.robinhood.factory;
    expect(() => promote(record, none, [record.pending[0].address])).toThrow(/names no factory/);
    const bare = structuredClone(record);
    delete bare.contracts.factory;
    expect(() => promote(bare, none, [record.pending[0].address])).toThrow(/names no factory/);
  });

  it('are not in the guard’s file before the chain lists them', () => {
    const ids = Object.keys(guard.chains.robinhood.assets);
    for (const p of record.pending) expect(ids, p.id).not.toContain(p.id);
  });

  it('move into the record’s assets and the guard’s file once listed, and every reader takes both', () => {
    const [first, ...rest] = record.pending;
    const next = promote(record, guard, [first.address]);
    expect(next.moved).toEqual([first.symbol]);
    const parsed = EvmDeploymentRecord.parse(next.record);
    expect(parsed.assets.at(-1)?.address).toBe(first.address);
    expect(parsed.assets.at(-1)).not.toHaveProperty('operation');
    expect(parsed.pending?.map((p) => p.symbol)).toEqual(
      rest.map((p: { symbol: string }) => p.symbol),
    );
    const loaded = readDeploymentFile(next.guard).robinhood;
    expect(loaded?.family).toBe('evm');
    expect(next.guard.chains.robinhood.assets[first.id]).toEqual({
      address: first.address,
      decimals: first.decimals,
      pool: first.pool,
    });
    // Nothing listed, nothing moves.
    expect(promote(record, guard, []).moved).toEqual([]);
  });

  it('leave a held-back token pending when the chain lists it, and move a v3-routed one with its v3 pool', () => {
    const all = record.pending.map((p: { address: string }) => p.address);
    const held = file.assets.filter((a) => a.heldBack !== undefined).map((a) => a.symbol);
    const next = promote(record, guard, all, held);
    const left = (next.record.pending as { symbol: string; pool: unknown }[]).map((p) => p.symbol);
    for (const symbol of held) expect(left, symbol).toContain(symbol);
    // Gate V3-ROUTE: the builders route v3, so a v3-routed token is shown once listed.
    for (const a of file.assets.filter((x) => x.v3Pool !== undefined)) {
      expect(next.moved, a.symbol).toContain(a.symbol);
      expect(next.guard.chains.robinhood.assets[`robinhood:${a.symbol.toLowerCase()}`]).toEqual({
        address: a.token,
        decimals: a.tokenDecimals,
        v3Pool: a.v3Pool,
      });
    }
    expect(next.moved.length + left.length).toBe(record.pending.length);
    EvmDeploymentRecord.parse(next.record);
  });

  it('come as two Transaction Builder files from the Safe to the timelock, schedule then execute', () => {
    const { batch, schedule, execute } = safeFiles(file, 'more tokens');
    expect(schedule.transactions[0]?.data).toBe(batch.schedule);
    expect(execute.transactions[0]?.data).toBe(batch.execute);
    for (const f of [schedule, execute]) {
      expect(f.chainId).toBe('4663');
      expect(f.transactions).toHaveLength(1);
      expect(f.transactions[0]?.to.toLowerCase()).toBe(file.timelock);
      expect(f.meta.createdFromSafeAddress.toLowerCase()).toBe(file.safe);
    }
    expect(schedule.meta.description).toContain(batch.operationId);
  });
});

// Gate LIST-13: more tokens on the redeploy's factory, whose admin is the Safe itself. One batch of setAsset
// calls the Safe signs once; the record keeps the tokens under `pending` until the chain lists them.
describe('the tokens of LIST-13, on the redeploy’s factory', () => {
  const list = AddAssetsFile.parse(JSON.parse(read('contracts/script/config/4663-assets-3.json')));
  const now = JSON.parse(read('deployments/robinhood-mainnet.json'));
  const guardNow = JSON.parse(read('packages/sdk/deployments/mainnet.json'));
  const committed = JSON.parse(read('contracts/script/config/4663-assets-3.safe.json'));

  it("name the redeploy's factory, its Safe and cash, and no timelock", () => {
    expect(list.timelock).toBeUndefined();
    expect(recordFor(list, [record, now])).toBe(now);
    expect(list.factory).toBe(now.contracts.factory);
    expect(list.safe).toBe(now.safe.address);
    expect(list.safe).toBe(now.roles.admin);
    expect(list.cashToken).toBe(now.cash.address);
    expect(list.priceBoundBps).toBe(now.priceBoundBps);
  });

  it('hold each token to the bar of WIDER-LIST, apart from everything the chain lists already', () => {
    const onChain = new Set(
      [now.cash, ...now.assets, ...(now.hidden ?? [])].map((a: { address: string }) => a.address),
    );
    for (const a of list.assets) {
      expect(onChain.has(a.token), a.symbol).toBe(false);
      expect([a.source, a.feedDecimals, a.maxAge, a.session], a.symbol).toEqual([1, 8, 93_600, 1]);
      expect([a.flags, a.minPrice, a.maxPrice], a.symbol).toEqual([0, 0, 0]);
      expect(a.maxTradeUsd, a.symbol).toBeGreaterThanOrEqual(1_000);
      expect(a.maxWeightBps % 50, a.symbol).toBe(0);
      // A v3 token is kept out of the app until it builds that route, and the file says so.
      // Gate V3-ROUTE: a v3 token is shown once listed, so the file holds none back.
      expect(a.heldBack, a.symbol).toBeUndefined();
    }
  });

  it("are the record's pending tokens, and the guard's file names none of them", () => {
    expect(() => heldToFile(now, list)).not.toThrow();
    EvmDeploymentRecord.parse(now);
    const ids = Object.keys(guardNow.chains.robinhood.assets);
    for (const p of now.pending) expect(ids, p.id).not.toContain(p.id);
  });

  it('come as the one committed Transaction Builder file: setAsset on the factory per token, from the Safe', () => {
    const { batch, list: made } = safeListFile(list, 'Tenonfi: more tokens');
    expect(committed).toEqual(made);
    expect(made.transactions).toHaveLength(list.assets.length);
    for (const t of made.transactions) expect(t.to.toLowerCase()).toBe(list.factory);
    expect(made.meta.createdFromSafeAddress.toLowerCase()).toBe(list.safe);
    expect(made.meta.description).toContain(batch.operationId);
    expect(() => safeFiles(list, 'x')).toThrow(/no timelock/);
  });

  it('once listed, move into the record’s assets and the guard’s file with their v3 pool, as QQQ', () => {
    const next = promote(
      now,
      guardNow,
      now.pending.map((p: { address: string }) => p.address),
      [],
      true,
    );
    expect(next.moved).toEqual(list.assets.map((a) => a.symbol));
    expect(next.hidden).toEqual([]);
    expect(next.record.pending).toBeUndefined();
    const qqq = now.assets.find((a: { symbol: string }) => a.symbol === 'QQQ');
    for (const a of list.assets) {
      const id = `robinhood:${a.symbol.toLowerCase()}`;
      const entry = next.record.assets.find((x: { id: string }) => x.id === id);
      expect(entry, a.symbol).not.toHaveProperty('operation');
      expect(Object.keys(entry).sort(), a.symbol).toEqual(Object.keys(qqq).sort());
      expect(entry, a.symbol).toMatchObject({ pool: null, v3Pool: a.v3Pool });
      expect(next.guard.chains.robinhood.assets[id], a.symbol).toEqual({
        address: a.token,
        decimals: a.tokenDecimals,
        v3Pool: a.v3Pool,
      });
    }
    EvmDeploymentRecord.parse(next.record);
    readDeploymentFile(next.guard);
    // --status still reads the file against the record afterwards.
    expect(() => heldToFile(next.record, list)).not.toThrow();
  });
});
