import { expect, type Page } from '@playwright/test';
import { dictionary } from '../i18n';

// The invest card as a person takes it (InvestCard, gate INVEST-ONE-PRESS): the amount (left as it
// is, or `amount`), the funds, which the card shows because the wallet starts short (MOCK cash from
// the stub, or test funds where the stub says it can send them), and the trust notice ticked (every
// e2e buy is a first one). It ends with the order on the card, every step to read, and its one
// button ready to press: nothing has been signed.

const en = dictionary('en');
const STUB = `http://localhost:${process.env.E2E_API_PORT ?? 3901}`;

export async function readyToInvest(
  page: Page,
  o: { amount?: string; fund?: 'mock' | 'test'; dollars?: string } = {},
) {
  // Where the deposit starts on the amount card (gate AMOUNT-CARD): the amount there, the trust
  // notice ticked on it (a first deposit in this browser), and its press, which hands the amount to
  // the invest card. A plan's own buy page still types it over the invest card.
  const entry = page.locator('[data-ui="amount-panel"]');
  let trusted = false;
  if (o.amount !== undefined && (await entry.count()) > 0) {
    await entry.getByLabel(en.amount.field.deposit, { exact: true }).fill(o.amount);
    const press = entry.locator('[data-action="amount-deposit"]');
    await expect(press).toHaveAttribute('aria-disabled', 'true');
    await entry.getByLabel(en.trust.accept).check();
    await expect(press).toHaveText(en.amount.press.deposit(o.dollars ?? '$40'));
    await press.click();
    trusted = true;
  } else if (o.amount !== undefined)
    await page.getByLabel(en.buy.amount.label, { exact: true }).fill(o.amount);
  const card = page.locator('[data-ui="invest-card"]');
  const press = card.getByRole('button', { name: en.invest.press(o.dollars ?? '$40') });
  // the wallet is short: the card says what is missing, offers the way to fill it, and no order
  await expect(card.locator('[data-ui="funding-step"]')).toBeVisible();
  await expect(card.locator('[data-ui="order-step"]')).toHaveCount(0);
  await expect(press).toHaveAttribute('aria-disabled', 'true');
  await card
    .getByRole('button', {
      name: o.fund === 'test' ? en.buy.funding.testFunds : en.buy.funding.mockFund,
    })
    .click();
  // the wallet holds it now: the funds leave the card, and the order is there with its steps
  await expect(card.locator('[data-ui="order-step"]').first()).toBeVisible({ timeout: 30_000 });
  // test funds that were sent are still said; sample cash on the mock leaves nothing to say
  if (o.fund === 'test') await expect(card.locator('[data-ui="test-funds-sent"]')).toBeVisible();
  else await expect(card.locator('[data-ui="funding-step"]')).toHaveCount(0);
  // a first buy in this browser: the notice is on the card, and holds the press until it is ticked;
  // ticked on the amount card, it was kept as that card was pressed, and is not asked again
  if (!trusted) {
    await expect(press).toHaveAttribute('aria-disabled', 'true');
    await page.getByLabel(en.trust.accept).check();
  } else await expect(page.getByLabel(en.trust.accept)).toHaveCount(0);
  await expect(press).not.toHaveAttribute('aria-disabled', 'true');
  return press;
}

/**
 * To a plan's own page by its link, as the portfolio's "See the plan" or an agent's link leads there:
 * the stub stores a $40 plan to grow over three years as the person's own
 * (`POST /v1/baskets/personalize`), on the chain it runs, and the page reads it back by its id. The
 * link is opened through sign-in, because a page load gives the throwaway wallet new keys. `tail`
 * opens the plan's buy page instead.
 */
export async function openPlan(page: Page, tail: '' | '/buy' = '') {
  const made = await page.request.post(`${STUB}/v1/baskets/personalize`, {
    data: {
      sheet: {
        basketType: 'standard',
        goal: 'grow',
        amountUsd: 40,
        horizonMonths: 36,
        risk: 'medium',
        themes: [],
        country: 'BR',
        chains: [process.env.E2E_CHAIN ?? 'solana'],
        rules: { useHoldings: false, glide: true },
        language: 'en',
      },
    },
  });
  expect(made.status()).toBe(200);
  const { id } = (await made.json()) as { id: string };
  await page.goto(`/sign-in?next=${encodeURIComponent(`/invest/plan/${id}${tail}`)}`);
  await page.getByRole('button', { name: en.signIn.passkey.continue }).click();
  await expect(page).toHaveURL(tail ? /\/invest\/plan\/[^/]+\/buy$/ : /\/invest\/plan\/[^/]+$/);
}

/**
 * The amount card at 1440x900 (Thom, Oct 13: "not sure i needed to scroll"): with the card's top in
 * the window, its one button is in the window too, the amount over it. `scroll`: the card sits under
 * other content on its page (a portfolio's plan), so it is brought to the top first; in a vault's pane
 * nothing is scrolled.
 */
export async function pressInView(page: Page, name: string, o: { scroll?: boolean } = {}) {
  const before = page.viewportSize();
  await page.setViewportSize({ width: 1440, height: 900 });
  const card = page.locator('[data-ui="amount-panel"]').first();
  if (o.scroll)
    await card.evaluate((el) => el.scrollIntoView({ block: 'start', behavior: 'instant' }));
  const amount = card.locator('[data-ui="amount-well"] input');
  const press = card.locator('button[data-action^="amount-"]');
  for (const [what, el] of [
    ['amount', amount],
    ['button', press],
  ] as const) {
    const box = await el.boundingBox();
    expect(box, `${name}: ${what} drawn`).not.toBeNull();
    if (!box) continue;
    // and not cut by a pane that scrolls on its own (the vault page's workbench)
    const clip = await el.evaluate((node) => {
      let bottom = window.innerHeight;
      for (let up = node.parentElement; up; up = up.parentElement) {
        const { overflowY } = getComputedStyle(up);
        if (overflowY !== 'visible') bottom = Math.min(bottom, up.getBoundingClientRect().bottom);
      }
      return bottom;
    });
    expect(box.y + box.height, `${name}: ${what} not cut by its pane`).toBeLessThanOrEqual(clip);
    expect(box.y, `${name}: ${what} below the window's top`).toBeGreaterThanOrEqual(0);
    expect(
      box.y + box.height,
      `${name}: ${what} above the window's foot, with no scroll`,
    ).toBeLessThanOrEqual(900);
  }
  if (before) await page.setViewportSize(before);
}
