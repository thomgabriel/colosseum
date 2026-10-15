import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TRUST_STATUS } from './trust';

// The trust notice states the admin key and the keeper's limits in numbers. They are the deploy's, and
// the deploy's record is the one place they are written: the constant is held to it.

const devnet = JSON.parse(
  readFileSync(new URL('../../../deployments/solana-devnet.json', import.meta.url), 'utf8'),
) as { roles: { admin: string }; params: { toleranceBps: number; lossCapBps: number } };

const robinhood = JSON.parse(
  readFileSync(new URL('../../../deployments/robinhood-testnet.json', import.meta.url), 'utf8'),
) as { roles: { admin: string } };
const robinhoodConfig = JSON.parse(
  readFileSync(new URL('../../../contracts/script/config/46630.json', import.meta.url), 'utf8'),
) as { params: { toleranceBps: number; lossCapBps: number } };

// The deploy file of the deploy that is live: the redeploy's once its record is committed (its Safe
// holds the keys, no timelock), the file of 2026-10-12 until then.
const recordUrl = new URL('../../../deployments/robinhood-mainnet.json', import.meta.url);
const live = existsSync(recordUrl) && 'safe' in JSON.parse(readFileSync(recordUrl, 'utf8'));
const robinhoodMainnet = JSON.parse(
  readFileSync(
    new URL(
      `../../../contracts/script/config/${live ? '4663.json' : '4663-2026-10-12.json'}`,
      import.meta.url,
    ),
    'utf8',
  ),
) as {
  timelock?: { owner: string; delay: number };
  safe?: { address: string };
  safeMinThreshold: number;
  guardian: string;
  keeperEnabled: boolean;
  caps?: string;
  depositCaps?: unknown;
};

describe('TRUST_STATUS, on mainnet', () => {
  it('states who can change the Robinhood Chain contracts as the mainnet deploy file sets it', () => {
    const facts = TRUST_STATUS.mainnet.robinhood;
    const safe = robinhoodMainnet.safe?.address ?? robinhoodMainnet.timelock?.owner ?? '';
    expect(facts?.safe.toLowerCase()).toBe(safe.toLowerCase());
    expect(facts?.safeSignatures).toBe(robinhoodMainnet.safeMinThreshold);
    expect(facts?.delayHours).toBe((robinhoodMainnet.timelock?.delay ?? 0) / 3600);
    expect(facts?.guardian.toLowerCase()).toBe(robinhoodMainnet.guardian.toLowerCase());
  });

  it('says there is no keeper and no deposit cap there only while the deploy file says so', () => {
    const facts = TRUST_STATUS.mainnet.robinhood;
    expect(facts?.keeper).toBe(robinhoodMainnet.keeperEnabled);
    expect(facts?.depositCap).toBe(robinhoodMainnet.depositCaps !== undefined);
    expect(robinhoodMainnet.caps).toBe('none');
  });

  it('has no mainnet facts for a chain that is not deployed there', () => {
    expect(TRUST_STATUS.mainnet.solana).toBeUndefined();
    expect(TRUST_STATUS.mainnet.base).toBeUndefined();
  });
});

// The deploy's own record, once a person has deployed and written it. Until the file exists there is
// nothing to hold the notice to but the deploy file above; from then on this runs and must pass.

describe.skipIf(!existsSync(recordUrl))('TRUST_STATUS, against the mainnet deploy record', () => {
  it('names the Safe, the guardian and the delay the record names', () => {
    const record = JSON.parse(readFileSync(recordUrl, 'utf8')) as {
      roles: { admin: string; guardian: string; keeper: string };
      timelock?: { address: string; minDelay: number; proposers: string[] };
      safe?: { address: string; threshold?: number };
      expected: { keeperEnabled: boolean; depositCaps?: unknown };
    };
    const facts = TRUST_STATUS.mainnet.robinhood;
    expect(record.roles.guardian.toLowerCase()).toBe(facts?.guardian.toLowerCase());
    if (record.safe) {
      // The Safe holds the keys itself: no delay to state, and the signatures the chain answered.
      expect(record.roles.admin.toLowerCase()).toBe(facts?.safe.toLowerCase());
      expect(facts?.delayHours).toBe(0);
      // A notice that changed what it says is a new text, read again before the next deposit.
      expect(TRUST_STATUS.textVersion).not.toBe('2026-10-12');
      if (record.safe.threshold !== undefined)
        expect(record.safe.threshold).toBe(facts?.safeSignatures);
    } else {
      expect(record.timelock?.proposers.map((a) => a.toLowerCase())).toEqual([
        facts?.safe.toLowerCase(),
      ]);
      expect((record.timelock?.minDelay ?? 0) / 3600).toBe(facts?.delayHours);
      expect(record.roles.admin.toLowerCase()).toBe(record.timelock?.address.toLowerCase());
    }
    expect(record.expected.keeperEnabled).toBe(facts?.keeper);
    // No keeper is no keeper's key either: the role is the zero address.
    expect(/^0x0{40}$/.test(record.roles.keeper)).toBe(!facts?.keeper);
    expect(record.expected.depositCaps !== undefined).toBe(facts?.depositCap);
  });
});

describe('TRUST_STATUS', () => {
  it('names the admin of the Robinhood Chain deployment and the keeper’s limits there, as its deploy set them', () => {
    expect(TRUST_STATUS.admin.robinhood).toBe(robinhood.roles.admin);
    expect(TRUST_STATUS.keeper.robinhood).toEqual({
      toleranceBps: robinhoodConfig.params.toleranceBps,
      weeklyLossCapBps: robinhoodConfig.params.lossCapBps,
    });
  });

  it('names the admin of the Solana deployment, as its deploy recorded it', () => {
    expect(TRUST_STATUS.admin.solana).toBe(devnet.roles.admin);
  });

  it('states the keeper’s limits on Solana as the deploy set them', () => {
    expect(TRUST_STATUS.keeper.solana).toEqual({
      toleranceBps: devnet.params.toleranceBps,
      weeklyLossCapBps: devnet.params.lossCapBps,
    });
  });

  it('says the code is unaudited and the team holds the upgrade keys', () => {
    expect(TRUST_STATUS.audited).toBe(false);
    expect(TRUST_STATUS.upgradeKeys).toBe('team');
    expect(TRUST_STATUS.textVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
