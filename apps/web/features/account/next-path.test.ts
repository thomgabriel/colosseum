import { describe, expect, it, vi } from 'vitest';
import SignInPage from '../../app/(app)/sign-in/page';
import { sourceFiles } from '../../components/ui/test/css';
import { AFTER_SIGN_IN, APP_ROUTES, nextPath } from './next-path';

vi.mock('next/navigation', () => import('../wallet/test/mock-next'));

// `?next=` on the sign-in page: where a person goes once signed in. Anyone can write it into a link.

describe('where sign-in leads on to', () => {
  it('is a page of this app, named by its plain path', () => {
    expect(nextPath('/invest')).toBe('/invest');
    expect(nextPath('/portfolio/monitor')).toBe('/portfolio/monitor');
    // `/` is the landing page, not the product's: it is not a place sign-in leads on to, unless a
    // product's routes name it
    expect(nextPath('/')).toBe(AFTER_SIGN_IN);
    expect(nextPath('/', ['/', '/invest'])).toBe('/');
    expect(AFTER_SIGN_IN).toBe('/invest');
    // the plan, buy and order pages, each with one plain segment for its id
    const id = '7d9c2f4e-1b2a-4c3d-8e9f-0a1b2c3d4e5f';
    for (const page of [`/invest/plan/${id}`, `/invest/plan/${id}/buy`, `/portfolio/orders/${id}`])
      expect(nextPath(page)).toBe(page);
    for (const page of [
      '/plan',
      '/invest/plan/a/b',
      '/portfolio/orders',
      `/portfolio/orders/${id}/buy`,
      '/invest/plan/a.b/buy',
    ])
      expect(nextPath(page)).toBe(AFTER_SIGN_IN);
  });

  it('is where an address from before the pages were renamed is now (ROUTES-MATCH-NAV)', () => {
    const id = '7d9c2f4e-1b2a-4c3d-8e9f-0a1b2c3d4e5f';
    for (const [old, now] of [
      ['/goal', '/invest'],
      [`/plan/${id}`, `/invest/plan/${id}`],
      [`/plan/${id}/buy`, `/invest/plan/${id}/buy`],
      ['/shelf', '/products'],
      ['/indexes/three-of-the-largest', '/products/three-of-the-largest'],
      ['/indexes/three-of-the-largest/buy', '/products/three-of-the-largest/buy'],
      ['/publish', '/products/publish'],
      ['/vaults/solana/abc', '/portfolio/vaults/solana/abc'],
      ['/vaults/solana/abc/withdraw', '/portfolio/vaults/solana/abc/withdraw'],
      [`/orders/${id}`, `/portfolio/orders/${id}`],
      ['/monitor', '/portfolio/monitor'],
    ])
      expect(nextPath(old)).toBe(now);
    // and only what was a page: no more segments than it had
    for (const not of ['/vaults/solana/abc/elsewhere', '/plan/a/b', '/goal/x'])
      expect(nextPath(not)).toBe(AFTER_SIGN_IN);
  });

  it('is the goal when it is told nothing', () => {
    for (const nothing of [undefined, null, '', ['/invest'], 7, {}])
      expect(nextPath(nothing)).toBe(AFTER_SIGN_IN);
  });

  it.each([
    // another site, as a browser or a server reads it
    '//evil.com',
    '/..//evil.com',
    '/..//risk',
    '/.//x',
    '/\\evil.com',
    '/\\/evil.com',
    'https://evil.com/goal',
    'http:/goal',
    'javascript:alert(1)',
    // a way round a plain reading of the path
    '/invest/../sign-in',
    '/invest/./x',
    '/invest//',
    '/invest/',
    '/%2e%2e/goal',
    '/%2Fevil.com',
    '/invest%00',
    '/invest\n',
    ' /invest',
    '/invest ',
    '/invest?next=//evil.com',
    '/invest#//evil.com',
    '/@evil.com',
    // not a page of this app
    '//',
    '/nope',
    '/Goal',
    '/invest/extra',
    '/risk',
    '/dev/ui',
    // not a place to go on to
    '/sign-in',
  ])('takes nothing else: %j', (raw) => {
    expect(nextPath(raw)).toBe(AFTER_SIGN_IN);
  });

  it('knows a route with a segment that varies, for when the app has one', () => {
    const routes = ['/invest', '/plans/[id]'];
    expect(nextPath('/plans/abc-123', routes)).toBe('/plans/abc-123');
    for (const not of ['/plans', '/plans/a/b', '/plans/a%2Fb', '/plans/..', '/plans//goal'])
      expect(nextPath(not, routes)).toBe(AFTER_SIGN_IN);
  });
});

describe('the routes sign-in knows', () => {
  it('are the product’s pages, no more and no fewer', () => {
    const pages = [...sourceFiles()]
      .filter((file) => /^app\/\(app\)\/(.+\/)?page\.tsx$/.test(file))
      // the catch-all is no page to lead to: it answers 404, and as a route sign-in knows its one
      // free segment would let `?next=` name any address
      .filter((file) => file !== 'app/(app)/[...missing]/page.tsx')
      // a route group, `(section)`, is no part of the address
      .map(
        (file) =>
          file
            .replace(/^app\/\(app\)/, '')
            .replace(/\/\([^)]+\)/g, '')
            .replace(/\/page\.tsx$/, '') || '/',
      )
      .sort();
    expect(pages).toEqual([
      '/analytics',
      '/analytics/[page]',
      '/analytics/methodology',
      '/invest',
      '/invest/plan/[id]',
      '/invest/plan/[id]/buy',
      '/leaderboard',
      '/portfolio',
      '/portfolio/closed',
      '/portfolio/exposure',
      '/portfolio/methodology',
      '/portfolio/monitor',
      '/portfolio/orders/[id]',
      '/portfolio/plan/[chain]/[address]',
      '/portfolio/rebalancing',
      '/portfolio/vaults/[chain]/[address]',
      '/portfolio/vaults/[chain]/[address]/add',
      '/portfolio/vaults/[chain]/[address]/targets',
      '/portfolio/vaults/[chain]/[address]/withdraw',
      '/products',
      '/products/[slug]',
      '/products/[slug]/buy',
      '/products/publish',
      '/sign-in',
    ]);
    expect([...APP_ROUTES].sort()).toEqual(pages);
  });

  it('is what the sign-in page hands the screen, whatever the address bar says', async () => {
    const to = async (next: string | string[] | undefined) => {
      const page = await SignInPage({ searchParams: Promise.resolve({ next }) });
      return (page.props as { next: string }).next;
    };
    expect(await to('/invest')).toBe('/invest');
    for (const raw of ['/..//evil.com', '/.//x', '//evil.com', '/\\evil.com', ['/invest', '//x']])
      expect(await to(raw)).toBe('/invest');
    expect(await to(undefined)).toBe('/invest');
  });
});
