import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
// `shortAddress` (features/shared/use-person.ts) cuts as `shorten` does; it imports the wallet
import { shorten as shortAddress } from '../components/ui/format';
import { dictionary } from '../i18n';
import { openPlan } from './invest';
import { inTheme } from './theme';

// What a page says is what it knows (the UI audit of Oct 13, "bugs that mislead"): a plan whose kinds
// of asset are known says what a bad fall could cost, and never "$0, since nothing here is stocks"
// for a plan of stocks (F2); a visitor on a vault's page is led back to Products under a title that
// names the vault (V8); an address that is no vault says so, with one way back (V9); and an order's
// page lights no section of the bar (G8). On the stub's Solana, at 375 px, light and dark.

const en = dictionary('en');
test.skip(process.env.E2E_CHAIN === 'robinhood', 'the stub runs Robinhood Chain');
const STUB = `http://localhost:${process.env.E2E_API_PORT ?? 3901}`;
/** An owner nobody signs as: the vault it holds is somebody else's to anyone who opens its page. */
const STRANGER = 'DNv1r8KV9xsSkuuSx3qXn4jnpZiYaiyfwC4yTk7cBvUa';

async function check(page: Page, name: string) {
  for (const theme of ['light', 'dark'] as const) {
    await inTheme(page, theme);
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    const found = result.violations.flatMap((v) =>
      v.nodes.map((n) => `${v.id}: ${n.html.slice(0, 160)} ${n.failureSummary ?? ''}`),
    );
    expect(found, `${name}, ${theme}`).toEqual([]);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(wide, `${name}, ${theme}: no sideways scroll`).toBeLessThanOrEqual(375);
  }
}

test.beforeEach(async ({ page }) => {
  await page.request.post(`${STUB}/__stub/reset`);
});

test('a plan of stocks and gold says what a bad fall could cost, never $0', async ({ page }) => {
  // SPY, NVDA and Gold: the stub counts their fall as the engine does
  await openPlan(page);
  const answer = page.locator('[data-ui="plan-answer"]');
  await expect(answer).toContainText('50% in SPY');
  await expect(answer).toContainText('in a bad fall about −$');
  await expect(answer).not.toContainText('no loss counted');
  await expect(page.locator('[data-ui="plan-bad-fall"]')).toContainText('you’d lose about $');
  await expect(page.locator('[data-ui="plan-bad-fall"]')).not.toHaveText(en.plan.badFall.none);
  await check(page, 'plan');
});

test('a visitor on a vault’s page: its address for a title, its chain, and the way to Products', async ({
  page,
}) => {
  const source = await page.request.post(`${STUB}/__stub/source-vault`, {
    data: {
      owner: STRANGER,
      targets: [
        { asset: 'solana:spy', weightBps: 6000 },
        { asset: 'solana:nvda', weightBps: 4000 },
      ],
    },
  });
  expect(source.ok(), await source.text()).toBe(true);
  const { address } = (await source.json()) as { address: string };
  await page.goto(`/vaults/solana/${address}`);
  const head = page.locator('[data-ui="vault-screen"] header');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    en.shared.vaults.address(shortAddress(address)),
  );
  await expect(head.locator('[data-ui="chain-badge"]')).toHaveText('Solana');
  const back = head.locator('[data-ui="vault-back"]');
  await expect(back).toHaveText(en.shared.vault.backVisitor);
  await expect(back).toHaveAttribute('href', '/shelf');
  await expect(page.getByText(en.shared.vault.back)).toHaveCount(0);
  await expect(page.getByText(en.shared.vault.title)).toHaveCount(0);
  await check(page, 'vault-visitor');
});

test('an address that is no vault says so, with one way back', async ({ page }) => {
  for (const address of ['not-a-vault', STRANGER]) {
    await page.goto(`/vaults/solana/${address}`);
    const unread = page.locator('[data-ui="vault-unread"]');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(en.shared.vault.missing);
    await expect(unread.getByRole('link')).toHaveCount(1);
    await expect(unread.getByRole('link')).toHaveText(en.shared.vault.backVisitor);
    await expect(unread.getByRole('button')).toHaveCount(0);
    await expect(unread).not.toContainText('shared portfolios');
  }
  await check(page, 'vault-missing');
});

test('an order’s page lights no section of the bar', async ({ page }) => {
  // at 375 the bar's links are in the sheet under the menu button, and are read from there
  const bar = page.locator('header nav a[href="/goal"]').first();
  await page.goto('/orders/7d9e4a62-1f3b-4c5d-8e6f-a0b1c2d3e4f5');
  await expect(bar).toBeAttached({ timeout: 60_000 });
  await expect(page.locator('header a[aria-current="page"]')).toHaveCount(0);
  // a plan's page is still under Invest
  await page.goto('/plan/7d9e4a62-1f3b-4c5d-8e6f-a0b1c2d3e4f5');
  await expect(bar).toHaveAttribute('aria-current', 'page');
});
