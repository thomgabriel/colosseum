import { describe, expect, it } from 'vitest';
import { dictionary } from '../../i18n';
import {
  centsOfShare,
  leastCentsOf,
  maxText,
  readAmount,
  shareOfCents,
  shownBalance,
} from './amount-check';

// The words the amount card says of an amount, for each way it can be wrong, and what Max types.

const en = dictionary('en');
const bounds = { least: 10, most: 1_000_000, available: 500, of: 'balance' as const };

describe('readAmount', () => {
  it('says nothing of an empty field', () => {
    expect(readAmount('', 'en', bounds, en)).toEqual({ amount: null, problem: null, over: false });
  });

  it('reads an amount in the page’s language', () => {
    expect(readAmount('250', 'en', bounds, en).amount).toBe(250);
    expect(readAmount('$1,250.50', 'en', { ...bounds, available: null }, en).amount).toBe(1250.5);
    expect(readAmount('1.250,50', 'pt', { ...bounds, available: null }, en).amount).toBe(1250.5);
  });

  it('names the least, the most, and what is not an amount', () => {
    expect(readAmount('5', 'en', bounds, en).problem).toBe('At least $10');
    expect(readAmount('2000000', 'en', bounds, en).problem).toBe('At most $1,000,000');
    expect(readAmount('ten', 'en', bounds, en).problem).toBe(en.amount.errors.notAmount);
  });

  it('says more than the balance on a deposit, and more than the vault holds on a withdrawal', () => {
    expect(readAmount('600', 'en', bounds, en)).toEqual({
      amount: 600,
      problem: en.amount.errors.overBalance,
      over: true,
    });
    expect(readAmount('600', 'en', { ...bounds, of: 'vault' }, en).problem).toBe(
      en.amount.errors.overVault,
    );
    // what is not read is not held against the amount
    expect(readAmount('600', 'en', { ...bounds, available: null }, en).over).toBe(false);
  });
});

describe('maxText', () => {
  it('types the whole of it to the cent, never above, with the page’s decimal mark', () => {
    expect(maxText(1234.567, 'en')).toBe('1234.56');
    expect(maxText(1234.567, 'pt')).toBe('1234,56');
    expect(maxText(40, 'en')).toBe('40');
    expect(maxText(0.1 + 0.2, 'en')).toBe('0.30');
  });
});

describe('shownBalance', () => {
  it('cuts a balance down to the cent, so the figure typed back is never more than there is', () => {
    expect(shownBalance(1234.567, 'USDC', 'en-US')).toBe('1,234.56 USDC');
    expect(shownBalance(0.999, 'USDC', 'en-US')).toBe('0.99 USDC');
    expect(shownBalance(1234.5, 'USDC', 'pt-BR')).toBe('1.234,50 USDC');
  });
});

describe('a share of a vault, in integers', () => {
  it('names the least amount as one basis point, up to the cent, and it is one', () => {
    expect(leastCentsOf('300')).toBe(3n);
    expect(shareOfCents(3n, '300')).toBe(1);
    expect(shareOfCents(2n, '300')).toBe(0);
    expect(leastCentsOf('1000000')).toBe(10_000n);
    expect(shareOfCents(15_000n, '1000000')).toBe(1);
    expect(leastCentsOf('349.65')).toBe(4n);
    expect(shareOfCents(4n, '349.65')).toBe(1);
  });

  it('for every vault of whole hundreds up to $5,000,000: the least is one basis point, a cent less is none', () => {
    for (let usd = 100; usd <= 5_000_000; usd += 100) {
      const value = String(usd);
      const least = leastCentsOf(value) as bigint;
      expect(shareOfCents(least, value), value).toBe(1);
      expect(shareOfCents(least - 1n, value), value).toBe(0);
    }
  });

  it('cuts a share down, never past the whole, and says what it comes to in cents, cut down', () => {
    expect(shareOfCents(33_330n, '1000')).toBe(3333);
    expect(shareOfCents(200_000n, '1000')).toBe(10_000);
    expect(centsOfShare(5000, '349.65')).toBe(17_482n);
    expect(centsOfShare(1, '1000000')).toBe(10_000n);
    expect(shareOfCents(1n, 'not a figure')).toBeNull();
    expect(shareOfCents(1n, '0')).toBeNull();
  });
});
