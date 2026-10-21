import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { dictionary } from '../i18n';
import { portfolioDictionary } from '../i18n/portfolio';
import { conversations, openVault } from './conversations';
import { inTheme } from './theme';

// Closing a vault and opening it again (gate VAULT-CLOSE-REUSE), on the stub's mock chain: an empty
// vault is closed after a confirm, leaves the person's lists of vaults, is named on the closed vaults
// page reached from the foot of the portfolio, and is back in the lists once reopened. A vault that
// holds something is told to withdraw first. SCREENSHOTS_DIR keeps a picture of the confirm and of the
// closed vaults page, at 1440 in the dark.

const en = dictionary('en');
const w = portfolioDictionary('en');
const close = en.shared.vault.page.close;
const STUB = `http://localhost:${process.env.E2E_API_PORT ?? 3901}`;
const SHOTS = process.env.SCREENSHOTS_DIR;

async function go(page: Page, name: string) {
  await page.getByRole('button', { name: en.shell.menu }).click();
  await page.locator('[data-ui="compact-nav-sheet"]').getByRole('link', { name }).click();
}

async function axe(page: Page, at: string) {
  for (const theme of ['light', 'dark'] as const) {
    await inTheme(page, theme);
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    const found = result.violations.flatMap((v) =>
      v.nodes.map((n) => `${v.id}: ${n.html.slice(0, 160)} ${n.failureSummary ?? ''}`),
    );
    expect(found, `${at}, ${theme}`).toEqual([]);
  }
  await inTheme(page, 'light');
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.setViewportSize({ width: 1440, height: 900 });
  await inTheme(page, 'dark');
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${SHOTS}/${name}-1440-dark.png` });
  await inTheme(page, 'light');
  await page.setViewportSize({ width: 375, height: 812 });
}

/** Signed in, with a vault of the person's own on its page: empty, or holding $100. */
async function toVault(page: Page, empty: boolean): Promise<string> {
  await page.request.post(`${STUB}/__stub/reset`);
  await page.goto('/invest');
  await page.locator('header a[href^="/sign-in"]').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: en.signIn.passkey.continue }).click();
  await expect(dialog).toHaveCount(0);
  const shownWallet = page
    .locator(
      '[data-ui="compact-nav-sheet"] [data-ui="account-wallet"][data-chain="solana"] [data-ui="account-address"]',
    )
    .first();
  await expect(shownWallet).toHaveAttribute('title', /.+/);
  const owner = await shownWallet.getAttribute('title');
  const source = await page.request.post(`${STUB}/__stub/source-vault`, {
    data: {
      owner,
      empty,
      targets: [
        { asset: 'solana:spy', weightBps: 6000 },
        { asset: 'solana:nvda', weightBps: 4000 },
      ],
    },
  });
  expect(source.ok(), await source.text()).toBe(true);
  const { address } = await source.json();
  // through the app's own links: the throwaway sign-in does not outlive a page load
  await go(page, en.shell.portfolio);
  await expect(page).toHaveURL(/\/portfolio$/);
  await go(page, en.shell.invest);
  await expect(page).toHaveURL(/\/invest$/);
  await openVault(page, 'solana', address);
  await expect(page).toHaveURL(new RegExp(`/portfolio/vaults/solana/${address}$`));
  await expect(page.locator('[data-ui="vault-screen"]')).toHaveAttribute('data-pane', 'holdings');
  return address;
}

/** The vault's row in Invest's conversations panel, opened where it is a sheet. */
const offered = async (page: Page, address: string) =>
  (await conversations(page)).locator(
    `[data-ui="conversation-row"][data-kind="vault"][data-chain="solana"][data-address="${address}"]`,
  );

test('an empty vault is closed after a confirm, leaves the lists, and comes back when reopened', async ({
  page,
}) => {
  const address = await toVault(page, true);

  await page.locator('[data-ui="vault-more"]').click();
  await page.locator('[data-action="vault-close"]').click();
  const confirm = page.locator('[data-ui="vault-close-confirm"]');
  await expect(confirm.getByRole('heading', { name: close.title })).toBeFocused();
  await expect(confirm).toContainText(close.body);
  await axe(page, 'the confirm');
  await shot(page, 'vault-close-confirm');

  // kept open: nothing changes
  await confirm.getByRole('button', { name: close.keep }).click();
  await expect(confirm).toHaveCount(0);
  await page.locator('[data-ui="vault-more"]').click();
  await page.locator('[data-action="vault-close"]').click();
  await page.locator('[data-action="vault-close-confirm"]').click();
  await expect(page.locator('[data-ui="vault-closed"]')).toContainText(
    en.shared.vault.page.closed.title,
  );

  // gone from the lists of the person's vaults: Invest's conversations panel
  await go(page, en.shell.invest);
  await expect(page).toHaveURL(/\/invest$/);
  await expect(page.locator('[data-ui="conversations-open"]')).toBeVisible();
  // the other vaults are listed: the panel has read them, and this one is not among them
  const panel = await conversations(page);
  await expect(
    panel.locator('[data-ui="conversation-row"][data-kind="vault"]').first(),
  ).toBeVisible();
  await expect(await offered(page, address)).toHaveCount(0);
  await page.keyboard.press('Escape');

  // named at the foot of the portfolio, on a page of its own
  await go(page, en.shell.portfolio);
  const link = page.locator('[data-ui="closed-vaults-link"] a');
  await expect(link).toHaveText(w.closed.link(1));
  await link.click();
  await expect(page).toHaveURL(/\/portfolio\/closed$/);
  const row = page.locator('[data-ui="closed-vault"]');
  await expect(row).toHaveCount(1);
  await expect(row.locator('[data-ui="chain-badge"]')).toHaveAttribute('data-chain', 'solana');
  await axe(page, 'the closed vaults');
  await shot(page, 'closed-vaults');

  await row.getByRole('button', { name: w.closed.reopen }).click();
  await expect(row).toContainText(w.closed.reopened);
  await go(page, en.shell.invest);
  await expect(await offered(page, address)).toHaveCount(1);
});

test('a vault that holds something is told to withdraw first, and is not closed', async ({
  page,
}) => {
  await toVault(page, false);
  await page.locator('[data-ui="vault-more"]').click();
  await page.locator('[data-action="vault-close"]').click();
  const confirm = page.locator('[data-ui="vault-close-confirm"]');
  await expect(confirm).toContainText(close.notEmpty);
  await expect(confirm.locator('[data-action="vault-close-confirm"]')).toHaveCount(0);
  await confirm.locator('[data-action="vault-close-withdraw"]').click();
  await expect(page.locator('[data-ui="vault-screen"]')).toHaveAttribute('data-pane', 'withdraw');
});
