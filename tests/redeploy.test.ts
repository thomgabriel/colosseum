import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acceptanceFile, confirmed, deployedOf, proposedRows } from '../scripts/ops/redeploy';

// The Safe's one batch after the Robinhood Chain redeploy (gate ROBINHOOD-REDEPLOY), and the values of
// the deploy file a person confirms before a send. The broadcast is forge's own, from the fork
// rehearsal (`contracts/script/redeploy-fork.sh`): nothing in it reached a network.

const ROOT = join(import.meta.dirname, '..');
const read = (path: string) => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
const broadcast = read('tests/fixtures/mainnet-records/redeploy-run-latest.json');
const config = read('contracts/script/config/4663.json');
const SAFE = '0x4568Bc6Cc821B34095059Fd46102eAA22A675Fdc';

describe('the redeploy’s hand-over', () => {
  it('finds the factory proxy and the beacon the deploy created, and refuses another chain’s record', () => {
    const made = (name: string) =>
      broadcast.transactions.filter(
        (t: { transactionType: string; contractName: string }) =>
          t.transactionType === 'CREATE' && t.contractName === name,
      );
    const { factory, beacon } = deployedOf(broadcast);
    expect(beacon).toBe(made('VaultBeacon')[0].contractAddress.toLowerCase());
    // The factory is the proxy over the factory logic, not the registry's proxy.
    expect(factory).toBe(made('ERC1967Proxy')[0].contractAddress.toLowerCase());
    expect(factory).not.toBe(made('ERC1967Proxy')[1].contractAddress.toLowerCase());
    expect(() => deployedOf({ ...broadcast, chain: 46_630 })).toThrow(/not 4663/);
  });

  it('writes the Safe one transaction of two calls: acceptAdmin on the factory, acceptOwnership on the beacon', () => {
    const { factory, beacon } = deployedOf(broadcast);
    const file = acceptanceFile({ safe: SAFE, factory, beacon, createdAt: 0 });
    expect(file.chainId).toBe('4663');
    expect(file.meta.createdFromSafeAddress.toLowerCase()).toBe(SAFE.toLowerCase());
    expect(file.transactions.map((t) => [t.to.toLowerCase(), t.data, t.value])).toEqual([
      [factory, '0x0e18b681', '0'],
      [beacon, '0x79ba5097', '0'],
    ]);
  });
});

describe('the values a person confirms before a send', () => {
  it('lists the seventeen tokens still Proposed, with what each is listed with', () => {
    const rows = proposedRows(config);
    expect(rows.map((r) => r[0])).toEqual([
      'MSTR',
      'CRCL',
      'USO',
      'PLTR',
      'WETH',
      'cbBTC',
      'DELL',
      'SPCX',
      'COIN',
      'TSM',
      'BABA',
      'SGOV',
      'QQQ',
      'MU',
      'AMD',
      'INTC',
      'SLV',
    ]);
    expect(rows[0]).toEqual([
      'MSTR',
      '25%',
      '$50,000',
      '0x396118bdfb181e6240e74d243f266b061c0edc3d (Robinhood MSTR / USD)',
      'v4 fee 2400 spacing 24',
      '0x17578c0e0d15da44f31677263114f71ae76653ea',
      'shown',
    ]);
    expect(rows.find((r) => r[0] === 'QQQ')?.[6]).toBe('not shown: v3 route');
  });

  it('confirms every Proposed note and nothing else, and leaves none to list', () => {
    const done = confirmed(config, 'Thom', '2026-10-15');
    expect(proposedRows(done)).toEqual([]);
    expect(done.assets[10].maxWeightNote).toMatch(
      /^Confirmed by Thom, 2026-10-15, as proposed 2026-10-13: 2500 bps/,
    );
    // A note confirmed on 2026-10-12 stays as it was, and so does every value.
    expect(done.assets[1].maxWeightNote).toBe(config.assets[1].maxWeightNote);
    const values = (j: unknown) => JSON.stringify(j, (k, v) => (/Note$/.test(k) ? undefined : v));
    expect(values(done)).toBe(values(config));
    expect(() => confirmed(config, 'Thom', 'tomorrow')).toThrow(/not a date/);
  });
});
