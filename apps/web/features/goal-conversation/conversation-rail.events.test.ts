// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, press, settle, type, unmountAll } from '../../components/ui/test/dom';
import { dictionary, type Lang } from '../../i18n';
import { withAccount } from '../account/test/screen';
import { chainOf, portfolioBody, VAULT, vault } from '../portfolio/test/portfolio';
import { plans } from '../portfolio-section/test/fixtures';
import { shortAddress } from '../shared/use-person';
import { json, PHANTOM, signedInPort } from '../wallet/test/fake-port';
import { portStore } from '../wallet/test/mock-provider';
import { goalConversationKey } from './GoalConversation';
import { GoalHome } from './GoalHome';
import { current, open, openNew, rail, row, titles, unfold } from './test/rail';

// The conversations panel of /invest (Thom, Oct 14, in place of the picker): the drafts kept in this
// browser and the person's vaults, newest first by day; a vault named by its goal with its value
// and pin, never by its address; a draft renamed or deleted in its row; a search over many; the
// arrow keys between rows; a rail that closes and remembers it; a sheet on a phone.

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));

const en = dictionary('en');
const w = en.goal.explore.picker;
const userId = 'did:privy:rail';
const person = {
  userId,
  wallets: PHANTOM,
  chain: 'solana',
  chainSource: 'wallet',
  chainOptions: [],
};
const answer = plans();
const listed = answer.chains.flatMap((entry) => entry.plans);
const GROW_PLAN = '3c1f9a7e-5b2d-4c8e-9f0a-1b2c3d4e5f60';

const base = () => goalConversationKey(userId, 'solana', 'sandbox');
/** A draft kept in this browser, with its person's first words, and its entry in the index. */
function keep(items: { id: string; words: string; at: string; name?: string; planId?: string }[]) {
  for (const item of items)
    localStorage.setItem(
      `${base()}:c:${item.id}`,
      JSON.stringify({
        revision: 0,
        transcript: [{ id: `${item.id}-0`, who: 'person', text: item.words }],
      }),
    );
  localStorage.setItem(
    `${base()}:index`,
    JSON.stringify({
      current: 'now',
      items: items.map(({ id, at, name, planId }) => ({
        id,
        title: '',
        updatedAt: at,
        ...(name ? { name } : {}),
        ...(planId ? { planId } : {}),
      })),
    }),
  );
}
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const show = (lang: Lang = 'en') => mount(withAccount(lang, createElement(GoalHome)));
const groups = (host: HTMLElement) =>
  [...rail(host).querySelectorAll<HTMLElement>('[data-ui="conversation-group"]')].map(
    (group) =>
      `${group.dataset.group}: ${[...group.querySelectorAll('[data-ui="conversation-title"]')]
        .map((title) => title.textContent)
        .join(' | ')}`,
  );

let served = answer as unknown;
let portfolio: unknown = null;
beforeEach(() => {
  window.history.replaceState(null, '', '/invest');
  localStorage.clear();
  sessionStorage.clear();
  served = answer;
  portfolio = null;
  portStore.set(signedInPort(PHANTOM, { userId }));
  portStore.setApi(async (url) => {
    if (url === '/v1/me') return json(person);
    if (url === '/v1/portfolio/plans') return json(served);
    if (url === '/v1/portfolio' && portfolio) return json(portfolio);
    return json({}, 404);
  });
});
afterEach(unmountAll);

describe('the conversations panel', () => {
  it('lists the drafts and the vaults by day, newest first, the one on screen marked', async () => {
    keep([
      { id: 'd1', words: 'Consider gold', at: ago(0) },
      { id: 'd2', words: 'Earn a monthly income', at: ago(1) },
      { id: 'd3', words: 'Protect my savings', at: ago(40) },
    ]);
    const host = await show();
    await settle();
    const [today, yesterday, earlier] = groups(host);
    expect(today).toBe(`today: ${w.current} | Consider gold`);
    expect(yesterday).toBe('yesterday: Earn a monthly income');
    expect(earlier?.startsWith('earlier: ')).toBe(true);
    // the one on screen is marked, for the eye and for a reader
    const here = find(row(host, w.current), '[data-ui="conversation-open"]');
    // said once: by `aria-current`; the words hidden after its name are its chain (and how long ago,
    // once it has words), what the sidebar's tooltip says, never that it is on screen
    expect(here.getAttribute('aria-current')).toBe('true');
    expect(here.querySelector('.sr-only')?.textContent).toMatch(/^, Solana(, .+)?$/);
    expect(here.getAttribute('title')).toBe(`${w.current} · Solana`);
    // every vault the plans read lists is a row, each linking to its own page
    const vaults = [
      ...rail(host).querySelectorAll<HTMLElement>(
        '[data-ui="conversation-row"][data-kind="vault"]',
      ),
    ];
    expect(vaults.map((one) => one.dataset.address).sort()).toEqual(
      listed.map((plan) => plan.address).sort(),
    );
    for (const one of vaults) {
      const link = find(one, '[data-ui="conversation-open"]');
      expect(link.getAttribute('href')).toBe(
        `/portfolio/vaults/${one.dataset.chain}/${encodeURIComponent(one.dataset.address ?? '')}`,
      );
      expect(link.getAttribute('aria-label')).toBe(
        w.openVault(find(one, '[data-ui="conversation-title"]').textContent ?? ''),
      );
      // named by its goal or its name, never by its address
      expect(one.textContent).not.toContain(one.dataset.address ?? '');
    }
    // the sidebar's row is one line and draws no figure; the sheet's shows a vault's value, with its
    // pin, where it has a newest read
    const read = listed.filter((plan) => plan.newest);
    expect(read.length).toBeGreaterThan(0);
    expect(rail(host).querySelector('[data-ui="conversation-value"]')).toBeNull();
    await click(find(host, '[data-ui="conversations-open"]'));
    const sheet = find(host, '[data-ui="conversations-sheet"]');
    for (const plan of read) {
      const one = sheet.querySelector<HTMLElement>(
        `[data-ui="conversation-row"][data-address="${plan.address}"]`,
      );
      const value = one?.querySelector('[data-ui="conversation-value"]');
      expect(value?.querySelector('[data-ui="pin"]')).not.toBeNull();
    }
    await click(find(sheet, '[data-ui="conversations-close"]'));
    // the grow vault reads as the overview names it
    expect(titles(host)).toContain('Grow $2,000 over 36 months.');
  });

  it('lists a draft a deposit went from as the vault that deposit opened, once', async () => {
    keep([
      { id: 'went', words: 'Grow two thousand', at: ago(0), planId: GROW_PLAN },
      { id: 'kept', words: 'Consider gold', at: ago(0) },
    ]);
    const host = await show();
    await settle();
    expect(titles(host)).not.toContain('Grow two thousand');
    expect(titles(host)).toContain('Consider gold');
    // the vault stands for it, at the draft's newer time
    const grow = listed.find((plan) => plan.plan?.proposalId === GROW_PLAN);
    const group = rail(host).querySelector(
      `[data-ui="conversation-group"][data-group="today"] [data-address="${grow?.address}"]`,
    );
    expect(group).not.toBeNull();
  });

  it('renames a draft in its row, keeps the name, and gives up on Escape', async () => {
    keep([{ id: 'd1', words: 'Consider gold', at: ago(0) }]);
    const host = await show();
    await settle();
    await click(find(row(host, 'Consider gold'), '[data-ui="conversation-rename"]'));
    const field = find<HTMLInputElement>(rail(host), '[data-ui="conversation-name"] input');
    expect(field.value).toBe('Consider gold');
    expect(document.activeElement).toBe(field);
    await type(field, 'Gold for later');
    await click(find(rail(host), '[data-ui="conversation-name-save"]'));
    expect(titles(host)).toContain('Gold for later');
    expect(localStorage.getItem(`${base()}:index`)).toContain('"name":"Gold for later"');
    // focus goes back to the row's name
    await settle();
    expect(document.activeElement).toBe(
      find(row(host, 'Gold for later'), '[data-ui="conversation-open"]'),
    );
    // Escape leaves the name as it was
    await click(find(row(host, 'Gold for later'), '[data-ui="conversation-rename"]'));
    const again = find<HTMLInputElement>(rail(host), '[data-ui="conversation-name"] input');
    await type(again, 'Something else');
    await press(again, 'Escape');
    expect(titles(host)).toContain('Gold for later');
    expect(titles(host)).not.toContain('Something else');
    // the name given stays after the page is opened again
    await unmountAll();
    expect(titles(await show())).toContain('Gold for later');
  });

  it('deletes a draft after asking, says so, and keeps it on "Keep"', async () => {
    keep([
      { id: 'd1', words: 'Consider gold', at: ago(0) },
      { id: 'd2', words: 'Protect my savings', at: ago(0) },
    ]);
    const host = await show();
    await settle();
    await click(find(row(host, 'Consider gold'), '[data-ui="conversation-delete"]'));
    expect(find(rail(host), '[data-ui="conversation-confirm"]').textContent).toBe(w.confirm);
    // the safe answer has the focus
    expect(document.activeElement).toBe(find(rail(host), '[data-ui="conversation-delete-keep"]'));
    await click(find(rail(host), '[data-ui="conversation-delete-keep"]'));
    expect(titles(host)).toContain('Consider gold');
    await click(find(row(host, 'Consider gold'), '[data-ui="conversation-delete"]'));
    await click(find(rail(host), '[data-ui="conversation-delete-yes"]'));
    expect(titles(host)).not.toContain('Consider gold');
    // said on the page, where it outlives the row and the sheet
    expect(find(host, '[data-ui="goal-chain-said"]').textContent).toBe(w.removed('Consider gold'));
    // the focus goes to the row now in its place
    expect(document.activeElement).toBe(
      find(row(host, 'Protect my savings'), '[data-ui="conversation-open"]'),
    );
    expect(localStorage.getItem(`${base()}:c:d1`)).toBeNull();
    expect(localStorage.getItem(`${base()}:c:d2`)).not.toBeNull();
    await unmountAll();
    expect(titles(await show())).not.toContain('Consider gold');
  });

  it('deletes the one on screen and opens a new, empty one in its place', async () => {
    keep([{ id: 'd1', words: 'Consider gold', at: ago(0) }]);
    const host = await show();
    await settle();
    await open(host, 'Consider gold');
    await settle();
    expect(current(host)).toBe('Consider gold');
    await click(find(row(host, 'Consider gold'), '[data-ui="conversation-delete"]'));
    await click(find(rail(host), '[data-ui="conversation-delete-yes"]'));
    await settle();
    expect(current(host)).toBe(w.current);
    expect(find(host, '[data-ui="goal-transcript"]').textContent).toBe('');
  });

  it('a vault has no rename or delete: it is not a draft of this browser', async () => {
    const host = await show();
    await settle();
    const vaults = rail(host).querySelectorAll('[data-ui="conversation-row"][data-kind="vault"]');
    expect(vaults.length).toBeGreaterThan(0);
    for (const vault of vaults) {
      expect(vault.querySelector('[data-ui="conversation-rename"]')).toBeNull();
      expect(vault.querySelector('[data-ui="conversation-delete"]')).toBeNull();
    }
  });

  it('searches the names, in the sheet once there are more than eight, and says when nothing matches', async () => {
    served = { ...answer, chains: [] };
    keep(
      Array.from({ length: 7 }, (_, i) => ({ id: `d${i}`, words: `Idea number ${i}`, at: ago(i) })),
    );
    let host = await show();
    await settle();
    // the one on screen and seven: eight rows, and the sheet has no search; the sidebar always has one
    expect(titles(host)).toHaveLength(8);
    expect(rail(host).querySelector('[data-ui="conversation-search"]')).not.toBeNull();
    await click(find(host, '[data-ui="conversations-open"]'));
    expect(
      find(host, '[data-ui="conversations-sheet"]').querySelector(
        '[data-ui="conversation-search"]',
      ),
    ).toBeNull();
    await unmountAll();
    keep([
      ...Array.from({ length: 7 }, (_, i) => ({
        id: `d${i}`,
        words: `Idea number ${i}`,
        at: ago(i),
      })),
      { id: 'gold', words: 'Consider gold', at: ago(0) },
    ]);
    host = await show();
    await settle();
    const search = find<HTMLInputElement>(rail(host), '[data-ui="conversation-search"] input');
    expect(search.type).toBe('search');
    expect(rail(host).querySelector(`label[for="${search.id}"]`)?.textContent).toBe(w.search);
    await type(search, 'GOLD');
    expect(titles(host)).toEqual(['Consider gold']);
    await type(search, 'silver');
    expect(titles(host)).toEqual([]);
    expect(find(rail(host), '[data-ui="conversation-no-match"]').textContent).toBe(
      w.noMatch('silver'),
    );
    await type(search, '');
    expect(titles(host)).toHaveLength(9);
  });

  it('moves between rows with the arrow keys, Home and End', async () => {
    served = { ...answer, chains: [] };
    keep([
      { id: 'd1', words: 'First', at: ago(0) },
      { id: 'd2', words: 'Second', at: ago(1) },
    ]);
    const host = await show();
    await settle();
    const names = () => [
      ...rail(host).querySelectorAll<HTMLElement>('[data-ui="conversation-open"]'),
    ];
    const [a, b, c] = names();
    a?.focus();
    await press(a as HTMLElement, 'ArrowDown');
    expect(document.activeElement).toBe(b);
    await press(b as HTMLElement, 'End');
    expect(document.activeElement).toBe(c);
    await press(c as HTMLElement, 'ArrowDown');
    expect(document.activeElement).toBe(c);
    await press(c as HTMLElement, 'Home');
    expect(document.activeElement).toBe(a);
    await press(a as HTMLElement, 'ArrowUp');
    expect(document.activeElement).toBe(a);
  });

  // Thom, Oct 15: "more like the claude sidebar"
  it('is a sidebar of one-line rows: the chain’s mark and the name, the rest in its tooltip', async () => {
    keep([{ id: 'd1', words: 'Consider gold', at: ago(1) }]);
    const host = await show();
    await settle();
    const gold = row(host, 'Consider gold');
    const name = find(gold, '[data-ui="conversation-open"]');
    expect(find(name, '[data-ui="chain-logo"]').getAttribute('aria-hidden')).toBe('true');
    expect(name.getAttribute('title')).toBe(
      `Consider gold · Solana · ${en.goal.explore.picker.groups.yesterday.toLowerCase()}`,
    );
    // no badge and no time drawn on the row: a reader hears them after the name
    expect(gold.querySelector('[data-ui="chain-badge"]')).toBeNull();
    expect(find(name, '.sr-only').textContent).toBe(`, Solana, ${find(name, 'time').textContent}`);
    // a vault says it is one, in its tooltip and to a reader, and draws no value
    const vault = rail(host).querySelector<HTMLElement>(
      '[data-ui="conversation-row"][data-kind="vault"]',
    );
    const link = find(vault as HTMLElement, '[data-ui="conversation-open"]');
    expect(link.getAttribute('title')?.startsWith(`${w.vault} · `)).toBe(true);
    expect(
      (vault as HTMLElement).querySelector('[data-ui="conversation-value"], [data-ui="pin"]'),
    ).toBeNull();
    // "New conversation" and the search at the top, the search there with a few rows
    expect(find(rail(host), 'button[data-ui="conversation-new"]').textContent).toBe(w.fresh);
    expect(
      find(rail(host), '[data-ui="conversation-search"] input').getAttribute('placeholder'),
    ).toBe(w.search);
  });

  it('folds to a strip of three: the toggle, "New conversation", and the search, which opens it', async () => {
    const host = await show();
    await settle();
    const toggle = find(rail(host), '[data-ui="conversations-toggle"]');
    await click(toggle);
    const strip = [...rail(host).querySelectorAll('button')].map((one) =>
      one.getAttribute('aria-label'),
    );
    expect(strip).toEqual([w.show, w.fresh, w.search]);
    await click(find(rail(host), '[data-ui="conversations-seek"]'));
    await settle();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(find(rail(host), '[data-ui="conversation-search"] input'));
    expect(localStorage.getItem('tf-conversations-closed')).toBe('0');
  });

  it('closes to a strip with "New conversation" and remembers it in this browser', async () => {
    const host = await show();
    await settle();
    const toggle = find(rail(host), '[data-ui="conversations-toggle"]');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toBe(w.hide);
    await click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-label')).toBe(w.show);
    expect(rail(host).querySelector('[data-ui="conversation-row"]')).toBeNull();
    expect(find(rail(host), '[data-ui="conversation-new"]').getAttribute('aria-label')).toBe(
      w.fresh,
    );
    expect(localStorage.getItem('tf-conversations-closed')).toBe('1');
    await unmountAll();
    const again = await show();
    await settle();
    expect(rail(again).getAttribute('data-closed')).toBe('true');
  });

  // Thom, Oct 15: under 1440px a draft beside the chat would leave it too narrow with the rail open
  it('folds to its strip while a draft is beside the chat, and stays open once opened again, as drafts are opened from it', async () => {
    portStore.setApi(async (url, init) => {
      if (url === '/v1/me') return json(person);
      if (url === '/v1/portfolio/plans') return json(served);
      if (init?.method === 'POST')
        return json({
          version: 1,
          chain: 'solana',
          messageId: JSON.parse(String(init.body)).messageId,
          message: 'Noted.',
          question: null,
          proposal: null,
        });
      return json({}, 404);
    });
    const say = async (host: HTMLElement, words: string) => {
      await type(find<HTMLTextAreaElement>(host, 'textarea'), words);
      await click(find(host, '[data-ui="composer-send"]'));
      await settle();
    };
    const toggle = (host: HTMLElement) => find(rail(host), '[data-ui="conversations-toggle"]');
    const expanded = (host: HTMLElement) => toggle(host).getAttribute('aria-expanded');
    const host = await show();
    await settle();
    // no draft yet: the rail is as the person left it
    expect(expanded(host)).toBe('true');
    await say(host, 'Consider gold');
    expect(expanded(host)).toBe('false');
    expect(rail(host).getAttribute('data-closed')).toBe('true');
    // opened again, it stays open for this conversation, and nothing is remembered as closed
    await click(toggle(host));
    expect(expanded(host)).toBe('true');
    await say(host, 'And some cash');
    expect(expanded(host)).toBe('true');
    expect(localStorage.getItem('tf-conversations-closed')).toBe('0');
    // a new conversation has no draft beside it, and the next draft folds the rail again
    await openNew(host);
    await settle();
    expect(expanded(host)).toBe('true');
    await say(host, 'Earn an income');
    expect(expanded(host)).toBe('false');
    // opened to browse, it stays open as another draft is opened from it, and the one after that
    // (the team lead, Oct 15: never folded under the person's cursor)
    await click(toggle(host));
    await click(find(row(host, 'Consider gold'), '[data-ui="conversation-open"]'));
    await settle();
    expect(expanded(host)).toBe('true');
    expect(current(host)).toBe('Consider gold');
    await click(find(row(host, 'Earn an income'), '[data-ui="conversation-open"]'));
    await settle();
    expect(expanded(host)).toBe('true');
    expect(current(host)).toBe('Earn an income');
    // "Start over" leaves no draft on screen, so the next draft folds it again
    await click(
      [...host.querySelectorAll('button')].find(
        (button) => button.textContent === en.talk.startOver,
      ) as HTMLElement,
    );
    await settle();
    expect(expanded(host)).toBe('true');
    // open only because there was no draft, it folds as a draft is opened from it (the team lead,
    // Oct 15: only the person's own opening on this visit keeps it open)
    await click(find(row(host, 'Consider gold'), '[data-ui="conversation-open"]'));
    await settle();
    expect(expanded(host)).toBe('false');
    // a new conversation, and its first draft folds it again
    await openNew(host);
    await settle();
    expect(expanded(host)).toBe('true');
    await say(host, 'Protect my savings');
    expect(expanded(host)).toBe('false');
  });

  // Thom, Oct 15, at about 1975px: a conversation with a draft from yesterday, the rail left open on
  // an earlier visit, and the rail stayed open beside the draft
  it('folds beside a draft read back on a return, whatever an earlier visit kept', async () => {
    keep([{ id: 'd1', words: 'Consider gold', at: ago(1) }]);
    const index = JSON.parse(localStorage.getItem(`${base()}:index`) ?? '{}');
    localStorage.setItem(`${base()}:index`, JSON.stringify({ ...index, current: 'd1' }));
    localStorage.setItem('tf-conversations-closed', '0');
    const host = await show();
    await settle();
    expect(find(host, '[data-ui="goal-transcript"]').textContent).toContain('Consider gold');
    const toggle = find(rail(host), '[data-ui="conversations-toggle"]');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(rail(host).getAttribute('data-closed')).toBe('true');
    // the earlier visit's choice is left as it was: folding is not the person's closing
    expect(localStorage.getItem('tf-conversations-closed')).toBe('0');
    // opened on this visit, it stays open
    await click(toggle);
    await settle();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(current(host)).toBe('Consider gold');
  });

  it('on a phone, opens as a sheet from a button that names the one on screen, and closes when one is chosen', async () => {
    keep([{ id: 'd1', words: 'Consider gold', at: ago(0) }]);
    const host = await show();
    await settle();
    const opener = find(host, '[data-ui="conversations-open"]');
    expect(opener.textContent).toContain(w.label);
    expect(opener.textContent).toContain(w.current);
    expect(opener.getAttribute('aria-haspopup')).toBe('dialog');
    await click(opener);
    const sheet = find<HTMLDialogElement>(host, '[data-ui="conversations-sheet"]');
    expect(sheet.open).toBe(true);
    expect(sheet.getAttribute('aria-label')).toBe(w.label);
    const gold = [...sheet.querySelectorAll('[data-ui="conversation-row"]')].find(
      (one) => one.querySelector('[data-ui="conversation-title"]')?.textContent === 'Consider gold',
    );
    await click(find(gold as Element, '[data-ui="conversation-open"]'));
    await settle();
    // the title row it sits in is drawn again for the conversation chosen: the sheet is closed there
    const again = () => find<HTMLDialogElement>(host, '[data-ui="conversations-sheet"]');
    expect(again().open).toBe(false);
    await unfold(host);
    expect(current(host)).toBe('Consider gold');
    // and "Close" closes it, with the focus back on the button
    const button = find(host, '[data-ui="conversations-open"]');
    await click(button);
    expect(again().open).toBe(true);
    await click(find(again(), '[data-ui="conversations-close"]'));
    expect(again().open).toBe(false);
    expect(document.activeElement).toBe(button);
  });

  it('starts a new conversation from the panel, and lists the one before under its first words', async () => {
    served = { ...answer, chains: [] };
    const host = await show();
    await settle();
    portStore.setApi(async (url, init) => {
      if (url === '/v1/me') return json(person);
      if (url === '/v1/portfolio/plans') return json(served);
      if (init?.method === 'POST')
        return json({
          version: 1,
          chain: 'solana',
          messageId: JSON.parse(String(init.body)).messageId,
          message: 'Noted.',
          question: null,
          proposal: null,
        });
      return json({}, 404);
    });
    await type(find<HTMLTextAreaElement>(host, 'textarea'), 'Consider gold');
    await click(find(host, '[data-ui="composer-send"]'));
    await settle();
    await unfold(host);
    expect(current(host)).toBe('Consider gold');
    await openNew(host);
    await settle();
    expect(titles(host)).toEqual([w.current, 'Consider gold']);
    expect(find(host, '[data-ui="goal-transcript"]').textContent).toBe('');
  });

  it('after the last draft is deleted, the focus goes to "New conversation"', async () => {
    served = { ...answer, chains: [] };
    keep([{ id: 'd1', words: 'Consider gold', at: ago(0) }]);
    const host = await show();
    await settle();
    await click(find(row(host, 'Consider gold'), '[data-ui="conversation-delete"]'));
    await click(find(rail(host), '[data-ui="conversation-delete-yes"]'));
    await settle();
    // the one on screen is a new one with no words, and has no row's name to take the focus
    expect(document.activeElement).toBe(
      find(row(host, w.current), '[data-ui="conversation-open"]'),
    );
  });

  it('in the sheet, deleting the one on screen gives the focus back to the sheet’s button, and says it', async () => {
    keep([{ id: 'd1', words: 'Consider gold', at: ago(0) }]);
    const host = await show();
    await settle();
    await open(host, 'Consider gold');
    await settle();
    await click(find(host, '[data-ui="conversations-open"]'));
    const sheet = find(host, '[data-ui="conversations-sheet"]');
    const gold = [...sheet.querySelectorAll<HTMLElement>('[data-ui="conversation-row"]')].find(
      (one) => one.querySelector('[data-ui="conversation-title"]')?.textContent === 'Consider gold',
    ) as HTMLElement;
    await click(find(gold, '[data-ui="conversation-delete"]'));
    await click(find(gold, '[data-ui="conversation-delete-yes"]'));
    await settle();
    expect(current(host)).toBe(w.current);
    expect(find(host, '[data-ui="goal-chain-said"]').textContent).toBe(w.removed('Consider gold'));
    expect(find<HTMLDialogElement>(host, '[data-ui="conversations-sheet"]').open).toBe(false);
    expect(document.activeElement).toBe(find(host, '[data-ui="conversations-open"]'));
  });

  it('has nothing to rename or delete on a new conversation with no words yet', async () => {
    const host = await show();
    await settle();
    const fresh = row(host, w.current);
    expect(fresh.querySelector('[data-ui="conversation-rename"]')).toBeNull();
    expect(fresh.querySelector('[data-ui="conversation-delete"]')).toBeNull();
  });

  it('moves to the next row from a row’s rename or delete, not to the first', async () => {
    served = { ...answer, chains: [] };
    keep([
      { id: 'd1', words: 'First', at: ago(0) },
      { id: 'd2', words: 'Second', at: ago(1) },
    ]);
    const host = await show();
    await settle();
    const rename = find<HTMLButtonElement>(row(host, 'First'), '[data-ui="conversation-rename"]');
    rename.focus();
    await press(rename, 'ArrowDown');
    expect(document.activeElement).toBe(find(row(host, 'Second'), '[data-ui="conversation-open"]'));
    const remove = find<HTMLButtonElement>(row(host, 'Second'), '[data-ui="conversation-delete"]');
    remove.focus();
    await press(remove, 'ArrowUp');
    expect(document.activeElement).toBe(find(row(host, 'First'), '[data-ui="conversation-open"]'));
  });

  it('is one navigation, with no landmark for each day', async () => {
    const host = await show();
    await settle();
    expect(rail(host).tagName).not.toBe('ASIDE');
    expect(rail(host).querySelectorAll('nav')).toHaveLength(1);
    expect(rail(host).querySelectorAll('section, [role="region"]')).toHaveLength(0);
  });

  it('names a vault with no name and no goal by its chain, in Portuguese too, and never by its address', async () => {
    served = { ...answer, chains: [] };
    portfolio = portfolioBody(chainOf([vault({ name: null })]));
    for (const lang of ['en', 'pt'] as const) {
      const host = await show(lang);
      await settle();
      const one = find(rail(host), '[data-ui="conversation-row"][data-kind="vault"]');
      const title = find(one, '[data-ui="conversation-title"]').textContent ?? '';
      const t = dictionary(lang);
      expect([
        t.portfolio.actions.unnamed('Solana devnet'),
        t.portfolio.actions.unnamed(t.chain.names.solana),
      ]).toContain(title.replace(/^Vault #\d+$|^Cofre #\d+$/, title));
      expect(one.textContent).not.toContain(VAULT);
      expect(one.textContent).not.toContain(shortAddress(VAULT));
      await unmountAll();
    }
  });

  it('speaks Portuguese', async () => {
    const pt = dictionary('pt').goal.explore.picker;
    keep([{ id: 'd1', words: 'Considerar ouro', at: ago(1) }]);
    const host = await show('pt');
    await settle();
    expect(find(rail(host), 'nav').getAttribute('aria-label')).toBe(pt.label);
    expect(groups(host)[1]).toBe(`yesterday: Considerar ouro`);
    expect(find(row(host, 'Considerar ouro'), 'time').textContent).toBe('ontem');
    expect(find(rail(host), '[data-ui="conversation-new"]').textContent).toBe(pt.fresh);
    expect(
      find(row(host, 'Considerar ouro'), '[data-ui="conversation-rename"]').getAttribute(
        'aria-label',
      ),
    ).toBe(pt.rename('Considerar ouro'));
    await act(async () => {});
  });
});
