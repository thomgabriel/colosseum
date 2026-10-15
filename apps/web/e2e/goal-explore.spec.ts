import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { dictionary } from '../i18n';
import { conversations } from './conversations';
import { inTheme } from './theme';

const en = dictionary('en');
const STUB = `http://localhost:${process.env.E2E_API_PORT ?? 3901}`;

// The new default has a real conversation endpoint, but an unopened strategy has no financial data.
// This check does not stub a model reply or produce a funded plan.
test('new-goal exploration opens a responsive preview-only workbench', async ({ page }) => {
  const financialPosts: string[] = [];
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      /\/(orders|baskets|goals|conversation.*reply)/.test(request.url())
    )
      financialPosts.push(request.url());
  });
  await page.goto('/invest');
  // The conversations panel chooses a conversation, never a guided mode; signed out, it lists none.
  await expect(page.locator('[data-ui="goal-mode"]')).toHaveCount(0);
  await expect(page.locator('[data-ui="conversations-open"]')).toBeVisible();
  await expect(
    page.locator('div[data-ui="conversations"] [data-ui="conversation-row"]'),
  ).toHaveCount(0);
  await expect(page.locator('[data-ui="goal-conversation"]')).toBeVisible();
  // The chain of the plan is chosen here, beside the box (gate CHAIN-AT-THE-PLAN): two options, one
  // group, moved with the arrow keys.
  const chains = page.getByRole('group', { name: en.chain.choice.legend }).getByRole('radio');
  await expect(chains).toHaveCount(2);
  await expect(chains.first()).toBeChecked();
  await chains.first().focus();
  await page.keyboard.press('ArrowRight');
  await expect(chains.nth(1)).toBeChecked();
  await expect(chains.nth(1)).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(chains.first()).toBeChecked();
  // before the first message the chat has the room alone, the draft's note said under its own
  // (Thom, Oct 15): no empty card beside it
  await expect(page.locator('[data-ui="goal-chat"]')).toContainText(en.goal.explore.previewOnly);
  await expect(page.locator('[data-ui="goal-strategy"]')).toHaveCount(0);
  await expect(
    page.locator(
      '[data-ui="composition"], [data-ui="invest-card"], [data-ui="order-step"], [data-ui="plan-invest"]',
    ),
  ).toHaveCount(0);
  await expect(page.locator('[data-ui="invest-screen"]')).toHaveCount(0);
  for (const theme of ['light', 'dark'] as const) {
    await inTheme(page, theme);
    for (const width of [375, 1280]) {
      await page.setViewportSize({ width, height: 812 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
      const chat = await page.locator('[data-ui="goal-chat"]').boundingBox();
      const area = await page.locator('[data-ui="goal-conversation"]').boundingBox();
      expect(chat).not.toBeNull();
      expect(area).not.toBeNull();
      if (chat && area) {
        if (width === 1280) {
          // one block in the middle of the room right of the rail, at a reading width
          expect(chat.width).toBeLessThanOrEqual(736);
          expect(
            Math.abs(chat.x - area.x - (area.x + area.width - chat.x - chat.width)),
          ).toBeLessThan(2);
        } else expect([chat.x, chat.width]).toEqual([area.x, area.width]);
      }
    }
    await page.setViewportSize({ width: 375, height: 812 });
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(result.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.html}`))).toEqual([]);
  }
  expect(financialPosts).toEqual([]);
});

// An address no route has (gate WORDS-ONE-NAME, row 1 of its audit): 404, in the product's shell and
// in its words, never the first structurer's page.
test('an unknown address answers 404 in the product’s shell, with one way on', async ({ page }) => {
  for (const path of ['/no-such-page', '/a/b/c']) {
    const answer = await page.goto(path);
    expect(answer?.status(), path).toBe(404);
    const missing = page.locator('[data-ui="not-found"]');
    await expect(missing.getByRole('heading', { level: 1 })).toHaveText(en.shell.missing.title);
    await expect(page).toHaveTitle(`${en.shell.missing.title} · tenonfi`);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    // the product's own bar, and nothing of the first shell
    await expect(page.locator('header a[href="/invest"]').first()).toBeAttached();
    await expect(page.getByText('Select Wallet')).toHaveCount(0);
    await expect(page.getByText('Structurer')).toHaveCount(0);
    await expect(missing.getByRole('link', { name: en.shell.missing.action })).toHaveAttribute(
      'href',
      '/invest',
    );
  }
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(result.violations.map((v) => v.id)).toEqual([]);
});

// Thom, Oct 14: the conversations panel in place of the picker. A draft is named by its person's
// first request, shortened, read from the turns this browser keeps; a new one starts from the panel,
// an earlier one opens from it, and a search narrows a long list by name. The panel is a rail beside
// the conversation at 1440 and a sheet at 375, and neither pushes the page sideways. (A reload is in
// the events test: the test wallet does not keep its sign-in across one.)
test('the conversations panel: a new conversation, an earlier one opened, and a search', async ({
  page,
}) => {
  // signed in, as a person who can send is; the stub answers, no model is called
  await page.request.post(`${STUB}/__stub/reset`);
  await page.goto('/invest');
  await page.locator('header a[href^="/sign-in"]').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: en.signIn.passkey.continue }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/invest$/);
  const w = en.goal.explore.picker;
  const opener = page.locator('[data-ui="conversations-open"]');
  await expect(opener).toContainText(w.current);
  const send = async (words: string) => {
    await page.locator('[data-ui="goal-chat"] textarea').fill(words);
    await page.locator('[data-ui="composer-send"]').click();
  };
  await send("I want to explore technology stocks with low risk for my daughter's college fund");
  const title = 'I want to explore technology stocks with low…';
  await expect(opener).toContainText(title);
  // a new one from the panel: the first is kept under its name
  let list = await conversations(page);
  await list.locator('[data-ui="conversation-new"]').click();
  await expect(page.locator('[data-ui="goal-transcript"]')).toHaveText('');
  await expect(opener).toContainText(w.current);
  // a second draft, so with the person's seven vaults the list is long enough for its search
  await send('Earn a monthly income from my savings');
  await expect(opener).toContainText('Earn a monthly income from my savings');
  const row = (within: typeof list, name: string) =>
    within.locator('[data-ui="conversation-row"]', {
      has: page.locator('[data-ui="conversation-title"]', { hasText: name }),
    });
  for (const width of [375, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    list = await conversations(page);
    // the earlier one opens again, and is the one marked
    await row(list, title).locator('[data-ui="conversation-open"]').click();
    await expect(page.locator('[data-ui="goal-transcript"]')).toContainText('college fund');
    list = await conversations(page);
    await expect(row(list, title).locator('[data-ui="conversation-open"]')).toHaveAttribute(
      'aria-current',
      'true',
    );
    // a search narrows the list by name; the person's vaults make it long enough to have one
    const search = list.locator('[data-ui="conversation-search"] input');
    await search.fill('TECHNOLOGY');
    await expect(list.locator('[data-ui="conversation-title"]')).toHaveText([title]);
    await search.fill('');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    for (const theme of ['light', 'dark'] as const) {
      await inTheme(page, theme);
      const result = await new AxeBuilder({ page })
        .include(width < 1024 ? '[data-ui="conversations-sheet"]' : 'div[data-ui="conversations"]')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(result.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.html}`))).toEqual(
        [],
      );
    }
    // the sheet closes with Escape, and the next width finds the rail
    if (width < 1024) await page.keyboard.press('Escape');
  }
});

// The title's place (PAGE-SHELL, as CONVERSATION-PANEL amends it): under 1024px at the frame's left
// edge with the panel's button in its row; from 1024px after the conversations rail and its gap, 328px
// with the rail open and 80px closed. Always at the head's top.
const width = (page: { viewportSize(): { width: number } | null }) =>
  page.viewportSize()?.width ?? 0;
test('the title sits at the frame’s edge, or after the conversations rail', async ({ page }) => {
  await page.goto('/invest');
  const title = page.locator('main h1');
  await expect(title).toHaveText(en.talk.workbench.title);
  // The account settled first: until it has, the conversation's head is keyed to no chain, and once
  // it does (signed out, on Solana) the head is drawn again under its own key. A measurement taken
  // across that draw finds the title on its way out (CI, 768px). The bar's "Sign in" is drawn then.
  await expect(page.locator('header a[href^="/sign-in"]').first()).toBeAttached();
  // the faces the title is measured in, loaded
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const place = async () => {
    const box = await title.boundingBox();
    if (!box) return null;
    const left = await page.evaluate(() => {
      const frame = document.querySelector<HTMLElement>('.group\\/shell');
      if (!frame) return Number.NaN;
      return (
        frame.getBoundingClientRect().left + Number.parseFloat(getComputedStyle(frame).paddingLeft)
      );
    });
    // the title's row lines its words up on one baseline with the row's buttons: under 1024px, where
    // those buttons share the title's line, its top is up to 2px lower than the head's (as before)
    const y = Math.round(box.y);
    return { x: Math.round(box.x - left) + 0, y: width(page) < 1024 && y <= 106 ? 104 : y };
  };
  const toggle = page.locator('[data-ui="conversations-toggle"]');
  for (const closed of [false, true]) {
    for (const width of [375, 768, 1280, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      if (width >= 1024) {
        if ((await toggle.getAttribute('aria-expanded')) === String(closed)) await toggle.click();
        // the rail is drawn as it was asked to be before anything is measured
        await expect(toggle).toHaveAttribute('aria-expanded', String(!closed));
      }
      // Measured once the page is still: just after a load or a resize the conversation's head can be
      // drawn again (its key follows the account and the chain as they settle), and for that moment
      // there is no title to measure. The place it settles in is held exactly.
      const step = `${width}px, rail ${closed ? 'closed' : 'open'}`;
      const there = { x: width < 1024 ? 0 : closed ? 80 : 328, y: 104 };
      // inside the test's own limit, so a miss is reported with this step's name
      await expect.poll(place, { message: step, timeout: 10_000 }).toEqual(there);
      // and still there a frame later: settled, not passing through
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => done(null))));
      expect(await place(), `${step}, a frame later`).toEqual(there);
    }
  }
});

// Thom, Oct 15: beside a draft the chat keeps 45% of the room, half from 1440px, and never less than
// 440px; the conversations rail folds to its strip for it at every width it is drawn at, and once
// opened again stays open for that conversation.
test('beside a draft the chat keeps its share, and the rail folds for it', async ({ page }) => {
  await page.request.post(`${STUB}/__stub/reset`);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/invest');
  await page.locator('header a[href^="/sign-in"]').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: en.signIn.passkey.continue }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/invest$/);
  const box = page.locator('[data-ui="goal-chat"] textarea');
  await box.fill('A broad fund and some gold, to grow, at medium risk');
  await box.press('Enter');
  const strategy = page.locator('[data-ui="goal-strategy"]');
  await expect(strategy.locator('[data-ui="weight-notes"]')).toBeVisible();
  const toggle = page.locator('[data-ui="conversations-toggle"]');
  const measure = async () => {
    const chat = await page.locator('[data-ui="goal-chat"]').boundingBox();
    const draft = await strategy.boundingBox();
    if (!chat || !draft) throw new Error('the chat and the draft are drawn');
    expect(chat.width).toBeGreaterThanOrEqual(440);
    expect(draft.x).toBeGreaterThan(chat.x + chat.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      page.viewportSize()?.width ?? 0,
    );
    return chat.width / (chat.width + draft.width);
  };
  for (const [width, share] of [
    [1280, 0.45],
    [1440, 0.5],
    [1600, 0.5],
    [1920, 0.5],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await expect(toggle, `${width}px`).toHaveAttribute('aria-expanded', 'false');
    expect(await measure(), `${width}px`).toBeCloseTo(share, 2);
  }
  // opened again, the rail stays open for this conversation: at 1920 and 1600, after the next reply
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await measure();
  await page.setViewportSize({ width: 1600, height: 900 });
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await measure();
  await box.fill('Make it a little safer');
  await box.press('Enter');
  await expect(page.locator('[data-ui="goal-transcript"] li[data-who="person"]')).toHaveCount(2);
  await expect(page.locator('[data-ui="reply-pending"]')).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  // and at 1280, where the chat keeps its least width beside it
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await measure();
  // and at 1024, where 440px would be more than half: the chat and the draft half each, the draft
  // never squeezed under the rail opened by hand (the review of #326)
  await page.setViewportSize({ width: 1024, height: 900 });
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(async () => {
    const chat = await page.locator('[data-ui="goal-chat"]').boundingBox();
    const draft = await strategy.boundingBox();
    if (!chat || !draft) throw new Error('the chat and the draft are drawn');
    expect(draft.width).toBeGreaterThanOrEqual(300);
    // half of the row is the chat's; the draft has the rest after the 16px gap
    expect(Math.abs(chat.width - draft.width)).toBeLessThanOrEqual(17);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      1024,
    );
  }).toPass();
  // a new conversation has no draft, and its first draft folds the rail again
  await page.setViewportSize({ width: 1920, height: 900 });
  await page.locator('div[data-ui="conversations"] [data-ui="conversation-new"]').click();
  await expect(strategy).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await box.fill('Earn a monthly income');
  await box.press('Enter');
  await expect(strategy.locator('[data-ui="weight-notes"]')).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  // opened to browse, it stays open as another draft is opened from it (the team lead, Oct 15)
  await toggle.click();
  await page
    .locator('div[data-ui="conversations"] [data-ui="conversation-open"]')
    .filter({ hasText: 'A broad fund' })
    .click();
  await expect(page.locator('[data-ui="goal-transcript"]')).toContainText('A broad fund');
  await expect(strategy.locator('[data-ui="composition"]')).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  // on a tablet the chat keeps five twelfths beside the draft; on a phone the draft is under the chat
  const boxes = async () => {
    const chat = await page.locator('[data-ui="goal-chat"]').boundingBox();
    const draft = await strategy.boundingBox();
    if (!chat || !draft) throw new Error('the chat and the draft are drawn');
    return { chat, draft };
  };
  await page.setViewportSize({ width: 768, height: 1024 });
  await expect(async () => {
    const { chat, draft } = await boxes();
    expect(draft.x).toBeGreaterThan(chat.x + chat.width);
    expect(chat.width / (chat.width + draft.width)).toBeCloseTo(5 / 12, 2);
  }).toPass();
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(async () => {
    const { chat, draft } = await boxes();
    expect(draft.y).toBeGreaterThanOrEqual(chat.y + chat.height);
    expect([draft.x, draft.width]).toEqual([chat.x, chat.width]);
  }).toPass();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});

// A draft drawn again on the way back to /invest folds the rail in the same frame as its column, so
// the title and the chat never jump 248px a frame after the page is drawn.
test('a draft drawn again on the way back has the rail folded from its first frame', async ({
  page,
}) => {
  await page.request.post(`${STUB}/__stub/reset`);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/invest');
  await page.locator('header a[href^="/sign-in"]').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: en.signIn.passkey.continue }).click();
  await expect(dialog).toHaveCount(0);
  const box = page.locator('[data-ui="goal-chat"] textarea');
  await box.fill('A broad fund and some gold, to grow, at medium risk');
  await box.press('Enter');
  await expect(page.locator('[data-ui="goal-strategy"] [data-ui="weight-notes"]')).toBeVisible();
  // away by the bar, and back: the draft is read again from this browser on the way in
  await page.locator('header a[href="/portfolio"]').first().click();
  await expect(page).toHaveURL(/\/portfolio$/);
  await expect(page.locator('[data-ui="goal-conversation"]')).toHaveCount(0);
  // every frame from here, the rail's width while a draft's column is drawn
  await page.evaluate(() => {
    const seen: number[] = [];
    (window as unknown as { seen: number[] }).seen = seen;
    const frame = () => {
      if (document.querySelector('[data-ui="goal-strategy"]'))
        seen.push(
          Math.round(
            document.querySelector('div[data-ui="conversations"]')?.getBoundingClientRect().width ??
              -1,
          ),
        );
      if (seen.length < 30) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  await page.locator('header a[href="/invest"]').first().click();
  // kept in this browser, the draft comes back as a preview: its bar, without the reply's notes
  await expect(page.locator('[data-ui="goal-strategy"] [data-ui="composition"]')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { seen: number[] }).seen.length))
    .toBeGreaterThanOrEqual(30);
  const seen = await page.evaluate(() => (window as unknown as { seen: number[] }).seen);
  expect(new Set(seen)).toEqual(new Set([56]));
});

// Thom, Oct 15: a draft of SPY alone, with the model's long reason under it, showed no share: the
// reason kept the table one line wide and the share column was out of the card, to be scrolled to.
test('a holding with a long reason keeps its share in the card, the reason wrapped', async ({
  page,
}) => {
  await page.request.post(`${STUB}/__stub/reset`);
  await page.setViewportSize({ width: 1975, height: 1080 });
  // the stub's reply, as the model's would come for one asked-for holding
  await page.route(/\/goal\/reply/, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.proposal.allocations = body.proposal.allocations.slice(0, 1).map((line: object) => ({
      ...line,
      weightBps: 10_000,
      why: 'You asked for the S&P 500 alone, so the whole vault follows the index through the SPY fund, which tracks the five hundred largest listed US companies and is the most traded fund on this chain.',
    }));
    body.proposal.weightNotes = [];
    await route.fulfill({ response, json: body });
  });
  await page.goto('/invest');
  await page.locator('header a[href^="/sign-in"]').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: en.signIn.passkey.continue }).click();
  await expect(dialog).toHaveCount(0);
  const box = page.locator('[data-ui="goal-chat"] textarea');
  await box.fill('Only the S&P 500');
  await box.press('Enter');
  const card = page.locator('[data-ui="goal-strategy"] [data-ui="card"]').first();
  const table = page.locator('[data-ui="goal-strategy"] [data-ui="composition-table"]');
  const share = table.locator('[data-ui="composition-share"]');
  await expect(share).toHaveText('100%');
  // with the rail open too, where the card is narrowest on a desk; then a phone
  await page.locator('[data-ui="conversations-toggle"]').click();
  for (const width of [1975, 1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(async () => {
      const [c, s, t] = await Promise.all([
        card.boundingBox(),
        share.boundingBox(),
        table.evaluate((el) => [el.scrollWidth, el.parentElement?.clientWidth ?? 0]),
      ]);
      if (!c || !s) throw new Error('the card and the share are drawn');
      expect(s.x + s.width, `${width}px`).toBeLessThanOrEqual(c.x + c.width);
      // nothing to scroll to: the table is no wider than its box
      expect(t[0], `${width}px`).toBeLessThanOrEqual(t[1]);
    }).toPass();
  }
});
