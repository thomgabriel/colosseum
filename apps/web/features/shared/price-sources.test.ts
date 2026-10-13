import { describe, expect, it } from 'vitest';
import { priceSourceLines } from './price-sources';

const A = 'HSk67BDSrh8486PHxqVgyHMHCbwrnstLbcGfKYdG3q9g';
const B = 'BBk67BDSrh8486PHxqVgyHMHCbwrnstLbcGfKYdG3q9g';
const OWNER = '2ticePjZZ6e34bNUgUXz7v3uHm3jS8jvV13gesdvKn4f';
const scope = (account: string, entry: number) =>
  `price account ${account} (Scope layout, owner ${OWNER}), entry ${entry}`;

describe('priceSourceLines', () => {
  it('folds one account read at several entries into one line, entries in order', () => {
    expect(priceSourceLines([scope(A, 482), scope(A, 484), scope(A, 454), scope(A, 482)])).toEqual([
      { kind: 'account', layout: 'Scope', account: A, owner: OWNER, entries: [454, 482, 484] },
    ]);
  });

  it('keeps two accounts apart, in the order they came', () => {
    const lines = priceSourceLines([scope(B, 3), scope(A, 1), scope(B, 2)]);
    expect(lines.map((l) => (l.kind === 'account' ? [l.account, l.entries] : l.text))).toEqual([
      [B, [2, 3]],
      [A, [1]],
    ]);
  });

  it('keeps any other source word for word, once, beside the accounts', () => {
    const other = 'Chainlink feed 0xabc on Robinhood Chain, latestRoundData()';
    expect(priceSourceLines(['the mock chain', scope(A, 7), other, 'the mock chain'])).toEqual([
      { kind: 'text', text: 'the mock chain' },
      { kind: 'account', layout: 'Scope', account: A, owner: OWNER, entries: [7] },
      { kind: 'text', text: other },
    ]);
  });

  it('does not take a near miss for an account', () => {
    const near = `price account ${A} (Scope layout, owner ${OWNER}), entry 4 and more`;
    expect(priceSourceLines([near])).toEqual([{ kind: 'text', text: near }]);
  });
});
