import { describe, expect, it } from 'vitest';
import { FamilyMeta, FamilySlug, TAKEN_SLUGS } from './recipe';

// A shared portfolio's slug is its address on the web, under /products: one that a page of Products
// already takes is no portfolio's (gate ROUTES-MATCH-NAV).

describe('a shared portfolio’s slug', () => {
  it('is lower-case letters, digits and dashes', () => {
    for (const ok of ['three-of-the-largest', 'a', '2026-picks', 'publish-2', 'publisher'])
      expect(FamilySlug.safeParse(ok).success, ok).toBe(true);
    for (const not of ['', '-lead', 'Upper', 'two words', 'dot.ted'])
      expect(FamilySlug.safeParse(not).success, not).toBe(false);
  });

  it('is never an address a page of Products takes', () => {
    expect(TAKEN_SLUGS).toContain('publish');
    for (const taken of TAKEN_SLUGS) {
      expect(FamilySlug.safeParse(taken).success, taken).toBe(false);
      const meta = {
        familyId: 'ab'.repeat(32),
        slug: taken,
        name: 'Taken',
        copy: '',
        kind: 'index',
        chains: ['solana'],
      };
      expect(FamilyMeta.safeParse(meta).success, taken).toBe(false);
      expect(FamilyMeta.safeParse({ ...meta, slug: `${taken}-2` }).success).toBe(true);
    }
  });
});
