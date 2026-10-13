import { describe, expect, it } from 'vitest';
import { dictionary } from '../../i18n';
import { maxText, readAmount } from './amount-check';

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
