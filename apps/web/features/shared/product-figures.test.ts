import { describe, expect, it } from 'vitest';
import { dictionary } from '../../i18n';
import { kindShares, kindsSaid } from './product-figures';

// A shared portfolio's headline says what it holds by kind. A kind the server did not send is no
// kind: such a holding is named by itself, never counted as "Other" (the UI audit, F2: "Other 100%"
// for SPY, NVDA and TSLA).

const en = dictionary('en');
const row = (
  name: string,
  shareBps: number,
  cls: Parameters<typeof kindShares>[0][number]['cls'],
) => ({
  name,
  shareBps,
  cls,
});

describe('the kinds a portfolio holds, said', () => {
  it('adds up the holdings of one kind, largest first, with only the first capital', () => {
    const rows = [row('SPYx', 3000, 'etf'), row('PAXG', 2000, 'gold'), row('QQQx', 5000, 'etf')];
    expect(kindShares(rows, 'en-US', en.plan.kinds)).toEqual(['Funds 80%', 'Gold 20%']);
    expect(kindsSaid(rows, 'en-US', en.plan.kinds)).toBe('Funds 80% and gold 20%');
  });

  it('names a holding of no known kind by itself, and never says "Other"', () => {
    const rows = [row('SPY', 4000, null), row('NVDA', 3000, null), row('TSLA', 3000, null)];
    expect(kindShares(rows, 'en-US', en.plan.kinds)).toEqual(['SPY 40%', 'NVDA 30%', 'TSLA 30%']);
    expect(kindsSaid(rows, 'en-US', en.plan.kinds)).toBe('SPY 40%, NVDA 30%, and TSLA 30%');
    expect(kindsSaid(rows, 'en-US', en.plan.kinds)).not.toContain(en.plan.kinds.other);
  });

  it('keeps the kinds it knows beside the names it does not', () => {
    const rows = [row('syrupUSDC', 6000, 'dollar_yield'), row('SomeMint', 4000, null)];
    expect(kindsSaid(rows, 'en-US', en.plan.kinds)).toBe('Dollar yield 60% and SomeMint 40%');
  });
});
