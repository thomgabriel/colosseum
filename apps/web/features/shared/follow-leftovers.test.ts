import { describe, expect, it } from 'vitest';
import { sharedShapeOk } from '../order/order-check';
import { planTermsOf } from '../order/run-order';
import { followLeftovers, readTerms, type SharedTerms } from './terms';
import { followOrder } from './test/fixtures';

// A follow may sell first what the vault holds of the assets the version drops (gate SHARED-RULES-V2).
// This app works those sales out from its own reads (the vault, the version's assets), never from the
// order; the order's shape is held to them, and the guard is handed them.

const base = followOrder(['accept_version']);
const accept = base.legs[0] as (typeof base.legs)[number];
const sale = (sell: string, amountInRaw: string, minOutRaw = '1960') => ({
  ...accept,
  id: '66666666-6666-4666-8666-666666666666',
  seq: 0,
  kind: 'swap' as const,
  trades: [{ sell, buy: 'solana:usdc', amountInRaw }],
  expected: [{ inRaw: amountInRaw, outRaw: '2000', minOutRaw, costBps: 10 }],
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

const held = (asset: string, raw = '300', untargeted?: true) => ({
  asset,
  raw,
  ...(untargeted ? { untargeted } : {}),
});
/** Sixteen assets in the version, the vault holding SPYx (dropped) beside them, on Solana's 16 lines. */
const version = Array.from({ length: 16 }, (_, i) => ({
  asset: `solana:v${i}`,
  weightBps: 500,
}));
const vault = {
  cash: { asset: 'solana:usdc' },
  positions: [...version.map((t) => held(t.asset, '1000')), held('solana:spyx')],
};
const made = { ...terms, leftovers: followLeftovers('solana', vault, version) };

describe('a follow that sells what the version drops first', () => {
  it('works the sales out from the vault and the version as read, and hands them to the guard', () => {
    expect(made.leftovers).toEqual({
      keeps: version.map((t) => t.asset),
      sales: [{ asset: 'solana:spyx', amountRaw: '300' }],
    });
    expect(readTerms(JSON.parse(JSON.stringify(made)))).toEqual(made);
    expect(planTermsOf(made)).toMatchObject({ leftovers: made.leftovers });
    // Room on the lines, nothing held of what it drops, or a token held with no line: no sale.
    expect(
      followLeftovers(
        'solana',
        { ...vault, positions: vault.positions.slice(1) },
        version.slice(1),
      ),
    ).toBeUndefined();
    expect(
      followLeftovers(
        'solana',
        { ...vault, positions: [...vault.positions.slice(0, 16), held('solana:spyx', '0')] },
        version,
      ),
    ).toBeUndefined();
    expect(
      followLeftovers(
        'robinhood',
        {
          cash: { asset: 'robinhood:usdg' },
          positions: [held('robinhood:stray', '5', true)],
        },
        Array.from({ length: 24 }, (_, i) => ({ asset: `robinhood:v${i}`, weightBps: 50 })),
      ),
    ).toBeUndefined();
  });

  it('holds the order to them: the sales worked out, before the accept, and nothing else trades', () => {
    expect(sharedShapeOk(withSale, made)).toBe(true);
    expect(sharedShapeOk(base, terms)).toBe(true);
    const sold = (leg: ReturnType<typeof sale>) => ({
      ...withSale,
      legs: [leg, withSale.legs[1] as never],
    });
    // A sale the terms do not name, another amount, a sale after the accept, or terms with none.
    expect(sharedShapeOk(sold(sale('solana:nvdax', '300')), made)).toBe(false);
    expect(sharedShapeOk(sold(sale('solana:spyx', '301')), made)).toBe(false);
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

  it('refuses a sale of an asset the version keeps, and a minimum of 1 raw', () => {
    // Our server adds "sell all of the vault's v0" to a follow where v0 stays: not the terms' sale.
    expect(
      sharedShapeOk(
        {
          ...withSale,
          legs: [
            sale('solana:spyx', '300'),
            { ...sale('solana:v0', '1000'), id: '77777777-7777-4777-8777-777777777777', seq: 1 },
            { ...accept, seq: 2 },
          ],
        },
        made,
      ),
    ).toBe(false);
    // Terms that were handed a kept asset as a sale do not even read.
    expect(
      readTerms({
        ...made,
        leftovers: { keeps: ['solana:v0'], sales: [{ asset: 'solana:v0', amountRaw: '1000' }] },
      }),
    ).toBeNull();
    const sold = (min: string) => ({
      ...withSale,
      legs: [sale('solana:spyx', '300', min), withSale.legs[1] as never],
    });
    expect(sharedShapeOk(sold('1'), made)).toBe(false);
    expect(sharedShapeOk(sold('0'), made)).toBe(false);
    expect(sharedShapeOk(sold('1940'), made)).toBe(true);
    expect(sharedShapeOk(sold('1938'), made)).toBe(false);
  });
});
