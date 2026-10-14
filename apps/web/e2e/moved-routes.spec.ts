import { expect, test } from '@playwright/test';
import { dictionary } from '../i18n';

// The pages named after the bar's items (gate ROUTES-MATCH-NAV, Thom, Oct 14): every old address
// answers a permanent redirect to its new one, with its slug, id and query, and the new one is a page.

const ID = '7d9c2f4e-1b2a-4c3d-8e9f-0a1b2c3d4e5f';
const MOVED: [string, string][] = [
  ['/shelf', '/products'],
  ['/indexes/three-of-the-largest', '/products/three-of-the-largest'],
  [
    '/indexes/three-of-the-largest/buy?chain=solana',
    '/products/three-of-the-largest/buy?chain=solana',
  ],
  ['/publish?vault=abc&chain=solana', '/products/publish?vault=abc&chain=solana'],
  ['/goal', '/invest'],
  [`/plan/${ID}`, `/invest/plan/${ID}`],
  [`/plan/${ID}/buy`, `/invest/plan/${ID}/buy`],
  ['/vaults/solana/abc', '/portfolio/vaults/solana/abc'],
  ['/vaults/solana/abc?do=rebalance', '/portfolio/vaults/solana/abc?do=rebalance'],
  ['/vaults/solana/abc/add', '/portfolio/vaults/solana/abc/add'],
  ['/vaults/solana/abc/targets', '/portfolio/vaults/solana/abc/targets'],
  ['/vaults/solana/abc/withdraw', '/portfolio/vaults/solana/abc/withdraw'],
  [`/orders/${ID}`, `/portfolio/orders/${ID}`],
  ['/monitor', '/portfolio/monitor'],
];

test('every old address leads, for good, to the page it is now', async ({ page }) => {
  // under `next dev` each new address is built on its first visit
  test.setTimeout(600_000);
  for (const [old, now] of MOVED) {
    const answer = await page.request.get(old, { maxRedirects: 0 });
    expect(answer.status(), old).toBe(308);
    expect(answer.headers().location, old).toBe(now);
    // and the new address is a page of the app, not the 404
    const landed = await page.request.get(now);
    expect(landed.status(), now).toBe(200);
  }
});

test('a sign-in link with an old address leads on to the new one', async ({ page }) => {
  await page.goto(`/sign-in?next=${encodeURIComponent('/shelf')}`);
  await page.getByRole('button', { name: dictionary('en').signIn.passkey.continue }).click();
  await expect(page).toHaveURL(/\/products$/);
});
