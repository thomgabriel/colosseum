import { describe, expect, it } from 'vitest';
import { APP_ROUTES } from '../features/account/next-path';
import config from '../next.config';
import { MOVED_ROUTES, movedPath, movedRedirects } from './moved-routes';

// The pages named after the bar's items (gate ROUTES-MATCH-NAV, Thom, Oct 14), and their old addresses.

/** A Next path pattern as next-path.ts names a route: `:id` becomes `[id]`. */
const asRoute = (pattern: string) => pattern.replace(/:(\w+)/g, '[$1]');

describe('the old addresses', () => {
  it('each lead, for good, to a page of the app under its bar item', () => {
    for (const { from, to } of MOVED_ROUTES) {
      expect(APP_ROUTES, to).toContain(asRoute(to));
      expect(APP_ROUTES, from).not.toContain(asRoute(from));
      expect(to.split('/')[1], to).toMatch(/^(products|invest|portfolio)$/);
    }
  });

  it('are redirects Next is handed, permanent, in every phase', async () => {
    for (const phase of ['phase-development-server', 'phase-production-build']) {
      const redirects = (await config(phase).redirects?.()) ?? [];
      for (const { from, to } of MOVED_ROUTES)
        expect(redirects).toContainEqual({ source: from, destination: to, permanent: true });
    }
    expect(movedRedirects()).toHaveLength(MOVED_ROUTES.length);
  });

  it('keep their slug, id and address', () => {
    expect(movedPath('/indexes/three-of-the-largest/buy')).toBe(
      '/products/three-of-the-largest/buy',
    );
    expect(movedPath('/plan/abc')).toBe('/invest/plan/abc');
    expect(movedPath('/vaults/robinhood/0xabc/targets')).toBe(
      '/portfolio/vaults/robinhood/0xabc/targets',
    );
    expect(movedPath('/orders/o-1')).toBe('/portfolio/orders/o-1');
    // an address that never moved, or one with more segments than a page had, is left as it is
    for (const same of [
      '/invest',
      '/portfolio',
      '/analytics/stocks',
      '/vaults/solana/abc/x',
      '/goal/x',
    ])
      expect(movedPath(same)).toBe(same);
  });
});
