import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  acceptanceFile,
  confirmed,
  deployedOf,
  proposedRows,
  sendState,
} from '../scripts/ops/redeploy';

// The Safe's one batch after the Robinhood Chain redeploy (gate ROBINHOOD-REDEPLOY), and the values of
// the deploy file a person confirms before a send. The broadcast is forge's own, from the fork
// rehearsal (`contracts/script/redeploy-fork.sh`): nothing in it reached a network.

const ROOT = join(import.meta.dirname, '..');
const read = (path: string) => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
const broadcast = read('tests/fixtures/mainnet-records/redeploy-run-latest.json');
const committed = read('contracts/script/config/4663.json');
/** The file as it stood before Thom confirmed the 17 tokens (2026-10-15): their notes Proposed again. */
const config = JSON.parse(
  JSON.stringify(committed).replace(
    /Confirmed by Thom, 2026-10-15, as proposed (\d{4}-\d{2}-\d{2})/g,
    'Proposed $1',
  ),
);
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
  it('finds nothing Proposed in the file as committed: Thom confirmed all 17 on 2026-10-15', () => {
    expect(proposedRows(committed)).toEqual([]);
    expect(confirmed(config, 'Thom', '2026-10-15')).toEqual(committed);
  });

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

describe('a send that stopped, and what may resume it', () => {
  const at = broadcast.timestamp as number;
  const reverted = {
    ...broadcast,
    receipts: broadcast.receipts.map((r: { status: string }, i: number) =>
      i === 7 ? { ...r, status: '0x0' } : r,
    ),
  };
  // Each spawns the script with tsx: seconds apiece on a loaded machine, so these two get two minutes.
  const cli = (flags: string[], record: unknown) => {
    const dir = mkdtempSync(join(tmpdir(), 'redeploy-'));
    const path = join(dir, 'run-latest.json');
    if (record !== null) writeFileSync(path, JSON.stringify(record));
    const run = spawnSync(
      'pnpm',
      ['-s', 'exec', 'tsx', 'scripts/ops/redeploy.ts', ...flags, '--broadcast', path],
      { cwd: ROOT, encoding: 'utf8' },
    );
    return { code: run.status, out: `${run.stdout}${run.stderr}` };
  };

  it('counts a record as this send’s only when forge wrote it after the send began', () => {
    expect(sendState(broadcast, at)).toEqual({ fresh: true, sent: 54, reverted: [] });
    // The deploy of 2026-10-12, or any record older than the send: not this redeploy's.
    expect(sendState(broadcast, at + 1).fresh).toBe(false);
    expect(sendState(reverted, at).reverted).toEqual([broadcast.receipts[7].transactionHash]);
  });

  it('marks a send as begun only when a transaction went out: a refused send leaves none, and no mark', () => {
    expect(cli(['--sent', '--since', String(at)], broadcast).code).toBe(0);
    // A send refused before it broadcast leaves the older record, or none at all.
    expect(cli(['--sent', '--since', String(at + 1)], broadcast).code).toBe(3);
    expect(cli(['--sent', '--since', String(at)], null).code).toBe(3);
  }, 120_000);

  it('resumes only this redeploy’s record, and never one with a reverted transaction', () => {
    const ok = cli(['--resumable', '--since', String(at)], broadcast);
    expect([ok.code, ok.out]).toEqual([
      0,
      expect.stringMatching(/54 transactions .* none reverted/),
    ]);
    const old = cli(['--resumable', '--since', String(at + 1)], broadcast);
    expect([old.code, old.out]).toEqual([1, expect.stringMatching(/not this redeploy's/)]);
    const bad = cli(['--resumable', '--since', String(at)], reverted);
    expect([bad.code, bad.out]).toEqual([1, expect.stringMatching(/reverted .* never sent again/)]);
  }, 120_000);
});
