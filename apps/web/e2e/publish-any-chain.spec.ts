import { expect, type Page, test } from '@playwright/test';
import { dictionary } from '../i18n';
import { axe, STUB, shot, WIDTHS, walletAddress } from './waits';

// The publish form offers the person's vaults on every chain whose portfolios Products lists, whatever
// chain their account is on (Thom, Oct 15). Where the server lists live portfolios only, a vault the
// link names on a chain it does not list is said to be on a test network, and with no vault to offer
// the page says so in one line, with the way to make one. On the stub's Solana, at 1440 and 375 px.

const en = dictionary('en');
const p = en.shared.publish;
test.skip(process.env.E2E_CHAIN === 'robinhood', 'the stub runs Robinhood Chain');

const push = (page: Page, href: string) =>
  page.evaluate((h) => {
    (window as unknown as { next: { router: { push(x: string): void } } }).next.router.push(h);
  }, href);

/** Signs in and gives the person a vault of their own on the stub's Solana; answers its address. */
async function withVault(page: Page): Promise<string> {
  await page.request.post(`${STUB}/__stub/reset`);
  await page.goto('/sign-in?next=%2Fproducts');
  await page.getByRole('button', { name: en.signIn.passkey.continue }).click();
  const on = page.locator('main a[href="/products"]');
  if (await on.isVisible({ timeout: 3_000 }).catch(() => false))
    await on.click({ timeout: 3_000 }).catch(() => {});
  await expect(page).toHaveURL(/\/products/);
  const made = await page.request.post(`${STUB}/__stub/source-vault`, {
    data: {
      owner: await walletAddress(page),
      targets: [
        { asset: 'solana:spy', weightBps: 6000 },
        { asset: 'solana:nvda', weightBps: 4000 },
      ],
    },
  });
  expect(made.ok(), await made.text()).toBe(true);
  return ((await made.json()) as { address: string }).address;
}

for (const width of WIDTHS)
  test(`a Solana vault named where Products lists live portfolios only says why, at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const vault = await withVault(page);
    await page.request.post(`${STUB}/__stub/live-only`);
    await push(page, `/products/publish?vault=${vault}&chain=solana`);
    const none = page.locator('[data-ui="publish-no-vault"]');
    await expect(none.locator('[data-ui="publish-unlisted"]')).toHaveText(
      'Solana runs on a test network here, and Products lists real-money portfolios only.',
    );
    // the stub runs no chain live, so no vault of theirs is offered: one line, and a way to make one
    await expect(none).toContainText(p.noVaultOn(''));
    await expect(none.getByRole('link', { name: p.makeVault })).toHaveAttribute('href', '/invest');
    await expect(page.locator('[data-ui="publish-screen"]')).toHaveCount(0);
    await axe(page, `publish, no vault listed, ${width}px`);
    await shot(page, 'publish-unlisted');
  });

for (const width of WIDTHS)
  test(`the person's vaults are offered with their chain where every chain is listed, at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const vault = await withVault(page);
    await push(page, '/products/publish');
    const select = page.getByRole('combobox', { name: p.sourceVault, exact: true });
    await expect(select).toHaveValue(`solana:${vault}`);
    await expect(select.locator('option:checked')).toHaveText(`Solana · ${vault}`);
    await expect(page.locator('[data-ui="publish-source"]')).toHaveText(`Solana · ${vault}`);
    await expect(page.locator('[data-ui="publish-row"]')).toHaveCount(2, { timeout: 60_000 });
    await expect(page.locator('[data-ui="publish-unlisted"]')).toHaveCount(0);
    await axe(page, `publish, every chain listed, ${width}px`);
    await shot(page, 'publish-any-chain');
  });
