import { describe, expect, it } from 'vitest';
import { sharedShapeOk } from '../order/order-check';
import { planTermsOf } from '../order/run-order';
import { readTerms, type SharedTerms, withLeftovers } from './terms';
import { followOrder } from './test/fixtures';

// A follow may sell first what the vault holds of the assets the version drops (gate SHARED-RULES-V2):
// the terms name those sales as the order states them, the order's shape is held to them, and the
// guard is handed them.

const base = followOrder(['accept_version']);
const accept = base.legs[0] as (typeof base.legs)[number];
const sale = (sell: string, amountInRaw: string) => ({
  ...accept,
  id: '66666666-6666-4666-8666-666666666666',
  seq: 0,
  kind: 'swap' as const,
  trades: [{ sell, buy: 'solana:usdc', amountInRaw }],
  expected: [{ inRaw: amountInRaw, outRaw: '2000', minOutRaw: '1900', costBps: 10 }],
});
const withSale = { ...base, legs: [sale('solana:spyx', '300'), { ...accept, seq: 1 }] };
const terms: Extract<SharedTerms, { kind: 'follow' }> = {
  kind: 'follow',
  slug: 'three-of-the-largest',
  familyId: 'ab'.repeat(32),
  vault: 'k7FaK87WHGVXzkaoHb7CdVPgkKDQhZ29VLDeBVbDfYn',
  basketId: '42',
  follow: { recipeOnchainId: 'recipe', version: 2 },
  autoFollow: false,
  source: 'api',
};

describe('a follow that sells what the version drops first', () => {
  it('takes the sales into its terms as the order states them, and hands them to the guard', () => {
    const made = withLeftovers(terms, withSale);
    expect(made).toMatchObject({ leftovers: [{ asset: 'solana:spyx', amountRaw: '300' }] });
    expect(readTerms(JSON.parse(JSON.stringify(made)))).toEqual(made);
    expect(planTermsOf(made)).toMatchObject({
      leftovers: [{ asset: 'solana:spyx', amountRaw: '300' }],
    });
    // No sale, nothing added.
    expect(withLeftovers(terms, base)).toBe(terms);
  });

  it('holds the order to them: the sales named, before the accept, and nothing else trades', () => {
    const made = withLeftovers(terms, withSale);
    if (made.kind !== 'follow') throw new Error('follow terms');
    expect(sharedShapeOk(withSale, made)).toBe(true);
    expect(sharedShapeOk(base, terms)).toBe(true);
    // A sale the terms do not name, another amount, a sale after the accept, or terms with none.
    expect(
      sharedShapeOk(
        { ...withSale, legs: [sale('solana:nvdax', '300'), withSale.legs[1] as never] },
        made,
      ),
    ).toBe(false);
    expect(
      sharedShapeOk(
        { ...withSale, legs: [sale('solana:spyx', '301'), withSale.legs[1] as never] },
        made,
      ),
    ).toBe(false);
    expect(
      sharedShapeOk(
        {
          ...withSale,
          legs: [
            { ...accept, seq: 0 },
            { ...sale('solana:spyx', '300'), seq: 1 },
          ],
        },
        made,
      ),
    ).toBe(false);
    expect(sharedShapeOk(withSale, terms)).toBe(false);
    expect(sharedShapeOk(base, made)).toBe(false);
  });
});
