import type { MixReview } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { dictionary } from '../../i18n';
import { displayName } from '../order/plain';
import { namedAsRows } from './MixReviewCard';

// A review's warnings name its holdings as its rows do (audit I4): the /goal review read "SPY" and
// "Gold" in its rows and "SPYx" and "mGOLD" in its warnings.

const en = dictionary('en');
const review = {
  lines: [
    { assetId: 'solana:spyx', symbol: 'SPYx', cls: 'stock' },
    { assetId: 'solana:mgold', symbol: 'mGOLD', cls: 'commodity' },
    { assetId: 'solana:usdc', symbol: 'USDC', cls: 'cash' },
  ],
} as unknown as MixReview;
const named = (asset: string) => displayName(asset, en.plan);

describe('a warning named as the rows name its holdings', () => {
  it('renames every holding it mentions, with or without an asset id of its own', () => {
    expect(
      namedAsRows(
        'Sample: SPYx is larger than its tier’s ceiling, and so is mGOLD.',
        review,
        named,
      ),
    ).toBe(
      `Sample: ${named('solana:spyx')} is larger than its tier’s ceiling, and so is ${named('solana:mgold')}.`,
    );
  });

  it('changes a whole name only, and leaves cash and the rest of the sentence as written', () => {
    expect(namedAsRows('SPYxL is not SPYx; USDC stays USDC.', review, () => 'X')).toBe(
      'SPYxL is not X; USDC stays USDC.',
    );
  });
});
