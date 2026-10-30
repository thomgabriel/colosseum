import { expect, test } from '@playwright/test';
import { dictionary } from '../i18n';

// The faucet at the top of /invest's deposit card (gate FAUCET-TOP), end to end against the stub dressed
// as a test network: there before any amount, one press fills the wallet, and the funds step lower on
// the card has no second button. Screenshots are taken only for a run that names a folder for them.

const en = dictionary('en');
test.skip(process.env.E2E_CHAIN === 'robinhood', 'the stub runs Robinhood Chain');
const STUB = `http://localhost:${process.env.E2E_API_PORT ?? 3901}`;
const SHOTS = process.env.SCREENSHOTS_DIR;

test('a new person gets test funds from the top of the deposit card, before typing an amount', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.request.post(`${STUB}/__stub/reset`);
  await page.request.post(`${STUB}/__stub/test-network`);
  await page.goto('/invest');
  await page.locator('header a[href^="/sign-in"]').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: en.signIn.passkey.continue }).click();
  await expect(dialog).toHaveCount(0);

  const box = page.locator('textarea');
  await box.fill('A broad fund and some gold, to grow, at medium risk');
  await box.press('Enter');
  const strategy = page.locator('[data-ui="goal-strategy"]');
  await expect(strategy.locator('[data-ui="weight-notes"]')).toBeVisible();
  await strategy.getByRole('button', { name: en.mix.preview.deposit, exact: true }).click();

  const step = page.locator('[data-ui="deposit-step"]');
  const top = step.locator('[data-ui="test-funds-top"]');
  const ask = top.getByRole('button', { name: en.buy.funding.testFundsUpTo('$10,000') });
  await expect(ask).toBeVisible();
  await expect(step).not.toContainText('From $1 to $1,000,000');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/faucet-top-before.png`, fullPage: true });

  await ask.click();
  await expect(top.locator('[data-ui="test-funds-sent"]')).toBeVisible();
  await expect(step.locator('[data-ui="amount-well"]')).not.toContainText('0.00');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/faucet-top-sent.png`, fullPage: true });

  // with an amount over what arrived, the funds step says what is missing, and no second faucet
  await page.getByLabel(en.amount.field.deposit, { exact: true }).fill('50000');
  await expect(step.locator('[data-ui="deposit-check"]')).toHaveText(en.mix.deposit.checked);
  const warnings = step.locator('[data-ui="warnings-ack"]');
  if ((await warnings.count()) > 0) await warnings.check();
  const card = step.locator('[data-ui="invest-card"]');
  await expect(card.locator('[data-ui="funding-step"]')).toBeVisible({ timeout: 30_000 });
  await expect(card.getByRole('button', { name: en.buy.funding.testFunds })).toHaveCount(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/faucet-top-short.png`, fullPage: true });
});
