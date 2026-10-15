import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { dictionary } from '../i18n';
import { openVault } from './conversations';
import { inTheme } from './theme';

// What a change of targets leaves in cash, and the one rule for "Off target" (Vault #4 on devnet,
// Oct 14): a change to all SPY spends what its sale brings and leaves no cash worth a trade; a vault
// holding idle cash worth a trade says "Off target", offers Rebalance on its page and in the chat's
// reply, and one press spends that cash. On the stub's Solana, at 375 px.

const en = dictionary('en');
const p = en.shared.vault.page;
test.skip(process.env.E2E_CHAIN === 'robinhood', 'the stub runs Robinhood Chain');
const STUB = `http://localhost:${process.env.E2E_API_PORT ?? 3901}`;

async function axe(page: Page, name: string) {
  for (const theme of ['light', 'dark'] as const) {
    await inTheme(page, theme);
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    const found = result.violations.flatMap((v) =>
      v.nodes.map((n) => `${v.id}: ${n.html.slice(0, 160)} ${n.failureSummary ?? ''}`),
    );
    expect(found, `${name}, ${theme}`).toEqual([]);
  }
}

async function go(page: Page, name: string) {
  await page.getByRole('button', { name: en.shell.menu }).click();
  await page.locator('[data-ui="compact-nav-sheet"]').getByRole('link', { name }).click();
}

/** Signed in, with a vault of the person's own made by the stub, on its page. */
async function toVault(
  page: Page,
  source: {
    targets: { asset: string; weightBps: number }[];
    depositRaw?: string;
    cashLeftRaw?: string;
  },
): Promise<string> {
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
  const made = await page.request.post(`${STUB}/__stub/source-vault`, {
    data: { owner, ...source },
  });
  expect(made.ok(), await made.text()).toBe(true);
  const { address } = (await made.json()) as { address: string };
  // through the app's own links: the throwaway sign-in does not outlive a page load
  await go(page, en.shell.portfolio);
  await expect(page).toHaveURL(/\/portfolio$/);
  await go(page, en.shell.invest);
  await openVault(page, 'solana', address);
  await expect(page).toHaveURL(new RegExp(`/portfolio/vaults/solana/${address}$`));
  await expect(page.locator('[data-ui="vault-screen"]')).toHaveAttribute('data-pane', 'holdings');
  return address;
}

const cashOf = async (page: Page, address: string) => {
  const read = await (await page.request.get(`${STUB}/v1/vaults/solana/${address}`)).json();
  return {
    cash: Number(read.vault.cash.raw) / 1e6,
    value: Number(read.vault.valueUsd),
  };
};

test('a change to all SPY spends what its sale brings: no cash worth a trade is left', async ({
  page,
}) => {
  const address = await toVault(page, {
    targets: [
      { asset: 'solana:spy', weightBps: 6000 },
      { asset: 'solana:nvda', weightBps: 4000 },
    ],
  });
  // The stub has no model: the reply is answered here, as apps/api declares it.
  await page.route('**/conversation/reply', async (route) => {
    const asked = route.request().postDataJSON() as { messageId: string };
    await route.fulfill({
      json: {
        version: 1,
        chain: 'solana',
        address,
        messageId: asked.messageId,
        message: 'Here is all of it in SPY, to look at before anything changes.',
        question: null,
        proposal: {
          objective: 'All in SPY.',
          summary: 'A draft for discussion.',
          allocations: [
            {
              assetId: 'solana:spy',
              weightBps: 10_000,
              why: 'You asked for all of it there.',
              evidenceIds: ['exit'],
              symbol: 'SPY',
            },
          ],
          tradeoffs: ['The vault holds one fund.'],
          unknowns: [],
          sources: [
            {
              id: 'exit',
              source: 'e2e',
              fetchedAt: '2026-10-05T12:00:00.000Z',
              method: 'sample exit read',
              provenance: 'mock',
              label: 'Measured cost',
              value: 0,
              unit: 'bps',
            },
          ],
          warnings: [],
          weightNotes: [],
        },
      },
    });
  });
  await page.locator('[data-ui="vault-chat"] textarea').fill('all in SPY');
  await page.locator('[data-ui="composer-send"]').click();
  const proposal = page.locator('[data-ui="vault-proposal"]');
  await expect(proposal).toBeVisible();
  await proposal.getByRole('button', { name: en.mix.preview.apply }).click();
  await proposal.getByRole('button', { name: en.mix.vault.review }).click();
  await expect(page.locator('[data-ui="mix-review-lines"]')).toContainText('SPY');
  const boxes = page.locator('[data-ui="mix-review-warnings"] input[type="checkbox"]');
  for (let i = 0; i < (await boxes.count()); i += 1) await boxes.nth(i).check();
  await page.getByRole('button', { name: en.mix.vault.confirm }).click();
  const pane = page.locator('[data-ui="vault-action-pane"]');
  await pane.getByRole('button', { name: en.mix.order.signTargets }).click();
  await expect(pane).toHaveAttribute('data-state', 'done', { timeout: 90_000 });
  // $40 of NVDA sold at 1% slippage: the purchase spends the $39.60 it is sure of, and only what the
  // sale brought over that stays in cash. Counting the 1% twice left $0.79.
  const { cash } = await cashOf(page, address);
  expect(cash).toBeLessThan(0.45);
  await pane.getByRole('button', { name: p.backToVault }).click();
  // under one trade: on target, said once, and no Rebalance
  const screen = page.locator('[data-ui="vault-screen"]');
  await expect(screen.locator('[data-ui="vault-on-target"]')).toContainText(p.allOnTarget);
  await expect(screen.locator('[data-action="vault-rebalance"]')).toHaveCount(0);
});

test('idle cash worth a trade: "Off target", Rebalance on the page and in the chat, and one press spends it', async ({
  page,
}) => {
  // $1,000 in SPY alone, $10 of it left in cash: 1%, inside the band, worth a trade
  const address = await toVault(page, {
    targets: [{ asset: 'solana:spy', weightBps: 10_000 }],
    depositRaw: '1000000000',
    cashLeftRaw: '10000000',
  });
  const screen = page.locator('[data-ui="vault-screen"]');
  await expect(screen.locator('[data-ui="vault-on-target"]')).toContainText(p.offTargetShort);
  const press = screen.locator('[data-action="vault-rebalance"]');
  await expect(press).toHaveText(p.rebalance);
  await axe(page, 'off-target');

  // Asked in the chat, the reply hands over the same press (the API's own reply, answered here).
  await page.route('**/conversation/reply', async (route) => {
    const asked = route.request().postDataJSON() as { messageId: string };
    await route.fulfill({
      json: {
        version: 1,
        chain: 'solana',
        address,
        messageId: asked.messageId,
        message: `Your vault is off its targets. Use “${p.rebalance}” to bring it back: you review the trades and sign each step.`,
        question: null,
        proposal: null,
        action: 'rebalance',
      },
    });
  });
  await page.locator('[data-ui="vault-chat"] textarea').fill('i want to rebalance');
  await page.locator('[data-ui="composer-send"]').click();
  const handed = page.locator('[data-action="chat-rebalance"]');
  await expect(handed).toHaveText(p.rebalance);
  await axe(page, 'chat-rebalance');
  await handed.click();

  // The page's own pane, as its press opens: the purchase of the idle cash, signed there.
  await expect(screen).toHaveAttribute('data-pane', 'rebalance');
  const pane = page.locator('[data-ui="vault-action-pane"]');
  await pane.getByRole('button', { name: en.order.shared.signRebalance }).click();
  await expect(pane).toHaveAttribute('data-state', 'done', { timeout: 90_000 });
  const { cash } = await cashOf(page, address);
  expect(cash).toBeLessThan(0.01);
  await pane.getByRole('button', { name: p.backToVault }).click();
  await expect(screen.locator('[data-ui="vault-on-target"]')).toContainText(p.allOnTarget);
  await expect(press).toHaveCount(0);
});
