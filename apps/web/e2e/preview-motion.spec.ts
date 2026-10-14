import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { dictionary } from '../i18n';
import { inTheme } from './theme';

// The draft on /goal, drawn as a ring beside its rows (composition.md, Composition.tsx, gate
// WEIGHTS-RING): a segment and a row a holding, a row and its segment lighting each other, what the
// card shows while a reply is on its way, and that it fits a phone and a desk. The stub answers
// every turn with the same two picks, so each reply here is the stub's own with its allocations
// swapped for the mix under test. No model is called and nothing is bought.

const en = dictionary('en');
test.skip(process.env.E2E_CHAIN === 'robinhood', 'the stub runs Robinhood Chain');
const STUB = `http://localhost:${process.env.E2E_API_PORT ?? 3901}`;
/** Screenshots are taken only for a run that names a folder for them (SCREENSHOTS_DIR). */
const SHOTS = process.env.SCREENSHOTS_DIR;

type Mix = readonly (readonly [symbol: string, bps: number])[];
const SIX: Mix = [
  ['SPY', 1667],
  ['QQQ', 1667],
  ['NVDA', 1667],
  ['AAPL', 1667],
  ['Gold', 1666],
  ['USDC', 1666],
];
/** The next turn's: one piece grows, one shrinks, one leaves, one comes. */
const CHANGED: Mix = [
  ['SPY', 3000],
  ['QQQ', 1000],
  ['NVDA', 1667],
  ['Gold', 1666],
  ['USDC', 1667],
  ['TSLA', 1000],
];
const TWO: Mix = [
  ['SPY', 6000],
  ['Gold', 4000],
];
const MANY: Mix = [
  ['SPY', 2500],
  ['QQQ', 1500],
  ['NVDA', 1000],
  ['AAPL', 1000],
  ['MSFT', 800],
  ['TSLA', 700],
  ['AMZN', 600],
  ['META', 500],
  ['Gold', 500],
  ['COIN', 400],
  ['HOOD', 300],
  ['USDC', 200],
];

const idOf = (symbol: string) => `solana:${symbol.toLowerCase()}`;
const proposalOf = (mix: Mix) => ({
  objective: 'Sample: grow with a hedge',
  summary: 'Sample: a mix the spec made up, to see it drawn.',
  allocations: mix.map(([symbol, weightBps]) => ({
    assetId: idOf(symbol),
    weightBps,
    why: `Sample: a reason the spec made up for ${symbol}.`,
    evidenceIds: [`catalog:${idOf(symbol)}`],
    symbol,
  })),
  tradeoffs: ['Sample: every part of this can fall.'],
  unknowns: ['Sample: nothing here is measured.'],
  sources: mix.map(([symbol]) => ({
    id: `catalog:${idOf(symbol)}`,
    label: 'Listed on this chain',
    source: 'the e2e spec',
    method: 'sample: made up for the end-to-end spec',
    fetchedAt: '2026-10-05T12:00:00.000Z',
    provenance: 'mock',
  })),
});

async function axe(page: Page, name: string) {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(
    result.violations.flatMap((v) =>
      v.nodes.map((n) => `${v.id}: ${n.html.slice(0, 160)} ${n.failureSummary ?? ''}`),
    ),
    name,
  ).toEqual([]);
}

/** Answers the next turns with `mix`, each once `gate` lets it through. */
async function answerWith(page: Page, mix: Mix, gate: Promise<void> = Promise.resolve()) {
  await page.unroute('**/v1/conversations/*/goal/reply');
  await page.route('**/v1/conversations/*/goal/reply', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await gate;
    await route.fulfill({
      response,
      json: {
        ...body,
        proposal: proposalOf(mix),
        weightNotes: [{ code: 'equal_split', assetIds: mix.map(([symbol]) => idOf(symbol)) }],
      },
    });
  });
}

async function signIn(page: Page) {
  await page.request.post(`${STUB}/__stub/reset`);
  await page.goto('/goal');
  await page.locator('header a[href^="/sign-in"]').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: en.signIn.passkey.continue }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/goal$/);
}

async function say(page: Page, words: string) {
  const box = page.locator('textarea');
  await box.fill(words);
  await box.press('Enter');
}

const shareOf = (bps: number) =>
  new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 2 }).format(
    bps / 10_000,
  );
/** Every row's holding and share, as the card shows them now. */
const shownShares = (page: Page) =>
  page
    .locator('[data-ui="goal-strategy"] [data-ui="composition-list"] [data-row]')
    .evaluateAll((rows) =>
      rows.map((row) => [
        row.getAttribute('data-row'),
        row.querySelector('[data-ui="composition-share"]')?.textContent,
      ]),
    );
/** The strip's segments: which holding, its colour and its opacity, in the order drawn. */
const segmentsOf = (page: Page) =>
  page.locator('[data-ui="goal-strategy"] [data-ui="composition-segment"]').evaluateAll((els) =>
    els.map((el) => ({
      key: el.getAttribute('data-key'),
      colour: getComputedStyle(el).backgroundColor,
      opacity: getComputedStyle(el).opacity,
    })),
  );

test('a draft arrives as a strip over its table, and the next one takes its place', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  const strategy = page.locator('[data-ui="goal-strategy"]');
  const ring = strategy.locator('[data-ui="composition-strip"]');

  // while the first reply is on its way the card says it is being worked on
  let release = () => {};
  await answerWith(page, SIX, new Promise<void>((done) => (release = done)));
  await say(page, 'Technology stocks, with some gold and cash');
  await expect(strategy.locator('[data-ui="draft-building"] h2')).toHaveText(
    en.goal.explore.building,
  );
  release();

  // six holdings: a segment and a row each, the exact share in every row
  await expect(strategy.locator('[data-ui="composition-segment"]')).toHaveCount(6);
  const final = SIX.map(([symbol, bps]) => [idOf(symbol), shareOf(bps)]);
  expect(await shownShares(page)).toEqual(final);
  // the colours follow the holdings' order: five of the share palette, and cash in its neutral
  const drawn = await segmentsOf(page);
  expect(drawn.map((s) => s.key)).toEqual(SIX.map(([symbol]) => idOf(symbol)));
  expect(new Set(drawn.map((s) => s.colour)).size).toBe(6);
  // a row's weight bar is its segment's colour
  const bars = await strategy
    .locator('[data-part="weight-bar"] > span')
    .evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor));
  expect(bars).toEqual(drawn.map((s) => s.colour));
  // nothing moves in: every figure is the draft's own from the first frame
  expect(await ring.evaluate((el) => el.getAnimations({ subtree: true }).length)).toBe(0);
  await expect(strategy.getByRole('button', { name: en.mix.preview.deposit })).toBeEnabled();

  // the strip is one picture with the whole draft in words, and no control in it
  await expect(strategy.locator('[role="img"]:has([data-ui="composition-strip"])')).toHaveAttribute(
    'aria-label',
    en.shared.composition.summary(
      SIX.map(([symbol, bps]) => `${symbol} ${shareOf(bps)}`).join(', '),
    ),
  );
  await expect(ring.locator('button, a, [tabindex]')).toHaveCount(0);
  // pointing at a row lights its segment and dims the others
  const row = strategy.locator('[data-ui="composition-list"] [data-row]').nth(1);
  await row.hover();
  await expect(row).toHaveAttribute('data-lit', 'true');
  // the others ease to 30% over 160ms
  await expect
    .poll(async () => (await segmentsOf(page)).map((s) => s.opacity))
    .toEqual(['0.3', '1', '0.3', '0.3', '0.3', '0.3']);
  // and the keyboard does what the pointer does
  await page.mouse.move(0, 0);
  await row.locator('button').focus();
  await expect(row).toHaveAttribute('data-lit', 'true');
  await row.locator('button').blur();
  await expect(row).not.toHaveAttribute('data-lit', 'true');

  // the next turn: the draft stays, marked as the one from before, and cannot be used meanwhile
  await answerWith(page, CHANGED, new Promise<void>((done) => (release = done)));
  await say(page, 'More of the broad fund, and swap one stock');
  await expect(strategy.locator('[data-ui="preview-pending"]')).toHaveText(
    en.shared.vault.conversation.reworking,
  );
  await expect(strategy.locator('[data-action="deposit"]')).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await expect(strategy.locator('[data-action="deposit"]')).toContainText(
    en.shared.vault.conversation.waitingAction,
  );
  expect(await shownShares(page)).toEqual(final);
  // nothing is dimmed while it waits: the ring keeps its colours
  await expect.poll(() => segmentsOf(page)).toEqual(drawn);
  // a wait can be long: every word and figure on the waiting card stays readable, in both themes
  for (const theme of ['light', 'dark'] as const) {
    await inTheme(page, theme);
    await axe(page, `pending, ${theme}`);
  }
  release();
  await expect(strategy.locator('[data-ui="preview-pending"]')).toHaveText('');
  expect(await shownShares(page)).toEqual(
    CHANGED.map(([symbol, bps]) => [idOf(symbol), shareOf(bps)]),
  );
  await expect(strategy.locator('[data-ui="composition-segment"]')).toHaveCount(CHANGED.length);
  await expect(strategy.getByRole('button', { name: en.mix.preview.deposit })).toBeEnabled();
});

test('with reduced motion nothing eases: a lit row dims the others at once', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  const strategy = page.locator('[data-ui="goal-strategy"]');
  let release = () => {};
  await answerWith(page, SIX, new Promise<void>((done) => (release = done)));
  await say(page, 'Technology stocks, with some gold and cash');
  await expect(page.locator('[data-ui="draft-building"]')).toBeVisible();
  release();
  await expect(strategy.locator('[data-ui="composition-segment"]')).toHaveCount(6);
  const eased = await strategy
    .locator('[data-ui="composition-segment"]')
    .evaluateAll((els) => els.map((el) => getComputedStyle(el).transitionProperty));
  expect(new Set(eased)).toEqual(new Set(['none']));
  await strategy.locator('[data-ui="composition-list"] [data-row]').first().hover();
  expect((await segmentsOf(page)).map((s) => s.opacity)).toEqual([
    '1',
    '0.3',
    '0.3',
    '0.3',
    '0.3',
    '0.3',
  ]);
});

for (const [name, mix] of [
  ['two', TWO],
  ['six', SIX],
  ['twelve', MANY],
] as const)
  test(`a draft of ${name} holdings fits a phone and a desk`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await signIn(page);
    const strategy = page.locator('[data-ui="goal-strategy"]');
    const ring = strategy.locator('[data-ui="composition-strip"]');
    await answerWith(page, mix);
    await say(page, 'A draft to look at');
    // a segment a holding, however many, and every holding a row with its exact share
    await expect(strategy.locator('[data-ui="composition-segment"]')).toHaveCount(mix.length);
    expect(await shownShares(page)).toEqual(
      mix.map(([symbol, bps]) => [idOf(symbol), shareOf(bps)]),
    );
    for (const theme of ['dark', 'light'] as const) {
      await inTheme(page, theme);
      for (const width of [375, 1440]) {
        await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
        const wide = await page.evaluate(() => document.documentElement.scrollWidth);
        expect(wide, `${theme}, ${width}px: no sideways scroll`).toBeLessThanOrEqual(width);
        // every segment lies inside the strip, and can be seen
        const box = await ring.boundingBox();
        const parts = await strategy
          .locator('[data-ui="composition-segment"]')
          .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON()));
        for (const part of parts) {
          expect(part.left).toBeGreaterThanOrEqual((box?.x ?? 0) - 0.5);
          expect(part.right).toBeLessThanOrEqual((box?.x ?? 0) + (box?.width ?? 0) + 0.5);
          expect(Math.max(part.width, part.height)).toBeGreaterThanOrEqual(4);
        }
        if (SHOTS) {
          // a window tall enough for the whole card: the pane scrolls on a desk
          await page.setViewportSize({ width, height: 2400 });
          await strategy
            .locator('[data-ui="card"]')
            .screenshot({ path: `${SHOTS}/card-${name}-${width}-${theme}.png` });
        }
      }
      await page.setViewportSize({ width: 375, height: 812 });
      await page.mouse.move(0, 0);
      await axe(page, theme);
    }
  });
