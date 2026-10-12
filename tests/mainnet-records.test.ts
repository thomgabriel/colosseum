import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EvmDeploymentRecord } from '@colosseum/chain-evm/vault';
import { readDeploymentFile } from '@colosseum/sdk';
import { describe, expect, it } from 'vitest';
import { parseRecord } from '../scripts/ops/authority';
import { buildRecords, validate } from '../scripts/ops/mainnet-records';

// The two files the app runs on after a mainnet deploy, written from what the deploy left behind. The
// broadcast here is forge's own, from a run of the deploy script against a local fork of Robinhood
// Chain mainnet: nothing in it reached a network. The deploy file is the committed one with its
// unconfirmed marks taken out, as a person will have done before deploying.

const ROOT = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const broadcast = read('tests/fixtures/mainnet-records/run-latest.json');
const committed = read('contracts/script/config/4663.json');
const config = committed.replaceAll('TODO', 'confirmed');
const guard = read('packages/sdk/deployments/mainnet.json');
// biome-ignore lint/suspicious/noExplicitAny: files as they are read, edited field by field
type Json = any;
const edit = (text: string, change: (j: Json) => void) => {
  const j = JSON.parse(text);
  change(j);
  return JSON.stringify(j);
};

describe('the records of a mainnet deploy', () => {
  it('are built from the broadcast and the deploy file, and every reader takes them', () => {
    const built = buildRecords({ broadcast, config, guard });
    validate(built);
    const record = EvmDeploymentRecord.parse(built.record);
    expect([record.network, record.provenance, record.evmChainId]).toEqual([
      'robinhood-mainnet',
      'live',
      4663,
    ]);
    // The deploy creates seven contracts; the two proxies are the factory, then the registry.
    const b = JSON.parse(broadcast);
    const made = (name: string) =>
      b.transactions
        .filter((t: Json) => t.transactionType === 'CREATE' && t.contractName === name)
        .map((t: Json) => t.contractAddress.toLowerCase());
    expect(record.contracts).toEqual({
      factory: made('ERC1967Proxy')[0],
      registry: made('ERC1967Proxy')[1],
      beacon: made('VaultBeacon')[0],
      vaultLogic: made('BasketVault')[0],
      factoryLogic: made('VaultFactory')[0],
      registryLogic: made('IndexRegistry')[0],
    });
    expect(record.roles.admin).toBe(made('TimelockController')[0]);
    expect(record.roles.priceWriter).toBeNull();
    expect(record.deployBlock).toBeGreaterThan(80_000_000);

    // The authority check reads the same file: the timelock, the Safe as its one holder, what to expect.
    const authority = parseRecord(JSON.stringify(built.record));
    const file = JSON.parse(config);
    expect(authority.timelock?.address).toBe(record.roles.admin);
    expect(Number(authority.timelock?.minDelay)).toBe(file.timelock.delay);
    expect(authority.timelock?.proposers).toEqual([file.timelock.owner.toLowerCase()]);
    expect(authority.roles.guardian).toBe(file.guardian.toLowerCase());
    expect(authority.expected?.keeperEnabled).toBe(false);
  });

  it('list every token of the deploy file with its feed, pool and largest trade, and nothing else', () => {
    const { record } = buildRecords({ broadcast, config, guard });
    const file = JSON.parse(config);
    const tokens = file.assets.filter((a: Json) => a.token !== file.cashToken);
    const assets = (record as Json).assets as Json[];
    expect(assets.map((a) => a.address)).toEqual(tokens.map((a: Json) => a.token.toLowerCase()));
    for (const [i, a] of assets.entries()) {
      expect(a.feed).toBe(tokens[i].feed.toLowerCase());
      expect(a.pool).toEqual(tokens[i].pool);
      expect(a.maxTradeUsd).toBe(tokens[i].maxTradeUsd);
      expect(a.keeperOn).toBe(false);
      expect(a.id).toBe(`robinhood:${a.symbol.toLowerCase()}`);
    }
    expect((record as Json).cash).toMatchObject({
      id: 'robinhood:usdg',
      symbol: 'USDG',
      decimals: 6,
    });
  });

  it('fill the guard’s file with the three addresses and take its placeholder mark away', () => {
    expect(() => readDeploymentFile(JSON.parse(guard))).toThrow(/placeholder/);
    const built = buildRecords({ broadcast, config, guard });
    const filled = built.guard as Json;
    expect(filled.placeholder).toBeUndefined();
    expect(filled.todo).toBeUndefined();
    const record = built.record as Json;
    expect(filled.chains.robinhood).toMatchObject({
      factory: record.contracts.factory,
      beacon: record.contracts.beacon,
      registry: record.contracts.registry,
    });
    // Its tokens and pools are untouched: they were reviewed where they are.
    expect(filled.chains.robinhood.assets).toEqual(JSON.parse(guard).chains.robinhood.assets);
    const loaded = readDeploymentFile(filled).robinhood;
    expect(loaded).toMatchObject({ family: 'evm', provenance: 'live', evmChainId: 4663 });
  });

  it('refuse rather than guess', () => {
    const refused = (
      input: Partial<{ broadcast: string; config: string; guard: string }>,
      why: RegExp,
    ) => expect(() => buildRecords({ broadcast, config, guard, ...input })).toThrow(why);
    // The committed deploy file, with its unconfirmed values still marked.
    refused({ config: committed }, /still holds a TODO/);
    refused({ broadcast: edit(broadcast, (b) => (b.chain = 46_630)) }, /both must be 4663/);
    refused(
      { broadcast: edit(broadcast, (b) => (b.receipts[3].status = '0x0')) },
      /did not succeed/,
    );
    refused({ broadcast: edit(broadcast, (b) => b.receipts.pop()) }, /did not finish/);
    refused(
      {
        broadcast: edit(broadcast, (b) => {
          b.transactions = b.transactions.filter(
            (t: Json) =>
              !(t.transactionType === 'CREATE' && t.contractName === 'TimelockController'),
          );
          b.receipts.pop();
        }),
      },
      /created 0 TimelockController/,
    );
    refused(
      {
        broadcast: edit(broadcast, (b) => {
          const proxy = b.transactions.findIndex(
            (t: Json) => t.transactionType === 'CREATE' && t.contractName === 'ERC1967Proxy',
          );
          b.transactions.splice(proxy, 1);
          b.receipts.pop();
        }),
      },
      /created 1 proxies/,
    );
    refused(
      { guard: edit(guard, (g) => (g.chains.robinhood.assets['robinhood:nvda'].pool.fee = 500)) },
      /NVDA: the guard's file and the deploy file name different pools/,
    );
    refused(
      { guard: edit(guard, (g) => delete g.chains.robinhood.assets['robinhood:spy']) },
      /lists no token at/,
    );
    refused(
      {
        guard: edit(guard, (g) => {
          g.chains.robinhood.assets['robinhood:fake'] = {
            address: `0x${'9'.repeat(40)}`,
            decimals: 18,
            pool: { fee: 100, tickSpacing: 1 },
          };
        }),
      },
      /lists a token the deploy did not/,
    );
    refused(
      { guard: edit(guard, (g) => (g.chains.robinhood.assets['robinhood:nvda'].decimals = 6)) },
      /NVDA: the guard's file says 6 decimals/,
    );
  });

  it('a record with a trade left unchecked does not pass the readers', () => {
    const built = buildRecords({
      broadcast,
      config: edit(config, (c) => (c.priceBoundBps = null)),
      guard,
    });
    expect(() => validate(built)).toThrow();
  });
});
