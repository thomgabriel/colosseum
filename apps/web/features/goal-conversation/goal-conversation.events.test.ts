// @vitest-environment happy-dom
import { act, createElement, StrictMode, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, press, settle, type, unmountAll } from '../../components/ui/test/dom';
import { dictionary } from '../../i18n';
import { withAccount } from '../account/test/screen';
import { GOAL_HANDOFF, GOAL_HANDOFF_OWNER } from '../goal/draft';
import { CHECK_MS } from '../mix/DepositStep';
import { REPLY_LINE_MS } from '../shared/ReplyPending';
import { sourceValue } from '../vault-conversation/StrategyPreview';
import { preview } from '../vault-conversation/test/fixtures';
import { fakePort, json, PHANTOM, signedInPort } from '../wallet/test/fake-port';
import { router } from '../wallet/test/mock-next';
import { portStore } from '../wallet/test/mock-provider';
import { GoalConversation, goalConversationKey } from './GoalConversation';
import { GoalHome } from './GoalHome';
import { current, open, openNew, rail, row, titles, unfold } from './test/rail';

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));
const userId = 'did:privy:test';
const en = dictionary('en');
const path = '/v1/conversations/solana/goal/reply';
const calls: { path: string; body: Record<string, unknown> }[] = [];
const response = (messageId: string) => ({
  version: 1,
  chain: 'solana',
  messageId,
  message: 'Here is a private preview.',
  question: null,
  proposal: preview,
});
const person = {
  userId,
  wallets: PHANTOM,
  chain: 'solana',
  chainSource: 'wallet',
  chainOptions: [],
};
const baseApi = async (url: string) => (url === '/v1/me' ? json(person) : json({}, 404));
const send = async (host: HTMLElement, words: string) => {
  await type(find<HTMLTextAreaElement>(host, 'textarea'), words);
  await click(find(host, '[data-ui="composer-send"]'));
  await settle();
};
const show = (lang: 'en' | 'pt' = 'en') => mount(withAccount(lang, createElement(GoalHome)));
/**
 * What a button says now, to the eye and to a reader. One that can wait keeps both of its labels in
 * one place, so its width is kept, and hides the one that is not said.
 */
const said = (button: Element) => {
  const copy = button.cloneNode(true) as Element;
  for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
  return copy.textContent;
};
/** "New conversation", or a draft opened from the panel by its chain and id. */
async function mode(host: HTMLElement, value: string) {
  if (value === 'new') return openNew(host);
  const [, chain = '', id = ''] = value.split(':');
  return open(host, { chain, id });
}
beforeEach(() => {
  window.history.replaceState(null, '', '/invest');
  router.push.mockClear();
  localStorage.clear();
  sessionStorage.clear();
  calls.length = 0;
  portStore.set(signedInPort(PHANTOM, { userId }));
  portStore.setApi(async (url, init) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      calls.push({ path: url, body });
      return json(response(body.messageId));
    }
    return baseApi(url);
  });
});
afterEach(unmountAll);

describe('private strategy exploration for a new goal', () => {
  it('keeps the same owner’s new-goal words separate across configured networks', async () => {
    const first = goalConversationKey(userId, 'solana', 'mock', 'testnet');
    const other = goalConversationKey(userId, 'solana', 'mock', 'mainnet');
    expect(first).not.toBe(other);
    localStorage.setItem(
      first,
      JSON.stringify({
        revision: 0,
        transcript: [{ id: 'testnet-turn', who: 'person', text: 'Test-network discussion' }],
      }),
    );
    expect(localStorage.getItem(other)).toBeNull();
    localStorage.setItem(
      `tf-goal-conversation:1:${encodeURIComponent(userId)}:solana:mock`,
      JSON.stringify({
        revision: 0,
        transcript: [{ id: 'old-turn', who: 'person', text: 'Unscoped older discussion' }],
      }),
    );
    const host = await show();
    expect(host.textContent).not.toContain('Unscoped older discussion');
    expect(
      localStorage.getItem(`tf-goal-conversation:1:${encodeURIComponent(userId)}:solana:mock`),
    ).toContain('Unscoped older discussion');
  });
  it.each(['en', 'pt'] as const)(
    'offers keyboard-accessible local starters, then sends only the person’s edited words (%s)',
    async (lang) => {
      const host = await show(lang);
      const starters = find(host, '[data-ui="goal-starters"]');
      const buttons = [...starters.querySelectorAll<HTMLButtonElement>('button')];
      expect(buttons.map((button) => button.textContent)).toEqual(
        dictionary(lang).goal.explore.starters,
      );
      // Thom, Oct 28: technology first, then two vaults that state their shares, which come to 100
      // (apps/api relaxed-goal-agent.test.ts reads them on Solana devnet and Robinhood Chain); no
      // income or protect starter, whose drafts were poor
      const [first, ...stated] = buttons.map((button) => button.textContent ?? '');
      expect(first).toBe(
        lang === 'en' ? 'Explore technology stocks' : 'Explorar ações de tecnologia',
      );
      expect(stated).toHaveLength(2);
      for (const words of stated) {
        const shares = [...words.matchAll(/(\d+)%/g)].map((m) => Number(m[1]));
        expect(
          shares.reduce((n, x) => n + x, 0),
          words,
        ).toBe(100);
        expect(words).toMatch(lang === 'en' ? /\bgold\b/ : /\bouro\b/);
      }
      expect(buttons.map((button) => button.textContent).join(' ')).not.toMatch(
        /income|protect|renda|proteger/i,
      );
      const composer = find<HTMLTextAreaElement>(host, 'textarea');
      for (const button of buttons) {
        expect(button.type).toBe('button');
        expect(button.tabIndex).toBe(0);
        button.focus();
        expect(document.activeElement).toBe(button);
        await press(button, 'Enter');
        // Native buttons activate through a click for Enter/Space, as in Button's DOM tests.
        await click(button);
        expect(composer.value).toBe(button.textContent);
        expect(document.activeElement).toBe(composer);
        expect(calls).toHaveLength(0);
        expect(localStorage.getItem(goalConversationKey(userId, 'solana', 'sandbox'))).toBeNull();
      }
      const words =
        lang === 'en' ? 'Explore gold and keep some cash' : 'Explorar ouro e manter parte em caixa';
      await type(composer, words);
      expect(calls).toHaveLength(0);
      await press(composer, 'Enter');
      await settle();
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        path,
        body: { messages: [{ who: 'person', text: words }] },
      });
      expect(host.querySelector('[data-ui="goal-starters"]')).toBeNull();
      expect(calls.some((call) => call.path.includes('/orders'))).toBe(false);
    },
  );
  it('keeps signed-out starters disabled without prefilling or sending', async () => {
    portStore.set(fakePort());
    const host = await show();
    const buttons = [...find(host, '[data-ui="goal-starters"]').querySelectorAll('button')];
    expect(buttons).toHaveLength(3);
    for (const button of buttons) {
      expect(button.getAttribute('aria-disabled')).toBe('true');
      await click(button);
    }
    expect(find<HTMLTextAreaElement>(host, 'textarea').value).toBe('');
    expect(find<HTMLTextAreaElement>(host, 'textarea').disabled).toBe(true);
    expect(calls).toHaveLength(0);
  });
  // Thom, Oct 15: the chat was the narrowest column, beside an empty card
  it('gives the chat the room until the first message, then a fair share beside the draft', async () => {
    const host = await show();
    const workbench = find(host, '[data-ui="goal-conversation"]');
    const chat = find(host, '[data-ui="goal-chat"]');
    const hideChat = () =>
      [...host.querySelectorAll('button')].find((button) =>
        [en.talk.hideChat, en.talk.showChat].includes(button.textContent ?? ''),
      );
    // one block in the middle, at a reading width, with nothing beside it to fold it for
    expect(chat.className).toContain('md:max-w-[46rem]');
    expect(workbench.className).not.toContain('grid-cols-[minmax(27.5rem');
    expect(hideChat()).toBeUndefined();
    await send(host, 'Gold and some cash');
    // beside the draft: 45% from 1024px and half from 1440px, never under 440px
    expect(chat.className).not.toContain('md:max-w-[46rem]');
    expect(workbench.className).toContain(
      'lg:max-[1440px]:grid-cols-[minmax(min(27.5rem,50%),9fr)_minmax(0,11fr)]',
    );
    expect(workbench.className).toContain(
      'min-[1440px]:grid-cols-[minmax(min(27.5rem,50%),1fr)_minmax(0,1fr)]',
    );
    // "Hide chat" gives the draft the whole width
    await click(hideChat() as HTMLElement);
    expect(chat.hidden).toBe(true);
    expect(find(host, '[data-ui="goal-strategy"]').className).toContain('md:col-span-full');
    expect(hideChat()?.textContent).toBe(en.talk.showChat);
    await click(hideChat() as HTMLElement);
    expect(chat.hidden).toBe(false);
    // "Start over": the room is the chat's again
    await click(
      [...host.querySelectorAll('button')].find(
        (button) => button.textContent === en.talk.startOver,
      ) as HTMLElement,
    );
    expect(host.querySelector('[data-ui="goal-strategy"]')).toBeNull();
    expect(chat.className).toContain('md:max-w-[46rem]');
    expect(hideChat()).toBeUndefined();
  });
  it.each(['en', 'pt'] as const)(
    'defaults to truthful explore workbench with no fake vault or funding (%s)',
    async (lang) => {
      const host = await show(lang);
      // No Guided or Explore switch (#195): the conversations panel is its own control.
      expect(host.querySelector('[data-ui="goal-mode"]')).toBeNull();
      expect(current(host)).toBe(dictionary(lang).goal.explore.picker.current);
      // before the first message the chat has the room alone (Thom, Oct 15): no draft's column, so
      // no "Hide chat", and the draft's note is said under the chat's own
      expect(host.querySelector('[data-ui="goal-strategy"]')).toBeNull();
      expect(
        [...host.querySelectorAll('button')].some(
          (button) => button.textContent === dictionary(lang).talk.hideChat,
        ),
      ).toBe(false);
      expect(find(host, '[data-ui="goal-chat"]').textContent).toContain(
        dictionary(lang).goal.explore.previewOnly,
      );
      expect(host.querySelector('[data-ui="invest-screen"]')).toBeNull();
      expect(host.querySelector('[data-ui="composition"]')).toBeNull();
      expect(host.querySelector('[data-ui="buy-card"]')).toBeNull();
      expect(host.querySelector('a[href^="/portfolio/vaults/"]')).toBeNull();
      await send(host, 'I want a strategy with gold and cash');
      expect(calls).toHaveLength(1);
      expect(calls[0].path).toBe(path);
      expect(calls[0].body).toMatchObject({
        version: 1,
        language: lang,
        messages: [{ who: 'person', text: 'I want a strategy with gold and cash' }],
      });
      expect(calls[0].body).not.toHaveProperty('vault');
      expect(calls[0].body).not.toHaveProperty('address');
      // on a proposal the line over "Deposit" says how the draft is bought, not that it cannot be
      expect(find(host, '[data-ui="goal-strategy"]').textContent).toContain(
        dictionary(lang).goal.explore.draftNote,
      );
      expect(find(host, '[data-ui="goal-strategy"]').textContent).not.toContain(
        dictionary(lang).goal.explore.previewOnly,
      );
      expect(find(host, '[data-ui="goal-strategy"]').textContent).not.toContain(
        dictionary(lang).shared.vault.conversation.comparison,
      );
      // the ring draws the draft in its own order, a segment and a row a holding (gate WEIGHTS-RING)
      const strategyCard = find(host, '[data-ui="goal-strategy"]');
      expect(
        [...strategyCard.querySelectorAll('[data-ui="composition-segment"]')].map((e) =>
          e.getAttribute('data-key'),
        ),
      ).toEqual(['solana:gldx', 'solana:usdc']);
      expect(
        [...strategyCard.querySelectorAll('[data-ui="composition-share"]')].map(
          (e) => e.textContent,
        ),
      ).toEqual([4000, 6000].map((bps) => sourceValue(lang, bps / 10000, 'fraction')));
      expect(host.querySelector('[data-ui="buy-card"]')).toBeNull();
      // The preview's one primary button is "Deposit" (gate DEPOSIT-STEP, Thom, Oct 8): it opens the
      // deposit step, and neither buys, funds nor signs anything.
      const primary = [
        ...find(host, '[data-ui="goal-strategy"]').querySelectorAll(
          'button[data-variant="primary"]',
        ),
      ];
      expect(primary.map(said)).toEqual([dictionary(lang).mix.preview.deposit]);
      const before = calls.length;
      await click(primary[0] as HTMLElement);
      expect(host.querySelector('[data-ui="deposit-step"]')).not.toBeNull();
      expect(host.querySelector('[data-ui="buy-card"]')).toBeNull();
      expect(calls).toHaveLength(before);
      expect(router.push).not.toHaveBeenCalled();
    },
  );
  it('sends complete words and actual prior nonexecuted draft weights to refine the next turn', async () => {
    const host = await show();
    await send(host, 'Consider gold');
    await send(host, 'Less gold please');
    const messages = calls[1].body.messages as { who: string; text: string }[];
    expect(messages[0]).toEqual({ who: 'person', text: 'Consider gold' });
    expect(
      messages.some(
        (row) =>
          row.who === 'app' &&
          row.text.includes(en.shared.vault.conversation.draftIntro) &&
          row.text.includes('tGLDx (solana:gldx): 40%') &&
          row.text.includes('exit'),
      ),
    ).toBe(true);
    expect(messages.at(-1)).toEqual({ who: 'person', text: 'Less gold please' });
    expect(calls.every((row) => row.path === path)).toBe(true);
  });
  // Rodrigo, Oct 8: the picker holds this conversation and a new one; the last preview is kept
  // in this browser and shown again on return, still a preview with no way to fund it; "New
  // conversation" clears both.
  it('shows the last preview again on return, offers no funding, and keeps earlier conversations to reopen', async () => {
    let host = await show();
    await send(host, 'Consider gold');
    expect(host.querySelector('[data-ui="composition"]')).not.toBeNull();
    await unmountAll();
    host = await show();
    await settle();
    expect(find(host, '[data-ui="goal-transcript"]').textContent).toContain('Consider gold');
    expect(host.querySelector('[data-ui="composition"]')).not.toBeNull();
    expect(host.querySelector('[data-ui="goal-empty-preview"]')).toBeNull();
    expect(host.querySelector('[data-ui="buy-card"]')).toBeNull();
    expect(
      find(host, '[data-ui="goal-strategy"]').querySelector('button[data-variant="primary"]'),
    ).toBeNull();
    await unfold(host);
    expect(titles(host)).toEqual(['Consider gold']);
    await mode(host, 'new');
    await settle();
    expect(find(host, '[data-ui="goal-transcript"]').textContent).toBe('');
    expect(host.querySelector('[data-ui="goal-strategy"]')).toBeNull();
    expect(host.querySelector('[data-ui="composition"]')).toBeNull();
    // The earlier conversation is kept, listed by its first words, and comes back with its preview.
    await unmountAll();
    host = await show();
    await settle();
    expect(host.querySelector('[data-ui="composition"]')).toBeNull();
    expect(titles(host)).toEqual([en.goal.explore.picker.current, 'Consider gold']);
    // with its chain's mark and name: the panel lists what lives on more than one chain (gate
    // CHAIN-AT-THE-PLAN)
    expect(row(host, 'Consider gold').dataset.chain).toBe('solana');
    expect(find(row(host, 'Consider gold'), '[data-ui="conversation-chain"]').textContent).toBe(
      'Solana',
    );
    await open(host, 'Consider gold');
    await settle();
    expect(find(host, '[data-ui="goal-transcript"]').textContent).toContain('Consider gold');
    expect(host.querySelector('[data-ui="composition"]')).not.toBeNull();
    expect(calls).toHaveLength(1);
  });
  it('keeps the focus on the panel’s button when a pick in its sheet draws the conversation again (PAGE-SHELL)', async () => {
    let host = await show();
    await send(host, 'Consider gold');
    await unmountAll();
    host = await show();
    await settle();
    const opener = () => find(host, '[data-ui="conversations-open"]');
    const sheet = () => find(host, '[data-ui="conversations-sheet"]');
    const before = opener();
    await click(before);
    await click(find(sheet(), '[data-ui="conversation-new"]'));
    await settle();
    // the head was drawn again with the new conversation: the button is a new element, and has it
    const after = opener();
    expect(after).not.toBe(before);
    expect(find(host, '[data-ui="goal-transcript"]').textContent).toBe('');
    expect(document.activeElement).toBe(after);
    // back to the earlier one, from the sheet again
    await click(after);
    const gold = [...sheet().querySelectorAll('[data-ui="conversation-row"]')].find(
      (one) => one.querySelector('[data-ui="conversation-title"]')?.textContent === 'Consider gold',
    );
    await click(find(gold as Element, '[data-ui="conversation-open"]'));
    await settle();
    expect(find(host, '[data-ui="goal-transcript"]').textContent).toContain('Consider gold');
    expect(document.activeElement).toBe(opener());
    // and a person who moved on is not pulled back by the next draw
    find<HTMLTextAreaElement>(host, 'textarea').focus();
    await settle();
    await mode(host, 'new');
    await settle();
    expect(document.activeElement).not.toBe(opener());
  });
  it('preserves exact plain words across unavailable API and reopen without fabricating reply', async () => {
    portStore.setApi(async (url) => baseApi(url));
    const words = '<img src=x onerror=alert(1)> I like electric vehicles';
    const host = await show();
    await send(host, words);
    expect(host.textContent).toContain(en.goal.explore.unavailable);
    expect(find(host, '[data-ui="goal-transcript"]').textContent).toContain(words);
    expect(host.querySelector('img[src="x"]')).toBeNull();
    await unmountAll();
    const reopened = await show();
    expect(find(reopened, '[data-ui="goal-transcript"]').textContent).toContain(words);
    expect(reopened.querySelector('[data-ui="goal-empty-preview"]')).not.toBeNull();
  });
  it.each(['en', 'pt'] as const)(
    'after a failed reply the words are back in the box, and trying again sends the one turn (%s)',
    async (lang) => {
      const copy = dictionary(lang).goal.explore;
      const words = 'Explore electric vehicles';
      let down = true;
      portStore.setApi(async (url, init) => {
        if (init?.method !== 'POST') return baseApi(url);
        const body = JSON.parse(String(init.body));
        calls.push({ path: url, body });
        return down ? json({}, 503) : json(response(body.messageId));
      });
      const host = await show(lang);
      expect(host.querySelector('[data-ui="goal-retry"]')).toBeNull();
      await send(host, words);
      expect(host.textContent).toContain(copy.unavailable);
      expect(find<HTMLTextAreaElement>(host, 'textarea').value).toBe(words);
      const retry = find(host, '[data-ui="goal-retry"]');
      const again = find<HTMLButtonElement>(retry, 'button[data-act="goal-retry"]');
      expect(again.textContent).toBe(copy.retry);
      const way = find<HTMLAnchorElement>(retry, 'a[href="/products"]');
      expect(way.textContent).toBe(copy.elsewhere);
      expect(again.tabIndex).toBe(0);
      expect(way.tabIndex).toBe(0);
      // still down: "Try again" sends the same turn, and so does sending the box as it stands
      await click(again);
      await settle();
      await click(find(host, '[data-ui="composer-send"]'));
      await settle();
      const sent = (i: number) => calls[i].body.messages as { who: string; text: string }[];
      expect(calls).toHaveLength(3);
      for (const i of [0, 1, 2]) expect(sent(i)).toEqual([{ who: 'person', text: words }]);
      // the transcript holds the one turn, and under it the row that says why no reply came
      const turns = () =>
        [...find(host, '[data-ui="goal-transcript"]').children].filter(
          (row) => row.getAttribute('data-ui') !== 'goal-unanswered',
        );
      expect(turns()).toHaveLength(1);
      const unanswered = find(host, '[data-ui="goal-transcript"] > [data-ui="goal-unanswered"]');
      expect(find(unanswered, '[role="alert"]').textContent).toBe(copy.unavailable);
      expect(unanswered.contains(find(host, '[data-ui="goal-retry"]'))).toBe(true);
      // back up: one more press, the reply follows the one turn, and the box and the row are clear
      down = false;
      await click(find(host, 'button[data-act="goal-retry"]'));
      await settle();
      expect(sent(3)).toEqual([{ who: 'person', text: words }]);
      expect(turns().filter((turn) => turn.textContent?.includes(words))).toHaveLength(1);
      expect(find<HTMLTextAreaElement>(host, 'textarea').value).toBe('');
      expect(host.querySelector('[data-ui="goal-retry"]')).toBeNull();
      expect(host.textContent).not.toContain(copy.unavailable);
      expect(
        JSON.parse(
          localStorage.getItem(goalConversationKey(userId, 'solana', 'sandbox')) ?? '{}',
        ).transcript.filter((turn: { text: string }) => turn.text === words),
      ).toHaveLength(1);
    },
  );
  it.each(['en', 'pt'] as const)(
    'explains only checked server failures and retains the person words (%s)',
    async (lang) => {
      const copy = dictionary(lang).goal.explore;
      for (const reason of ['timeout', 'budget', 'invalid', 'unavailable'] as const) {
        portStore.setApi(async (url, init) =>
          init?.method === 'POST'
            ? json(
                { code: 'GOAL_AGENT_UNAVAILABLE', reason, error: '<script>private error</script>' },
                503,
              )
            : baseApi(url),
        );
        const host = await show(lang);
        await send(host, 'Explore electric vehicles');
        expect(host.textContent).toContain(copy[reason]);
        expect(host.textContent).not.toContain('private error');
        expect(find(host, '[data-ui="goal-transcript"]').textContent).toContain(
          'Explore electric vehicles',
        );
        expect(host.querySelector('[data-ui="goal-empty-preview"]')).not.toBeNull();
        expect(host.querySelector('[data-ui="buy-card"]')).toBeNull();
        await unmountAll();
        localStorage.clear();
      }
    },
  );
  it.each([
    { code: 'OTHER_ERROR', reason: 'budget' },
    { code: 'GOAL_AGENT_UNAVAILABLE', reason: '<img src=x onerror=alert(1)>' },
    { code: 'GOAL_AGENT_UNAVAILABLE', reason: null },
  ])('keeps unknown failure payloads out of product copy: %j', async (failure) => {
    portStore.setApi(async (url, init) =>
      init?.method === 'POST' ? json(failure, 503) : baseApi(url),
    );
    const host = await show();
    await send(host, 'Explore technology');
    expect(host.textContent).toContain(en.goal.explore.unavailable);
    expect(host.textContent).not.toContain(en.goal.explore.budget);
    expect(host.querySelector('img[src="x"]')).toBeNull();
    expect(host.querySelector('[data-ui="goal-empty-preview"]')).not.toBeNull();
  });
  it('ignores a late reply after a chain or person switch and never writes it into another history', async () => {
    let resolve: (value: Response) => void = () => {};
    let messageId = '';
    portStore.setApi(async (url, init) =>
      init?.method === 'POST'
        ? new Promise<Response>((r) => {
            messageId = JSON.parse(String(init?.body)).messageId;
            resolve = r;
          })
        : baseApi(url),
    );
    let change: (user: string, chain: 'solana' | 'robinhood') => void = () => {};
    function Screen() {
      const [state, setState] = useState({
        user: userId,
        chain: 'solana' as 'solana' | 'robinhood',
      });
      change = (user, chain) => setState({ user, chain });
      return createElement(GoalConversation, {
        key: `${state.user}:${state.chain}`,
        userId: state.user,
        chain: state.chain,
        provenance: 'sandbox',
        ready: true,
      });
    }
    const host = await mount(withAccount('en', createElement(Screen)));
    await send(host, 'Consider gold');
    await act(async () => change('another-person', 'robinhood'));
    await act(async () => resolve(json(response(messageId))));
    await settle();
    expect(host.textContent).not.toContain('Consider gold');
    expect(host.textContent).not.toContain('Here is a private preview.');
    expect(
      localStorage.getItem(goalConversationKey('another-person', 'robinhood', 'sandbox')),
    ).toBeNull();
    expect(localStorage.getItem(goalConversationKey(userId, 'solana', 'sandbox'))).toContain(
      'Consider gold',
    );
  });
  it('separates actual network histories and discards a pending sandbox reply after same-chain live switch', async () => {
    let messageId = '';
    let release: (response: Response) => void = () => {};
    portStore.setApi(async (url, init) => {
      if (init?.method === 'POST') {
        messageId = JSON.parse(String(init.body)).messageId;
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      return baseApi(url);
    });
    const oldKey = `tf-goal-conversation:1:${encodeURIComponent(userId)}:solana`;
    localStorage.setItem(
      oldKey,
      JSON.stringify({
        revision: 0,
        transcript: [{ id: 'old', who: 'person', text: 'Unscoped history must stay separate' }],
      }),
    );
    const host = await show();
    expect(host.textContent).not.toContain('Unscoped history must stay separate');
    await send(host, 'Sandbox-only words');
    await act(async () => portStore.set(signedInPort(PHANTOM, { userId }, 'live')));
    await settle();
    expect(find(host, '[data-ui="goal-transcript"]').textContent).not.toContain(
      'Sandbox-only words',
    );
    await act(async () => release(json(response(messageId))));
    await settle();
    expect(host.querySelector('[data-ui="composition"]')).toBeNull();
    expect(localStorage.getItem(goalConversationKey(userId, 'solana', 'live'))).toBeNull();
    expect(localStorage.getItem(goalConversationKey(userId, 'solana', 'sandbox'))).toContain(
      'Sandbox-only words',
    );
    expect(localStorage.getItem(oldKey)).toContain('Unscoped history must stay separate');
    await act(async () => portStore.set(signedInPort(PHANTOM, { userId }, 'sandbox')));
    await settle();
    expect(find(host, '[data-ui="goal-transcript"]').textContent).toContain('Sandbox-only words');
    expect(host.textContent).not.toContain('Here is a private preview.');
  });
  it.each(['wrongId', 'wrongChain', 'address', 'badWeights'] as const)(
    'rejects %s response without a visual or executable draft',
    async (kind) => {
      portStore.setApi(async (url, init) => {
        if (!init?.method) return baseApi(url);
        const body = JSON.parse(String(init.body));
        const reply = response(body.messageId);
        return json(
          kind === 'wrongId'
            ? { ...reply, messageId: 'wrong' }
            : kind === 'wrongChain'
              ? { ...reply, chain: 'robinhood' }
              : kind === 'address'
                ? { ...reply, address: 'fabricated' }
                : {
                    ...reply,
                    proposal: {
                      ...preview,
                      allocations: [{ ...preview.allocations[0], weightBps: 9000 }],
                    },
                  },
        );
      });
      const host = await show();
      await send(host, 'Consider gold');
      expect(host.textContent).toContain(en.goal.explore.failed);
      expect(host.querySelector('[data-ui="composition"]')).toBeNull();
      expect(find(host, '[data-ui="goal-transcript"]').textContent).toContain('Consider gold');
    },
  );
  it('does not send without the verified account context', async () => {
    const host = await mount(
      withAccount(
        'en',
        createElement(GoalConversation, {
          userId,
          chain: 'solana',
          provenance: 'sandbox',
          ready: false,
        }),
      ),
    );
    expect(find<HTMLTextAreaElement>(host, 'textarea').disabled).toBe(true);
    await send(host, 'Consider gold');
    expect(calls).toHaveLength(0);
  });
});

describe('the deposit step of a new goal', () => {
  const accept = '/v1/conversations/solana/goal/accept';
  const strategy = (host: HTMLElement) => find(host, '[data-ui="goal-strategy"]');
  const amount = (host: HTMLElement) =>
    find<HTMLInputElement>(host, '[data-ui="amount-well"] input');
  /** Replies in turn; a null is a reply that failed. */
  const replies = (...turns: (Record<string, unknown> | null)[]) => {
    let n = 0;
    portStore.setApi(async (url, init) => {
      if (init?.method !== 'POST') return baseApi(url);
      const body = JSON.parse(String(init.body));
      calls.push({ path: url, body });
      if (url === accept) return json({}, 502);
      const turn = turns[Math.min(n++, turns.length - 1)];
      return turn ? json({ ...response(body.messageId), ...turn }) : json({}, 500);
    });
  };

  it('opens from the proposal with the goal and risk the person said, and no form', async () => {
    replies({ goal: 'grow', risk: 'high' });
    const host = await show();
    await send(host, 'Stocks to grow, I can take high risk');
    // the one action of the preview: named for what it does, and the card's primary button
    const press = find(host, '[data-action="deposit"]');
    expect(said(press)).toBe(en.mix.preview.deposit);
    expect(en.mix.preview.deposit).toBe('Deposit');
    expect(dictionary('pt').mix.preview.deposit).toBe('Depositar');
    expect(press.getAttribute('data-variant')).toBe('primary');
    expect(find(host, '[data-ui="goal-strategy"]').textContent).not.toMatch(/use this mix/i);
    await click(find(host, '[data-action="deposit"]'));
    const step = find(host, '[data-ui="deposit-step"]');
    expect(find(step, '[data-ui="deposit-purpose"]').textContent).toContain(
      en.mix.deposit.purpose('grow', 'high'),
    );
    expect(step.querySelectorAll('select')).toHaveLength(0);
    expect(step.querySelectorAll('input')).toHaveLength(1);
    // the same rows the preview drew, read only
    for (const line of preview.allocations)
      expect(step.querySelector(`[data-row="${line.assetId}"]`)).not.toBeNull();
    // nothing is signed or ordered from /invest
    expect(calls.map((call) => call.path)).toEqual([path]);
    expect(router.push).not.toHaveBeenCalled();
  });

  it('sends for checking exactly the ids and shares the preview shows, and nothing of its own', async () => {
    // a relaxed-intake mix of three lines, cash among them (gate RELAXED-INTAKE): what the deposit
    // step sends is that mix, never the engine's own picks (gate ANY-COMPOSITION)
    const shown = [
      { assetId: 'solana:spy', weightBps: 5000, symbol: 'SPY' },
      { assetId: 'solana:gldx', weightBps: 3000, symbol: 'tGLDx' },
      { assetId: 'solana:usdc', weightBps: 2000, symbol: 'USDC' },
    ].map((line) => ({ ...line, why: `Why ${line.symbol}.`, evidenceIds: ['exit'] }));
    replies({ goal: 'grow', risk: 'high', proposal: { ...preview, allocations: shown } });
    const host = await show();
    await send(host, 'Half a fund, some gold, the rest cash; grow, high risk');
    await click(find(host, '[data-action="deposit"]'));
    await type(amount(host), '250');
    await settle(CHECK_MS + 50);
    const checked = calls.filter((call) => call.path === accept);
    expect(checked.length).toBeGreaterThan(0);
    for (const call of checked)
      expect(call.body).toMatchObject({
        origin: 'model',
        goal: 'grow',
        risk: 'high',
        amountUsd: 250,
        allocations: shown.map(({ assetId, weightBps }) => ({ assetId, weightBps })),
      });
    // the plan is never handed to the engine to pick its own holdings
    expect(calls.some((call) => call.path.includes('/v1/baskets/'))).toBe(false);
  });

  it('asks nothing by a tap: what an older server or the person left unsaid is sent as not said', async () => {
    // a reply with no goal or risk at all, and one with a value this app does not know
    replies({}, { goal: 'speculate', risk: 'medium' });
    const host = await show();
    await send(host, 'Some stocks');
    await click(find(host, '[data-action="deposit"]'));
    expect(host.querySelector('[data-ui="deposit-purpose"]')).toBeNull();
    expect(host.querySelector('[data-ui="deposit-goal"]')).toBeNull();
    expect(host.querySelector('[data-ui="deposit-risk"]')).toBeNull();
    // no toggle to tap a goal or a risk; a holding's row in the picture is the only pressable thing
    expect(host.querySelectorAll('[aria-pressed]:not([data-ui="composition-row"])')).toHaveLength(
      0,
    );
    await type(amount(host), '250');
    await settle(CHECK_MS + 50);
    expect(calls.filter((call) => call.path === accept).at(-1)?.body).toMatchObject({
      goal: null,
      risk: null,
      amountUsd: 250,
    });
    await send(host, 'medium risk please');
    await click(find(host, '[data-action="deposit"]'));
    expect(find(host, '[data-ui="deposit-purpose"]').textContent).toContain(
      en.mix.deposit.purpose(null, 'medium'),
    );
    expect(host.querySelector('[data-ui="deposit-goal"]')).toBeNull();
  });

  // In StrictMode as `next dev` runs it, where React runs a state update twice.
  it.each([
    ['', false],
    [', in StrictMode', true],
  ])(
    'starts the amount from the sum the person wrote, and never replaces one they typed%s',
    async (_, strict) => {
      replies(
        { amountUsd: 2000 },
        { amountUsd: 3000 },
        { amountUsd: 'lots' },
        { amountUsd: 5000 },
        { amountUsd: null },
      );
      const host = await (strict
        ? mount(withAccount('en', createElement(StrictMode, null, createElement(GoalHome))))
        : show());
      await send(host, 'I want to invest 2k, 70% in safe income and 30% in AI stocks');
      await click(find(host, '[data-action="deposit"]'));
      expect(amount(host).value).toBe('2000');
      // focused and selected: what the person types replaces it
      expect(document.activeElement).toBe(amount(host));
      expect([amount(host).selectionStart, amount(host).selectionEnd]).toEqual([0, 4]);
      expect(find(host, '[data-action="deposit-review"]').textContent).toContain(
        en.mix.deposit.reviewOf('$2,000'),
      );
      // a newer sum replaces the one filled in, and something the app cannot read leaves it
      await send(host, 'make it 3k');
      await click(find(host, '[data-action="deposit"]'));
      expect(amount(host).value).toBe('3000');
      await send(host, 'lots');
      await click(find(host, '[data-action="deposit"]'));
      expect(amount(host).value).toBe('3000');
      // what the person typed is theirs: no later sum replaces it, nor one that is not said
      await type(amount(host), '2500');
      await send(host, 'and 5k?');
      await click(find(host, '[data-action="deposit"]'));
      expect(amount(host).value).toBe('2500');
      await send(host, 'ok');
      await click(find(host, '[data-action="deposit"]'));
      expect(amount(host).value).toBe('2500');
    },
  );

  it('writes a sum with cents the way the page reads an amount back', async () => {
    replies({ amountUsd: 1500.5 });
    const host = await show('pt');
    await send(host, 'US$ 1.500,50 em ouro');
    await click(find(host, '[data-action="deposit"]'));
    expect(amount(host).value).toBe('1500,5');
    expect(host.querySelector('[data-ui="amount-well"] [aria-invalid="true"]')).toBeNull();
  });

  it('changes the mix in the conversation: the box takes focus, and the proposal and amount stay', async () => {
    const more = {
      ...preview,
      objective: 'More of one, less of the other',
      allocations: preview.allocations.map((line, i) => ({
        ...line,
        weightBps: i === 0 ? line.weightBps + 100 : i === 1 ? line.weightBps - 100 : line.weightBps,
      })),
    };
    replies(
      { goal: 'grow', risk: 'high' },
      null,
      { goal: 'grow', risk: 'low', proposal: null, message: 'Lower risk it is.' },
      { goal: 'grow', risk: 'low', proposal: more },
    );
    const host = await show();
    await send(host, 'Stocks to grow, high risk');
    await click(find(host, '[data-action="deposit"]'));
    await type(amount(host), '250');
    await click(find(host, '[data-action="change-mix"]'));
    expect(document.activeElement).toBe(find(host, 'textarea'));
    expect(host.querySelector('[data-ui="deposit-step"]')).not.toBeNull();

    // the chat fails: its error says so by the box, and the deposit step keeps the mix and the amount
    await send(host, 'more of the first, less of the second');
    expect(find(host, '[data-ui="goal-chat"]').textContent).toContain(en.goal.explore.failed);
    expect(find(host, '[data-ui="goal-retry"]').textContent).toContain(en.goal.explore.retry);
    expect(amount(host).value).toBe('250');
    expect(
      strategy(host).querySelector(`[data-row="${preview.allocations[0]?.assetId}"]`),
    ).not.toBeNull();

    // a reply that only talks changes what was said, not the mix
    await send(host, 'actually low risk');
    expect(find(host, '[data-ui="deposit-purpose"]').textContent).toContain(
      en.mix.deposit.purpose('grow', 'low'),
    );
    expect(amount(host).value).toBe('250');

    // another proposal is read as a preview first; using it finds the amount where it was
    await send(host, 'more of the first, less of the second');
    expect(host.querySelector('[data-ui="deposit-step"]')).toBeNull();
    expect(strategy(host).textContent).toContain('More of one, less of the other');
    await click(find(host, '[data-action="deposit"]'));
    expect(amount(host).value).toBe('250');
    expect(calls.filter((call) => call.path === path).at(-1)?.body.messages).toEqual(
      expect.arrayContaining([{ who: 'person', text: 'more of the first, less of the second' }]),
    );
  });

  it('moves focus with the screen: to the amount when the step opens, to the button on the way back', async () => {
    replies({ goal: 'grow', risk: 'high' });
    const host = await show();
    await send(host, 'Stocks to grow, high risk');
    await click(find(host, '[data-action="deposit"]'));
    expect(document.activeElement).toBe(amount(host));
    await click(
      [...host.querySelectorAll('button')].find(
        (button) => button.textContent === en.mix.deposit.backToProposal,
      ) as HTMLElement,
    );
    expect(document.activeElement).toBe(find(host, '[data-action="deposit"]'));
  });

  it('holds the deposit action while a reply is being worked on', async () => {
    let release: () => void = () => {};
    let n = 0;
    portStore.setApi(async (url, init) => {
      if (init?.method !== 'POST') return baseApi(url);
      const body = JSON.parse(String(init.body));
      n += 1;
      if (n === 2)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return json({ ...response(body.messageId), goal: 'grow', risk: 'high' });
    });
    const host = await show();
    await send(host, 'Stocks to grow, high risk');
    await type(find<HTMLTextAreaElement>(host, 'textarea'), 'more of the first');
    await click(find(host, '[data-ui="composer-send"]'));
    // the last mix stays on the screen, and its button waits for the reply
    const press = find(host, '[data-action="deposit"]');
    expect(press.getAttribute('aria-disabled')).toBe('true');
    await click(press);
    expect(host.querySelector('[data-ui="deposit-step"]')).toBeNull();
    release();
    await settle();
    expect(find(host, '[data-action="deposit"]').getAttribute('aria-disabled')).toBeNull();
  });

  it('starts over with no mix, no amount and no deposit step', async () => {
    replies({ goal: 'grow', risk: 'high' });
    const host = await show();
    await send(host, 'Stocks to grow, high risk');
    await click(find(host, '[data-action="deposit"]'));
    await type(amount(host), '250');
    await click(
      [...host.querySelectorAll('button')].find(
        (button) => button.textContent === en.talk.startOver,
      ) as HTMLElement,
    );
    expect(host.querySelector('[data-ui="deposit-step"]')).toBeNull();
    expect(host.querySelector('[data-ui="goal-strategy"]')).toBeNull();
  });
});

describe('the draft drawn on the plan bar', () => {
  const lineOf = (symbol: string, weightBps: number) => ({
    assetId: `solana:${symbol.toLowerCase()}`,
    weightBps,
    why: `Why ${symbol} is in it.`,
    evidenceIds: ['exit'],
    symbol,
  });
  const mixOf = (...lines: [string, number][]) => ({
    ...preview,
    allocations: lines.map(([symbol, bps]) => lineOf(symbol, bps)),
  });
  /** Answers each turn with the next of `replies`; with `hold`, only once it is let through. */
  const answer = (replies: Record<string, unknown>[], hold = false) => {
    const waiting: (() => void)[] = [];
    let turn = 0;
    portStore.setApi(async (url, init) => {
      if (init?.method !== 'POST') return baseApi(url);
      const body = JSON.parse(String(init.body));
      const reply = replies[Math.min(turn++, replies.length - 1)];
      if (hold) await new Promise<void>((done) => waiting.push(done));
      return json({ ...response(body.messageId), ...reply });
    });
    return async () => {
      await act(async () => waiting.shift()?.());
      await settle();
    };
  };
  /** The strip's segments as drawn: each holding and its colour, in order. */
  const legs = (host: HTMLElement) =>
    [
      ...find(
        host,
        '[data-ui="goal-strategy"] [data-ui="composition-strip"]',
      ).querySelectorAll<HTMLElement>('[data-ui="composition-segment"]'),
    ].map((el) => [el.getAttribute('data-key'), el.style.background]);
  /** The row under the strip for each holding: its name and its share. */
  const labels = (host: HTMLElement) =>
    [
      ...find(host, '[data-ui="preview-draft"] [data-ui="composition-list"]').querySelectorAll(
        '[data-row]',
      ),
    ].map(
      (el) =>
        `${el.querySelector('[data-part="name"]')?.textContent}·${el.querySelector('[data-ui="composition-share"]')?.textContent}`,
    );
  const rowOf = (host: HTMLElement, symbol: string) =>
    find(host, `[data-ui="preview-draft"] [data-row="solana:${symbol.toLowerCase()}"]`);
  /** The colour a holding is drawn in: its segment's, in the order the rows come. */
  const swatchOf = (host: HTMLElement, symbol: string) =>
    find<HTMLElement>(
      host,
      `[data-ui="goal-strategy"] [data-ui="composition-segment"][data-key="solana:${symbol.toLowerCase()}"]`,
    ).style.background;
  const id = (symbol: string) => `solana:${symbol.toLowerCase()}`;
  const SIX: [string, number][] = [
    ['SPY', 1667],
    ['QQQ', 1667],
    ['NVDA', 1667],
    ['AAPL', 1667],
    ['GLD', 1666],
    ['USDC', 1666],
  ];
  afterEach(() => vi.unstubAllGlobals());

  it.each(['en', 'pt'] as const)(
    'draws every holding as its own segment and row, coloured in the draft’s order, cash in its neutral (%s)',
    async (lang) => {
      // six holdings: no grouping any more (gate WEIGHTS-RING); each is a segment and a row
      answer([{ proposal: mixOf(...SIX) }]);
      const host = await show(lang);
      await send(host, 'Six things');
      const share = (bps: number) => sourceValue(lang, bps / 10000, 'fraction');
      const fills = [1, 2, 3, 4, 5]
        .map((n) => `var(--tf-share-${n})`)
        .concat('var(--tf-share-cash)');
      expect(legs(host)).toEqual(SIX.map(([symbol], i) => [id(symbol), fills[i]]));
      // the strip is said once in words, every holding with its share
      expect(find(host, '[data-ui="goal-strategy"] [role="img"]').getAttribute('aria-label')).toBe(
        dictionary(lang).shared.composition.summary(
          SIX.map(([symbol, bps]) => `${symbol} ${share(bps)}`).join(', '),
        ),
      );
      // every holding has its own row with its exact share, and a segment in its colour
      for (const [i, [symbol, bps]] of SIX.entries()) {
        expect(find(rowOf(host, symbol), '[data-ui="composition-share"]').textContent).toBe(
          share(bps),
        );
        expect(swatchOf(host, symbol)).toBe(fills[i]);
      }
      expect(
        find(host, '[data-ui="preview-draft"] [data-ui="composition-list"]').querySelectorAll(
          '[data-row]',
        ),
      ).toHaveLength(6);
    },
  );

  it('colours by place, not by size: a large holding late in the draft keeps its place and its slot', async () => {
    answer([
      {
        proposal: mixOf(['USDC', 500], ['SPY', 4000], ['QQQ', 500], ['GLD', 3000], ['NVDA', 2000]),
      },
    ]);
    const host = await show();
    await send(host, 'Five things');
    // the rows and the segments keep the draft's order; a colour follows the holding, not its size
    expect(labels(host)).toEqual(['USDC·5%', 'SPY·40%', 'QQQ·5%', 'GLD·30%', 'NVDA·20%']);
    expect(['USDC', 'SPY', 'QQQ', 'GLD', 'NVDA'].map((symbol) => swatchOf(host, symbol))).toEqual([
      'var(--tf-share-cash)',
      'var(--tf-share-1)',
      'var(--tf-share-2)',
      'var(--tf-share-3)',
      'var(--tf-share-4)',
    ]);
    expect(legs(host).map(([key]) => key)).toEqual(['USDC', 'SPY', 'QQQ', 'GLD', 'NVDA'].map(id));
  });

  it('draws a few holdings as a strip that is a picture: no control in it, nothing lit at rest, no motion', async () => {
    answer([{ proposal: mixOf(['SPY', 5000], ['GLD', 3000], ['USDC', 2000]) }]);
    const host = await show();
    await send(host, 'A fund, gold and cash');
    expect(legs(host)).toEqual([
      [id('SPY'), 'var(--tf-share-1)'],
      [id('GLD'), 'var(--tf-share-2)'],
      [id('USDC'), 'var(--tf-share-cash)'],
    ]);
    expect(labels(host)).toEqual(['SPY·50%', 'GLD·30%', 'USDC·20%']);
    const strip = find(host, '[data-ui="goal-strategy"] [role="img"]');
    // a picture: the rows carry everything, and the strip is not a control
    expect(strip.querySelector('button, [tabindex]')).toBeNull();
    // at rest nothing is lit or dimmed
    const strategy = find(host, '[data-ui="goal-strategy"]');
    expect(strategy.querySelector('[data-dim]')).toBeNull();
    expect(strategy.querySelector('[data-lit], [data-part="piece"], [role="toolbar"]')).toBeNull();
    // the plan-lock went with the bar (gate WEIGHTS-RING): the draft arrives with no motion
    expect(find(strategy, '[data-ui="composition"]').innerHTML).not.toMatch(/animate-/);
  });

  it('keeps the last mix when the next reply is only a question, and never called it a new draft', async () => {
    const release = answer(
      [
        { proposal: mixOf(['SPY', 5000], ['GLD', 3000], ['USDC', 2000]) },
        { proposal: null, message: 'I need one thing first.', question: 'For how long?' },
      ],
      true,
    );
    const host = await show();
    await send(host, 'A fund, gold and cash');
    const strategy = find(host, '[data-ui="goal-strategy"]');
    await release();
    await send(host, 'Make it safer');
    // the line promises no new draft: the reply may be a question
    const line = find(strategy, '[data-ui="preview-pending"]').textContent ?? '';
    expect(line).toBe(en.shared.vault.conversation.reworking);
    expect(line).not.toMatch(/new draft/i);
    expect(find(strategy, '[data-action="deposit"]').textContent).not.toMatch(/new draft/i);
    await release();
    // the settled rule (gate DEPOSIT-STEP): a reply with no proposal keeps the last mix, no longer
    // marked as waiting, and its deposit action is the person's again
    expect(labels(host)).toEqual(['SPY·50%', 'GLD·30%', 'USDC·20%']);
    expect(find(strategy, '[data-ui="preview-pending"]').textContent).toBe('');
    expect(strategy.querySelector('[data-ui="goal-empty-preview"]')).toBeNull();
    expect(find(strategy, '[data-action="deposit"]').getAttribute('aria-disabled')).toBeNull();
    expect(find(host, '[data-ui="goal-transcript"]').textContent).toContain(
      'I need one thing first.\n\nFor how long?',
    );
  });

  it('says a draft is being worked on, keeps the one before it unusable, then shows the next one', async () => {
    const release = answer(
      [
        { proposal: mixOf(['SPY', 5000], ['GLD', 3000], ['USDC', 2000]) },
        { proposal: mixOf(['SPY', 6000], ['USDC', 2000], ['QQQ', 2000]) },
      ],
      true,
    );
    const host = await show();
    expect(host.querySelector('[data-ui="goal-strategy"]')).toBeNull();
    await send(host, 'A fund, gold and cash');
    // the first wait: the draft's column opens with a card that says at heading size that a draft
    // is being worked on, with still boxes where its rows will be, and draws no mix, share or figure
    const strategy = find(host, '[data-ui="goal-strategy"]');
    const card = find(strategy, '[data-ui="goal-empty-preview"]');
    expect(card.getAttribute('data-state')).toBe('building');
    const building = find(card, '[data-ui="draft-building"]');
    expect(find(building, 'h2').textContent).toBe(en.goal.explore.building);
    expect(building.textContent).toContain(en.goal.explore.working);
    expect(find(building, '[data-ui="lattice"], [data-ui="lattice-loader"]')).not.toBeNull();
    const boxes = find(building, '[data-ui="draft-skeleton"]');
    expect(boxes.getAttribute('aria-hidden')).toBe('true');
    expect(boxes.textContent).toBe('');
    expect(boxes.querySelectorAll('[data-ui="skeleton"]').length).toBeGreaterThan(6);
    expect(strategy.querySelector('[data-ui="composition"]')).toBeNull();
    expect(strategy.textContent).not.toMatch(/\d\s?%/);
    // the wait is announced by the conversation, once: the card is busy, and is no live region
    expect(strategy.getAttribute('aria-busy')).toBe('true');
    expect(strategy.querySelector('[role="status"]')).toBeNull();
    await release();
    expect(strategy.querySelector('[data-ui="draft-building"]')).toBeNull();
    expect(labels(host)).toEqual(['SPY·50%', 'GLD·30%', 'USDC·20%']);
    const use = () => find(strategy, '[data-action="deposit"]');
    expect(use().getAttribute('aria-disabled')).not.toBe('true');

    // the next wait: the draft stays, said to be the last one, and its action waits
    // the button opens the deposit step; back on the proposal, the next words are sent
    await click(use());
    expect(host.querySelector('[data-action="deposit-review"]')).not.toBeNull();
    await click(
      [...host.querySelectorAll('button')].find(
        (button) => button.textContent === en.mix.deposit.backToProposal,
      ) as HTMLElement,
    );
    // the banner's place is there, empty, before its words come, so nothing moves when they do
    const pendingLine = find(strategy, '[data-ui="preview-pending"]');
    expect(pendingLine.textContent).toBe('');
    expect(strategy.querySelector('[data-set-back]')).toBeNull();
    const shares = () =>
      [...strategy.querySelectorAll('[data-ui="composition-share"]')].map((el) => el.textContent);
    const before = shares();
    await send(host, 'Swap the gold for a second fund');
    // the banner leads the card: it is the first thing in it, with the mark of a wait beside its words
    expect(find(strategy, '[data-ui="preview-pending"]').textContent).toBe(
      en.shared.vault.conversation.reworking,
    );
    expect(pendingLine).toBe(find(strategy, '[data-ui="preview-pending"]'));
    expect(find(pendingLine, '[data-ui="lattice"], [data-ui="lattice-loader"]')).not.toBeNull();
    expect(find(strategy, '[data-ui="card"] [data-ui="card-body"]').firstElementChild).toBe(
      pendingLine.parentElement,
    );
    // The whole draft is set back, not the bar alone: the objective, the bar, the rows and their
    // figures are inside it, in grey ink. Nothing is faded or dimmed.
    const back = find(strategy, '[data-set-back]');
    expect(back.className).toContain('text-muted-foreground');
    expect(back.className).not.toMatch(/(^| )opacity-/);
    expect(back.contains(find(strategy, '[data-ui="composition-strip"]'))).toBe(true);
    // nothing is dimmed, the strip included: no opacity on what is set back, and no segment dimmed
    expect(back.className).not.toMatch(/(^| )opacity-/);
    expect(back.querySelector('[data-dim]')).toBeNull();
    expect(back.contains(find(strategy, '[data-ui="composition-list"]'))).toBe(true);
    expect(back.textContent).toContain(preview.objective);
    // the banner and the action are not set back
    expect(back.contains(pendingLine)).toBe(false);
    expect(back.contains(use())).toBe(false);
    // it is still the draft from before, with the figures it had
    expect(shares()).toEqual(before);
    expect(labels(host)).toEqual(['SPY·50%', 'GLD·30%', 'USDC·20%']);
    // In the Deposit button's place: the same button, which keeps its focus and its width, says it
    // waits for the reply, with the mark of a wait. It cannot open the deposit step meanwhile.
    expect(use().getAttribute('aria-disabled')).toBe('true');
    expect(use().getAttribute('aria-busy')).toBe('true');
    const words = [...use().querySelectorAll(':scope > span > span')];
    expect(words.map((el) => [el.textContent, el.getAttribute('aria-hidden')])).toEqual([
      [en.mix.preview.deposit, 'true'],
      [en.shared.vault.conversation.waitingAction, null],
    ]);
    expect(
      words[1]?.querySelector('[data-ui="lattice"], [data-ui="lattice-loader"]'),
    ).not.toBeNull();
    await click(use());
    expect(host.querySelector('[data-action="deposit-review"]')).toBeNull();

    await release();
    expect(find(strategy, '[data-ui="preview-pending"]').textContent).toBe('');
    expect(use().getAttribute('aria-disabled')).not.toBe('true');
    expect(use().getAttribute('aria-busy')).toBeNull();
    expect(strategy.querySelector('[data-set-back]')).toBeNull();
    // the next draft is simply the new bar and rows: each figure the proposal's own
    expect(legs(host)).toEqual([
      [id('SPY'), 'var(--tf-share-1)'],
      [id('USDC'), 'var(--tf-share-cash)'],
      [id('QQQ'), 'var(--tf-share-2)'],
    ]);
    expect(labels(host)).toEqual(['SPY·60%', 'USDC·20%', 'QQQ·20%']);
    expect(find(rowOf(host, 'SPY'), '[data-ui="composition-share"]').textContent).toBe('60%');
    expect(strategy.querySelector('[data-row="solana:gld"]')).toBeNull();
  });

  it('keeps the mix before it when the next reply does not come', async () => {
    let fail = false;
    portStore.setApi(async (url, init) => {
      if (init?.method !== 'POST') return baseApi(url);
      if (fail) return json({}, 500);
      return json(response(JSON.parse(String(init.body)).messageId));
    });
    const host = await show();
    await send(host, 'Gold and cash');
    expect(host.querySelector('[data-ui="composition"]')).not.toBeNull();
    fail = true;
    await send(host, 'Something else');
    // the settled rule (gate DEPOSIT-STEP): the chat says it failed, and the last mix stays usable
    expect(find(host, '[role="alert"]').textContent).toBe(en.goal.explore.failed);
    expect(host.querySelector('[data-ui="composition"]')).not.toBeNull();
    expect(host.querySelector('[data-ui="goal-empty-preview"]')).toBeNull();
    expect(find(host, '[data-ui="preview-pending"]').textContent).toBe('');
    expect(find(host, '[data-action="deposit"]').getAttribute('aria-disabled')).toBeNull();
  });

  it('says a question once when the message already ends with it', async () => {
    const question = 'How long can this money stay invested?';
    answer([
      {
        proposal: null,
        message: `I can work with that.  how long can this money\nstay invested?`,
        question,
      },
      { proposal: null, message: 'I can work with that.', question },
    ]);
    const host = await show();
    await send(host, 'Something steady');
    const said = () => [...find(host, '[data-ui="goal-transcript"]').children].at(-1)?.textContent;
    expect(said()).toBe(
      `${en.talk.me}: I can work with that.  how long can this money\nstay invested?`,
    );
    await send(host, 'Tell me more');
    expect(said()).toBe(`${en.talk.me}: I can work with that.\n\n${question}`);
  });
});

describe('waiting for a reply, in the conversation and on the card', () => {
  /** Holds every reply until it is let through, or fails it. */
  const held = (outcome: () => Response | null = () => null) => {
    const waiting: (() => void)[] = [];
    portStore.setApi(async (url, init) => {
      if (init?.method !== 'POST') return baseApi(url);
      const body = JSON.parse(String(init.body));
      calls.push({ path: url, body });
      await new Promise<void>((done) => waiting.push(done));
      return outcome() ?? json(response(body.messageId));
    });
    return async () => {
      await act(async () => waiting.shift()?.());
      await settle();
    };
  };
  const rows = (host: HTMLElement) => [...find(host, '[data-ui="goal-transcript"]').children];
  const announced = (host: HTMLElement) => find(host, '[data-ui="reply-announcer"]');
  const say = async (host: HTMLElement, words: string) => {
    await type(find<HTMLTextAreaElement>(host, 'textarea'), words);
    await click(find(host, '[data-ui="composer-send"]'));
  };
  const lines = en.goal.explore.pendingLines;

  it('puts a pending reply under the sent message, and the reply takes its place', async () => {
    const release = held();
    const host = await show();
    // said once, by one polite region: the transcript itself is not live
    expect(announced(host).getAttribute('role')).toBe('status');
    expect(announced(host).textContent).toBe('');
    expect(find(host, '[data-ui="goal-transcript"]').hasAttribute('aria-live')).toBe(false);
    // (the chain's own line beside the box is the chain's, and says nothing of a reply)
    expect(
      ['[data-ui="goal-transcript"]', '[data-ui="composer"]'].flatMap((part) => [
        ...find(host, part).querySelectorAll('[role="status"], [aria-live]'),
      ]),
    ).toEqual([]);
    expect(host.querySelectorAll('[data-ui="reply-announcer"]')).toHaveLength(1);
    await say(host, 'Gold and some cash');
    expect(
      find(host, '[data-ui="goal-strategy"]').querySelectorAll('[role="status"], [aria-live]'),
    ).toHaveLength(0);
    // at once: the message, and under it the reply's place with the mark of a wait and a plain line
    expect(
      rows(host).map((row) => row.getAttribute('data-ui') ?? row.getAttribute('data-who')),
    ).toEqual(['person', 'reply-pending']);
    const pending = find(host, '[data-ui="reply-pending"]');
    expect(pending.getAttribute('data-who')).toBe('app');
    expect(pending.textContent).toBe(`${en.talk.me}: ${lines[0]}`);
    expect(find(pending, '[data-ui="lattice"], [data-ui="lattice-loader"]')).not.toBeNull();
    expect(pending.closest('[aria-live], [role="status"]')).toBeNull();
    expect(announced(host).textContent).toBe(en.shared.vault.conversation.reading);
    // the old line under the box is gone
    expect(find(host, '[data-ui="composer"]').querySelector('[role="status"]')).toBeNull();
    // after 400ms the lattice assembles, in the row and on the send button, at a size to be seen
    await settle(450);
    expect(find(pending, '[data-ui="lattice-loader"]').getAttribute('width')).toBe('24');
    const button = find(host, '[data-ui="composer-send"]');
    expect(
      Number(find(button, '[data-ui="lattice-loader"]').getAttribute('width')),
    ).toBeGreaterThan(20);
    expect(announced(host).textContent).toBe(en.shared.vault.conversation.reading);

    await release();
    // the reply is where the pending row was, and is read out once
    expect(host.querySelector('[data-ui="reply-pending"]')).toBeNull();
    expect(rows(host)[1]?.getAttribute('data-who')).toBe('app');
    expect(rows(host)[1]?.textContent).toBe(`${en.talk.me}: Here is a private preview.`);
    expect(announced(host).textContent).toBe(
      `${en.talk.me}: Here is a private preview. ${en.shared.vault.conversation.draftArrived}`,
    );
    // (the chain's own line beside the box is the chain's, and says nothing of a reply)
    expect(
      ['[data-ui="goal-transcript"]', '[data-ui="composer"]', '[data-ui="goal-strategy"]'].flatMap(
        (part) => [...find(host, part).querySelectorAll('[role="status"], [aria-live]')],
      ),
    ).toEqual([]);
    expect(host.querySelectorAll('[data-ui="reply-announcer"]')).toHaveLength(1);
    expect(host.querySelector('[data-ui="composer-send"] [data-ui="lattice-loader"]')).toBeNull();
  });

  it('takes typing while a reply is on its way, sends nothing, and says so in the hint’s place', async () => {
    const release = held();
    const host = await show();
    const box = find<HTMLTextAreaElement>(host, 'textarea');
    const hint = () =>
      [...find(host, '[data-ui="composer-hint"]').children].map((el) => [
        el.textContent,
        el.getAttribute('aria-hidden'),
      ]);
    expect(hint()).toEqual([
      [en.shared.vault.conversation.hint, null],
      [en.shared.vault.conversation.busyHint, 'true'],
    ]);
    await say(host, 'Gold and some cash');
    box.focus();
    expect(box.readOnly).toBe(false);
    expect(box.disabled).toBe(false);
    expect(hint()).toEqual([
      [en.shared.vault.conversation.hint, 'true'],
      [en.shared.vault.conversation.busyHint, null],
    ]);
    expect(box.getAttribute('aria-describedby')).toBe(find(host, '[data-ui="composer-hint"]').id);
    // the next thought is typed, and neither Enter nor the button sends it
    await type(box, 'and less risk');
    const button = find(host, '[data-ui="composer-send"]');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('aria-busy')).toBe('true');
    await press(box, 'Enter');
    await click(button);
    expect(calls).toHaveLength(1);
    expect(rows(host)).toHaveLength(2);
    expect(box.value).toBe('and less risk');
    // a state change never moves the focus
    expect(document.activeElement).toBe(box);
    await release();
    expect(document.activeElement).toBe(box);
    expect(box.value).toBe('and less risk');
    expect(button.getAttribute('aria-disabled')).toBeNull();
    expect(hint()[1]).toEqual([en.shared.vault.conversation.busyHint, 'true']);
    // now it sends
    await press(box, 'Enter');
    expect(calls).toHaveLength(2);
    await release();
  });

  it('turns the pending reply into the failure with "Try again", and trying again adds no turn', async () => {
    let down = true;
    const release = held(() => (down ? json({}, 500) : null));
    const host = await show();
    await say(host, 'Gold and some cash');
    expect(find(host, '[data-ui="reply-pending"]')).not.toBeNull();
    await release();
    expect(host.querySelector('[data-ui="reply-pending"]')).toBeNull();
    expect(
      rows(host).map((row) => row.getAttribute('data-ui') ?? row.getAttribute('data-who')),
    ).toEqual(['person', 'goal-unanswered']);
    const failed = find(host, '[data-ui="goal-unanswered"]');
    expect(find(failed, '[role="alert"]').textContent).toBe(en.goal.explore.failed);
    expect(find(failed, 'button[data-act="goal-retry"]').textContent).toBe(en.goal.explore.retry);
    // said by the alert alone: the polite region has nothing left to repeat
    expect(announced(host).textContent).toBe('');
    expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1);
    // again: the pending row is back under the one turn, then the reply
    down = false;
    await click(find(failed, 'button[data-act="goal-retry"]'));
    expect(
      rows(host).map((row) => row.getAttribute('data-ui') ?? row.getAttribute('data-who')),
    ).toEqual(['person', 'reply-pending']);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    await release();
    expect(rows(host).filter((row) => row.getAttribute('data-who') === 'person')).toHaveLength(1);
    expect(calls.map((call) => (call.body.messages as unknown[]).length)).toEqual([1, 1]);
    expect(host.querySelector('[data-ui="goal-unanswered"]')).toBeNull();
  });

  it('brings the pending row and the box into view on send, and a failure with its actions when it lands', async () => {
    const seen: string[] = [];
    const proto = Element.prototype as { scrollIntoView?: unknown };
    const before = proto.scrollIntoView;
    proto.scrollIntoView = function (this: Element, options?: ScrollIntoViewOptions) {
      seen.push(`${this.getAttribute('data-ui')}:${options?.block}`);
    };
    try {
      const release = held();
      const host = await show();
      const box = find<HTMLTextAreaElement>(host, 'textarea');
      box.focus();
      await say(host, 'Gold and some cash');
      // the row under the message first, in the transcript's own scroll and the page's; then the
      // box, which on a phone sits under the transcript. Each only as far as needed.
      expect(seen).toEqual(['reply-pending:nearest', 'composer:nearest']);
      expect(document.activeElement).toBe(box);
      await release();
      // a reply starts where the pending row was, which is in view: nothing more to bring in
      expect(seen).toHaveLength(2);
      expect(document.activeElement).toBe(box);
      // a failure is taller than the row it replaces: it and its actions are brought in, then the box
      portStore.setApi(async (url, init) =>
        init?.method === 'POST' ? json({}, 500) : baseApi(url),
      );
      seen.length = 0;
      await say(host, 'More gold');
      await settle();
      expect(seen).toEqual([
        'reply-pending:nearest',
        'composer:nearest',
        'goal-unanswered:nearest',
        'composer:nearest',
      ]);
      expect(document.activeElement).toBe(box);
    } finally {
      proto.scrollIntoView = before;
    }
  });

  it('changes the line as the wait goes on, says nothing is finished, and announces none of it', async () => {
    const release = held();
    const host = await show();
    vi.useFakeTimers();
    try {
      await say(host, 'Gold and some cash');
      const pending = () => find(host, '[data-ui="reply-pending"]');
      const after = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
      expect(pending().textContent).toContain(lines[0]);
      await after(REPLY_LINE_MS[0] - 1);
      expect(pending().textContent).toContain(lines[0]);
      await after(1);
      expect(pending().textContent).toBe(`${en.talk.me}: ${lines[1]}`);
      await after(REPLY_LINE_MS[1] - REPLY_LINE_MS[0] - 1);
      expect(pending().textContent).toContain(lines[1]);
      await after(1);
      expect(pending().textContent).toBe(`${en.talk.me}: ${lines[2]}`);
      await after(120_000);
      expect(pending().textContent).toBe(`${en.talk.me}: ${lines[2]}`);
      // the one announcement was made when the message was sent, and has not changed since
      expect(announced(host).textContent).toBe(en.shared.vault.conversation.reading);
      expect(pending().closest('[aria-live], [role="status"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
    await release();
    expect(host.querySelector('[data-ui="reply-pending"]')).toBeNull();
    // a new wait starts from the first line
    await say(host, 'More gold');
    expect(find(host, '[data-ui="reply-pending"]').textContent).toContain(lines[0]);
    await release();
  });

  it('says in its lines only what happens on every reply: no step is called done, and no figure is shown', () => {
    for (const lang of ['en', 'pt'] as const) {
      const copy = dictionary(lang);
      const all = [
        ...copy.goal.explore.pendingLines,
        ...copy.shared.vault.conversation.pendingLines,
        copy.goal.explore.building,
        copy.goal.explore.working,
        copy.shared.vault.conversation.building,
        copy.shared.vault.conversation.buildingLine,
        copy.shared.vault.conversation.reworking,
        copy.shared.vault.conversation.waitingAction,
        copy.shared.vault.conversation.busyHint,
      ];
      expect(copy.goal.explore.pendingLines).toHaveLength(3);
      expect(copy.shared.vault.conversation.pendingLines).toHaveLength(3);
      for (const line of all) {
        expect(line, line).not.toMatch(/\d|%|✓|!/);
        expect(line, line).not.toMatch(/\b(done|finished|complete|ready|pronto|conclu|terminad)/i);
      }
    }
    // the reply may be a question: nothing promises a new draft on a card that shows one
    expect(en.shared.vault.conversation.reworking).not.toMatch(/new draft/i);
    expect(en.shared.vault.conversation.waitingAction).not.toMatch(/draft/i);
  });
});

describe('existing entry handoffs', () => {
  it('prefills handed-over words in Explore across sign-in, then consumes once on accepted words even if reply fails', async () => {
    portStore.set(fakePort());
    // The words another screen handed over (features/goal/draft.ts), as the old landing's box did.
    const words = 'Grow $2,000 for ten years';
    sessionStorage.setItem(GOAL_HANDOFF, words);
    portStore.setApi(async (url) => baseApi(url));
    const host = await show();
    // signed out: nothing of anyone's is listed yet
    expect(titles(host)).toEqual([]);
    expect(find<HTMLTextAreaElement>(host, 'textarea').value).toBe(words);
    expect(find<HTMLTextAreaElement>(host, 'textarea').disabled).toBe(true);
    expect(calls).toHaveLength(0);
    await act(async () => portStore.set(signedInPort(PHANTOM, { userId })));
    await settle();
    expect(find<HTMLTextAreaElement>(host, 'textarea').value).toBe(words);
    expect(sessionStorage.getItem(GOAL_HANDOFF)).toBe(words);
    expect(sessionStorage.getItem(GOAL_HANDOFF_OWNER)).toBe(userId);
    await click(find(host, '[data-ui="composer-send"]'));
    await settle();
    expect(sessionStorage.getItem(GOAL_HANDOFF)).toBeNull();
    expect(sessionStorage.getItem(GOAL_HANDOFF_OWNER)).toBeNull();
    expect(find(host, '[data-ui="goal-transcript"]').textContent).toContain(words);
    expect(host.textContent).toContain(en.goal.explore.unavailable);
    expect(localStorage.getItem(goalConversationKey(userId, 'solana', 'sandbox'))).toContain(words);
    expect(host.querySelector('[data-ui="invest-screen"]')).toBeNull();
  });
  it('does not prefill another verified person with an unconsumed signed-in handoff', async () => {
    sessionStorage.setItem(GOAL_HANDOFF, 'My private pending goal');
    const host = await show();
    expect(sessionStorage.getItem(GOAL_HANDOFF_OWNER)).toBe(userId);
    expect(find<HTMLTextAreaElement>(host, 'textarea').value).toBe('My private pending goal');
    portStore.setApi(async (url) =>
      url === '/v1/me' ? json({ ...person, userId: 'another-person' }) : json({}, 404),
    );
    await act(async () => portStore.set(signedInPort(PHANTOM, { userId: 'another-person' })));
    await settle();
    expect(find<HTMLTextAreaElement>(host, 'textarea').value).toBe('');
    expect(host.textContent).not.toContain('My private pending goal');
    expect(sessionStorage.getItem(GOAL_HANDOFF)).toBe('My private pending goal');
    expect(calls).toHaveLength(0);
  });
  it('keeps a bounded goal fragment as unconfirmed Explore prefill until explicit send', async () => {
    const words = 'Consider gold with a small budget';
    window.history.replaceState(null, '', `/invest#goal=${encodeURIComponent(words)}`);
    const host = await show();
    expect(current(host)).toBe(en.goal.explore.picker.current);
    expect(find<HTMLTextAreaElement>(host, 'textarea').value).toBe(words);
    expect(sessionStorage.getItem(GOAL_HANDOFF)).toBe(words);
    expect(calls).toHaveLength(0);
    await send(host, words);
    expect(window.location.hash).toBe('');
    expect(sessionStorage.getItem(GOAL_HANDOFF)).toBeNull();
    expect(calls[0].body.messages).toEqual([{ who: 'person', text: words }]);
  });
  it('ignores a continuation the removed guided flow left in the tab', async () => {
    const saved = JSON.stringify({ sheet: { goal: 'income' }, way: 'Aim for $147 a month.' });
    sessionStorage.setItem('tf-invest-way', saved);
    const host = await show();
    await settle();
    expect(host.querySelector('[data-ui="goal-conversation"]')).not.toBeNull();
    expect(host.querySelector('[data-ui="invest-screen"]')).toBeNull();
    expect(find<HTMLTextAreaElement>(host, 'textarea').value).toBe('');
    expect(sessionStorage.getItem('tf-invest-way')).toBe(saved);
    expect(calls).toHaveLength(0);
  });
});

describe('sourced metrics in a strategy preview', () => {
  it.each(['en', 'pt'] as const)(
    'uses actual percentage scales and locale currency (%s)',
    (lang) => {
      expect(sourceValue(lang, 0.03, 'fraction')).toBe(lang === 'en' ? '3%' : '3%');
      expect(sourceValue(lang, 12, 'bps')).toBe(lang === 'en' ? '0.12%' : '0,12%');
      expect(sourceValue(lang, null, 'fraction')).toBe('—');
      expect(sourceValue(lang, 12.5, 'USD')).toContain(lang === 'en' ? '12.50' : '12,50');
    },
  );
});

describe('the relaxed intake’s plan on /invest (RELAXED-INTAKE)', () => {
  const sheet = { goal: 'grow', amountUsd: 2000, chains: ['solana'] };
  const projection = {
    currency: 'USD',
    rate: 0.04,
    step: 1,
    months: [
      { month: '2026-11-01', balance: 2006, earned: 6, withdrawn: 0 },
      { month: '2026-12-01', balance: 2013, earned: 13, withdrawn: 0 },
    ],
    basis: 'Past-rate arithmetic from the sourced yield readings, never a promise.',
    sourceIds: [],
  };
  const answerWith = (extra: Record<string, unknown>) =>
    portStore.setApi(async (url, init) => {
      if (init?.method !== 'POST') return baseApi(url);
      const body = JSON.parse(String(init.body));
      calls.push({ path: url, body });
      return json({ ...response(body.messageId), proposal: { ...preview, ...extra } });
    });

  it('leads to the deposit step only: no "Invest in this plan", and nothing sent to the engine', async () => {
    // a reply from a server that still carries an engine sheet: it is not read, and nothing invests from it
    answerWith({ investSheet: sheet });
    const host = await show();
    await send(host, 'Grow $2,000');
    expect(host.querySelector('[data-action="invest-plan"]')).toBeNull();
    const primary = [
      ...find(host, '[data-ui="goal-strategy"]').querySelectorAll('button[data-variant="primary"]'),
    ];
    expect(primary.map((button) => button.getAttribute('data-action'))).toEqual(['deposit']);
    expect(calls.some((call) => call.path === '/v1/baskets/personalize')).toBe(false);
  });

  it('shows the mix alone when the reply carries no projection, as the model-led conversation’s does', async () => {
    answerWith({});
    const host = await show();
    await send(host, 'Grow $2,000');
    expect(
      find(host, '[data-ui="goal-strategy"]').querySelector('[data-ui="composition"]'),
    ).not.toBeNull();
    expect(host.querySelector('[data-ui="preview-view"]')).toBeNull();
    expect(host.querySelector('[data-ui="projection-chart"]')).toBeNull();
    expect(
      [...host.querySelectorAll('button[data-variant="primary"]')].map((button) =>
        button.getAttribute('data-action'),
      ),
    ).toContain('deposit');
  });

  it('draws the projected months in honey on a chalk baseline, once asked for', async () => {
    answerWith({ projection });
    const host = await show();
    await send(host, 'Grow $2,000 and add monthly');
    const views = find(host, '[data-ui="preview-view"]');
    expect(host.querySelector('[data-ui="projection-chart"]')).toBeNull();
    const monthly = [...views.querySelectorAll('button')].find(
      (button) => button.textContent === en.shared.vault.conversation.view.monthly,
    );
    if (!monthly) throw new Error('no monthly view');
    await click(monthly);
    const chart = find(host, '[data-ui="projection-chart"]');
    expect(monthly.getAttribute('aria-pressed')).toBe('true');
    expect(chart.querySelectorAll('.bg-primary').length).toBeGreaterThanOrEqual(2);
    expect(chart.querySelector('fieldset')?.className).toContain('border-info');
    expect(chart.textContent).toContain(projection.basis);
  });

  it('marks projected figures from a test-network reading as sample, quietly, and live ones not', async () => {
    const openChart = async () => {
      const host = await show();
      await send(host, 'Grow $2,000 and add monthly');
      const monthly = [...find(host, '[data-ui="preview-view"]').querySelectorAll('button')].find(
        (button) => button.textContent === en.shared.vault.conversation.view.monthly,
      );
      if (!monthly) throw new Error('no monthly view');
      await click(monthly);
      return find(host, '[data-ui="projection-chart"]');
    };
    const reading = preview.sources[0];
    if (!reading) throw new Error('no source in the fixture');
    answerWith({ projection: { ...projection, sourceIds: [reading.id] } });
    let chart = await openChart();
    expect(reading.provenance).not.toBe('live');
    expect(chart.querySelector('[data-ui="mock-plate"]')).not.toBeNull();
    expect(chart.textContent).not.toMatch(/MOCK/);
    await unmountAll();
    answerWith({
      projection: { ...projection, sourceIds: [reading.id] },
      sources: [{ ...reading, provenance: 'live' }],
    });
    chart = await openChart();
    expect(chart.querySelector('[data-ui="mock-plate"]')).toBeNull();
  });

  it('lists this conversation and the saved ones in the panel, and opens a new one empty', async () => {
    const host = await show();
    await send(host, 'Consider gold');
    await mode(host, 'new');
    await settle();
    expect(titles(host)).toEqual([en.goal.explore.picker.current, 'Consider gold']);
    expect(find(host, '[data-ui="goal-transcript"]').textContent).toBe('');
  });

  // Thom, Oct 9: a conversation is named by its person's first request, shortened (title.ts), read
  // from its own turns in this browser.
  const named = titles;
  const keep = (id: string, words: string[]) =>
    localStorage.setItem(
      `${goalConversationKey(userId, 'solana', 'sandbox')}:c:${id}`,
      JSON.stringify({
        revision: 0,
        transcript: words.map((text, i) => ({
          id: `${id}-${i}`,
          who: i % 2 ? 'app' : 'person',
          text,
        })),
      }),
    );
  const list = (items: { id: string; title: string; updatedAt: string }[], current = 'now') =>
    localStorage.setItem(
      `${goalConversationKey(userId, 'solana', 'sandbox')}:index`,
      JSON.stringify({ current, items }),
    );

  it('names the conversation on screen by the first request once it is sent, and again after a reload', async () => {
    const words =
      "I want to explore technology stocks\nwith low risk for my daughter's college fund";
    const title = 'I want to explore technology stocks with low…';
    let host = await show();
    await settle();
    // before any message: the neutral name, in the panel named by its label
    expect(named(host)).toEqual([en.goal.explore.picker.current]);
    expect(en.goal.explore.picker.current).toBe('New conversation');
    expect(find(rail(host), 'nav').getAttribute('aria-label')).toBe(en.goal.explore.picker.label);
    await send(host, words);
    await unfold(host);
    expect(named(host)).toEqual([title]);
    expect(current(host)).toBe(title);
    // a later message does not rename it
    await send(host, 'Less gold please');
    expect(named(host)[0]).toBe(title);
    // nothing new was sent for it: the reply route only, with the fields it had
    expect(calls.map((row) => row.path)).toEqual([path, path]);
    expect(calls.every((row) => !('title' in row.body) && !('name' in row.body))).toBe(true);
    await unmountAll();
    host = await show();
    await settle();
    await unfold(host);
    expect(named(host)).toEqual([title]);
    // a new one is neutral again, and the first is saved under its name
    await mode(host, 'new');
    await settle();
    expect(named(host)).toEqual([en.goal.explore.picker.current, title]);
  });

  it('names a conversation saved before by its first request, and one without messages neutrally', async () => {
    // saved by an earlier build: no index at all, then one whose index title was cut mid-word
    keep('old1', [
      'Build an income strategy from bonds and dividend funds for my retirement',
      'Ok.',
    ]);
    keep('old2', ['Protect my savings']);
    list([
      {
        id: 'old1',
        title: 'Build an income strategy from bonds and dividend funds for my r…',
        updatedAt: '2026-10-08T12:00:00.000Z',
      },
      { id: 'old2', title: '', updatedAt: '' },
      // listed, with a title on the index, but no message kept: neutral, never the index's words
      { id: 'empty', title: 'Words that are not kept', updatedAt: '2026-10-08T13:00:00.000Z' },
    ]);
    const host = await show();
    await settle();
    // newest first; one with no time says nothing of when, and comes last
    expect(named(host)).toEqual([
      en.goal.explore.picker.current,
      en.goal.explore.picker.untitled,
      'Build an income strategy from bonds and dividend…',
      'Protect my savings',
    ]);
    expect(row(host, 'Protect my savings').querySelector('time')).toBeNull();
    // opened, it is the one on screen under the same name
    await mode(host, 'conversation:solana:old1');
    await settle();
    expect(current(host)).toBe('Build an income strategy from bonds and dividend…');
    expect(find(host, '[data-ui="goal-transcript"]').textContent).toContain('for my retirement');
  });

  it('tells two saved conversations with the same first words apart by when they were written', async () => {
    keep('a1', ['Consider gold']);
    keep('a2', ['Consider gold']);
    keep('a3', ['Consider silver']);
    list([
      { id: 'a1', title: 'Consider gold', updatedAt: '2026-10-08T12:00:00.000Z' },
      { id: 'a2', title: 'Consider gold', updatedAt: '2026-10-06T09:30:00.000Z' },
      { id: 'a3', title: 'Consider silver', updatedAt: '2026-10-07T09:30:00.000Z' },
    ]);
    const host = await show();
    await settle();
    expect(named(host)).toEqual([
      en.goal.explore.picker.current,
      'Consider gold',
      'Consider silver',
      'Consider gold',
    ]);
    // each row says when it was written, in a time a machine reads too
    const times = [
      ...rail(host).querySelectorAll<HTMLTimeElement>('[data-ui="conversation-row"] time'),
    ].map((time) => time.dateTime);
    expect(times).toEqual([
      '2026-10-08T12:00:00.000Z',
      '2026-10-07T09:30:00.000Z',
      '2026-10-06T09:30:00.000Z',
    ]);
  });

  it('shows the name as the text it is, and is neutral again once the conversation is started over', async () => {
    const words = '<img src=x onerror=alert(1)> gold';
    const host = await show();
    await send(host, words);
    await unfold(host);
    const [first] = rail(host).querySelectorAll('[data-ui="conversation-title"]');
    expect(first?.textContent).toBe(words);
    expect(first?.children).toHaveLength(0);
    expect(host.querySelector('img[src="x"]')).toBeNull();
    const again = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === en.talk.startOver,
    );
    if (!again) throw new Error('no start over');
    await click(again);
    await settle();
    expect(find(host, '[data-ui="goal-transcript"]').textContent).toBe('');
    expect(named(host)).toEqual([en.goal.explore.picker.current]);
    // left for a new one, it is not kept as a saved conversation with nothing in it, now or later
    await mode(host, 'new');
    await settle();
    expect(named(host)).toEqual([en.goal.explore.picker.current]);
    await unmountAll();
    expect(named(await show())).toEqual([en.goal.explore.picker.current]);
  });
});
