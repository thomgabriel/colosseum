// @vitest-environment happy-dom
import type { MixReview } from '@colosseum/schemas';
import { vaultOf } from '@colosseum/sdk';
import { act, createElement, StrictMode, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, fire, mount, settle, type, unmountAll } from '../../components/ui/test/dom';
import { dictionary } from '../../i18n';
import { withAccount } from '../account/test/screen';
import { announceOrderDone } from '../order/order-done';
import { recallOrder } from '../order/order-record';
import { deploymentsFor } from '../order/readiness';
import { retargetOrder } from '../shared/test/fixtures';
import { VaultScreen } from '../shared/VaultScreen';
import { reply, read as sample } from '../vault-conversation/test/fixtures';
import { VaultConversation } from '../vault-conversation/VaultConversation';
import { EMBEDDED, json, signedInPort } from '../wallet/test/fake-port';
import { router } from '../wallet/test/mock-next';
import { portStore } from '../wallet/test/mock-provider';
import { CHECK_MS, DepositStep, type Purpose } from './DepositStep';

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));
vi.mock('../wallet/signing', () => import('../wallet/test/mock-signing'));

// Gate ANY-COMPOSITION (#191): a preview says how its weights were set and what to watch, and leads to
// the server's review, where every warning is ticked before the confirm sends the review's hash.

const userId = 'did:privy:test';
// The vault this app derives from its owner and plan number, as the guard does: the one a retarget
// may name.
const deployment = deploymentsFor('solana', false)?.solana;
if (!deployment) throw new Error('a test-network deployment is committed for Solana');
const derived = vaultOf(deployment, sample.vault.owner, sample.vault.basketId);
if (!derived) throw new Error('the sample vault derives');
const read = { ...sample, vault: { ...sample.vault, address: derived } };
const en = dictionary('en');
const hash = 'ab'.repeat(32);
const figure = {
  label: 'Measured exit capacity',
  value: 12,
  unit: 'USD' as const,
  source: 'fixture exit read',
  fetchedAt: '2026-10-05T12:00:00.000Z',
  method: 'test measured exit',
  provenance: 'sandbox' as const,
};
const reviewOf = (over: Partial<MixReview> = {}): MixReview => ({
  chain: 'solana',
  origin: 'model',
  goal: null,
  amountUsd: 100,
  lines: [
    {
      assetId: 'solana:usdc',
      symbol: 'USDC',
      cls: 'cash',
      weightBps: 6000,
      amountUsd: 60,
      price: null,
      exitCeiling: null,
    },
    {
      assetId: 'solana:gldx',
      symbol: 'tGLDx',
      cls: 'gold',
      weightBps: 4000,
      amountUsd: 40,
      price: {
        usdPerToken: '20',
        source: 'fixture price',
        fetchedAt: '2026-10-05T12:00:00.000Z',
        method: 'test price',
        provenance: 'sandbox',
      },
      exitCeiling: {
        usd: 12,
        measured: true,
        source: 'fixture exit read',
        fetchedAt: '2026-10-05T12:00:00.000Z',
        method: 'test measured exit',
        provenance: 'sandbox',
      },
    },
  ],
  targets: [{ asset: 'solana:gldx', weightBps: 4000 }],
  cashBps: 6000,
  warnings: [
    {
      id: 'EXIT_OVER_CAPACITY:solana:gldx',
      code: 'EXIT_OVER_CAPACITY',
      assetId: 'solana:gldx',
      text: 'tGLDx is larger than its measured exit can sell as planned.',
      figures: [figure],
    },
  ],
  unconfirmed: ['EXIT_OVER_CAPACITY:solana:gldx'],
  reviewHash: hash,
  provenance: 'sandbox',
  disclaimer: 'Test disclaimer',
  ...over,
});
const answer = {
  ...reply,
  address: derived,
  proposal: {
    ...reply.proposal,
    sources: [
      ...reply.proposal.sources,
      { ...figure, id: 'liquidity:solana:gldx', assetId: 'solana:gldx' },
    ],
  },
  warnings: [
    { code: 'over_exit_capacity', assetId: 'solana:gldx', evidenceId: 'liquidity:solana:gldx' },
  ],
  weightNotes: [
    { code: 'stated', assetIds: ['solana:gldx'], quote: '40% gold' },
    { code: 'equal_split', assetIds: ['solana:usdc'] },
    { code: 'share_unread', assetIds: [], quote: 'mostly safe' },
    { code: 'share_withdrawn', assetIds: [], quote: '70% TSLA' },
  ],
};

/** A review of the lines sent, as the server reads them back: its targets and cash are those lines. */
const reviewFor = (
  sent: { assetId: string; weightBps: number }[],
  over: Partial<MixReview> = {},
): MixReview => {
  const lines = sent.map((line) => {
    const sample = reviewOf().lines.find((l) => l.assetId === line.assetId);
    if (!sample) throw new Error(`no sample line for ${line.assetId}`);
    return { ...sample, weightBps: line.weightBps, amountUsd: line.weightBps / 100 };
  });
  const held = lines.filter((line) => line.cls !== 'cash');
  return reviewOf({
    lines,
    targets: held.map((line) => ({ asset: line.assetId, weightBps: line.weightBps })),
    cashBps: 10_000 - held.reduce((n, line) => n + line.weightBps, 0),
    ...over,
  });
};
/** The same warning, by the same id, on a figure that moved: only the hash tells the two apart. */
const moved = (over: Partial<MixReview> = {}): Partial<MixReview> => ({
  reviewHash: 'cd'.repeat(32),
  warnings: [
    {
      ...(reviewOf().warnings[0] as MixReview['warnings'][number]),
      figures: [{ ...figure, value: 3 }],
    },
  ],
  ...over,
});
const box = (host: HTMLElement) =>
  find<HTMLInputElement>(host, '[data-ui="mix-review-warnings"] input[type="checkbox"]');
const SAID: Purpose = { goal: 'grow', risk: 'medium' };
/** The deposit step as /invest mounts it: the amount is the host's, so another proposal keeps it. */
function Deposit({ said, onChangeMix }: { said: Purpose; onChangeMix: () => void }) {
  const [amountText, setAmountText] = useState('');
  return createElement(DepositStep, {
    chain: 'solana',
    userId,
    allocations: [
      { assetId: 'solana:usdc', weightBps: 6000 },
      { assetId: 'solana:gldx', weightBps: 4000 },
    ],
    said,
    amountText,
    onAmountText: setAmountText,
    provenance: 'sandbox',
    onChangeMix,
    onClose: () => {},
    host: { onOpen: () => {}, onRunning: () => {}, onLeave: () => {} },
  });
}
const goalMix = (lang: 'en' | 'pt' = 'en', said: Purpose = SAID, onChangeMix = () => {}) =>
  mount(withAccount(lang, createElement(Deposit, { said, onChangeMix })));
const amountBox = (host: HTMLElement) =>
  find<HTMLInputElement>(host, '[data-ui="amount-well"] input');
/** Types the amount and waits for the server's check of it to land. */
const deposit = async (host: HTMLElement, text: string) => {
  await type(amountBox(host), text);
  await settle(CHECK_MS + 50);
};
/** The one press of the deposit, held until the order is on the card, and why it is held. */
const press = (host: HTMLElement) => find(host, '[data-action="deposit-press"]');
const label = (el: Element) =>
  [...el.querySelectorAll(':scope > span > span')].find(
    (span) => span.getAttribute('aria-hidden') !== 'true',
  )?.textContent ?? el.textContent;
const reason = (host: HTMLElement) => {
  const id = press(host).getAttribute('aria-describedby');
  return id ? document.getElementById(id)?.textContent : null;
};
/** The one box that confirms every warning of the check (gate SIGN-ONE-STEP). */
const ack = (host: HTMLElement) => find<HTMLInputElement>(host, '[data-ui="warnings-ack"]');
const checkAgain = async (host: HTMLElement) => {
  await click(find(host, '[data-action="deposit-check-again"]'));
  await settle(CHECK_MS + 50);
};
const openEditor = (host: HTMLElement) => click(find(host, '[data-action="edit-by-hand"]'));
/** What each row of the read-only mix says in its dollars column, by asset. */
const amounts = (host: HTMLElement) =>
  Object.fromEntries(
    [...host.querySelectorAll('[data-ui="mix-lines"] [data-ui="composition-list"] [data-row]')].map(
      (row) => [
        row.getAttribute('data-row'),
        row.querySelector('[data-ui="mix-line-amount"]')?.textContent,
      ],
    ),
  );

/**
 * What a review echoes of the request it answers: the amount, and the goal and risk it was checked
 * for. One the request left unsaid is the server's, worked out from the mix (DEPOSIT-DERIVE): here
 * always a plan to protect at low risk, named in `fromMix`.
 */
const of = (body: {
  amountUsd: number;
  goal?: MixReview['goal'] | undefined;
  risk?: MixReview['risk'] | null;
}) => {
  const fromMix = [
    ...(body.goal ? [] : (['goal'] as const)),
    ...(body.risk ? [] : (['risk'] as const)),
  ];
  return {
    amountUsd: body.amountUsd,
    goal: body.goal ?? 'protect',
    risk: body.risk ?? 'low',
    ...(fromMix.length ? { fromMix } : {}),
  };
};

type Call = { url: string; body: Record<string, unknown> };
beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_CHAIN_NETWORK_SOLANA', 'testnet');
  localStorage.clear();
  router.push.mockClear();
  portStore.set(signedInPort(EMBEDDED, { userId }));
});
afterEach(async () => {
  await unmountAll();
  vi.unstubAllEnvs();
});

const buttonNamed = (host: HTMLElement, name: string) => {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === name);
  if (!button) throw new Error(`no button named ${name}`);
  return button;
};

describe('a vault conversation’s preview, applied to the vault', () => {
  it('says how the weights were set and what to watch, with the measured figure and its pin', async () => {
    const calls: Call[] = [];
    portStore.setApi(async (url, init) => {
      if (init?.method !== 'POST') return json({}, 404);
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return url.endsWith('/conversation/reply')
        ? json({ ...answer, messageId: calls.at(-1)?.body.messageId })
        : json({}, 404);
    });
    const host = await mount(withAccount('en', createElement(VaultConversation, { read, userId })));
    await type(find<HTMLTextAreaElement>(host, 'textarea'), 'Put 40% in gold, mostly safe');
    await click(find(host, '[data-ui="composer-send"]'));
    await settle();
    const notes = find(host, '[data-ui="weight-notes"]').textContent ?? '';
    expect(notes).toContain(en.mix.preview.note.stated('tGLDx', '40% gold'));
    expect(notes).toContain(en.mix.preview.note.equalRest('USDC'));
    expect(notes).toContain(en.mix.preview.note.unread('mostly safe'));
    expect(notes).toContain(en.mix.preview.note.withdrawn('70% TSLA'));
    const warnings = find(host, '[data-ui="mix-warnings"]');
    expect(warnings.textContent).toContain(en.mix.preview.warning.overExit('tGLDx'));
    expect(warnings.querySelector('[data-ui="pin"]')).not.toBeNull();
  });

  it('reviews the targets, holds the confirm until every warning is ticked, and keeps the reviewed targets with the order', async () => {
    const calls: Call[] = [];
    const ordered = retargetOrder();
    portStore.setApi(async (url, init) => {
      if (init?.method !== 'POST') return json({}, 404);
      const body = JSON.parse(String(init.body));
      calls.push({ url, body });
      if (url.endsWith('/conversation/reply'))
        return json({ ...answer, messageId: body.messageId });
      if (url.endsWith('/targets'))
        return body.confirm
          ? json({ status: 'ordered', review: reviewOf({ unconfirmed: [] }), order: ordered })
          : json({ status: 'review', review: reviewOf() });
      return json({}, 404);
    });
    const host = await mount(withAccount('en', createElement(VaultConversation, { read, userId })));
    await type(find<HTMLTextAreaElement>(host, 'textarea'), 'Put 40% in gold');
    await click(find(host, '[data-ui="composer-send"]'));
    await settle();
    await click(buttonNamed(host, en.mix.preview.apply));
    await settle();
    // Applied, the preview's weights go straight to their review (gate SIGN-ONE-STEP): the draft
    // gives its place to it, which says the change in a few words.
    expect(
      host.querySelector('[data-ui="vault-proposal"] [data-ui="change-review"]'),
    ).not.toBeNull();
    expect(find(host, '[data-ui="change-review"] [data-ui="sign-figure"]').textContent).toBe(
      'More GLDx',
    );
    // the targets before and after, never "now" (that is what the vault holds), and each move in points
    const change = find(host, '[data-ui="change-review"]');
    expect(
      [...change.querySelectorAll('[data-ui="sign-picture"] thead th')].map((th) => th.textContent),
    ).toEqual([
      en.order.flow.table.holding,
      en.order.flow.picture.next,
      en.order.flow.picture.before,
      en.order.flow.table.change,
    ]);
    // the shared composition's comparison (WEIGHTS-RING), its moves in points
    expect(find(change, '[data-ui="composition"]').dataset.mode).toBe('compare');
    const moves = change.querySelectorAll('[data-ui="composition-delta"] [aria-hidden="true"]');
    expect(moves.length).toBeGreaterThan(0);
    for (const delta of moves) expect(delta.textContent).toMatch(/^[+\u2212]<?\d+ pp$/);
    // worked out before any quote: its dollars are said as estimates, and why the steps' may differ
    expect(find(change, '[data-ui="stat-swapped"] dt').textContent).toBe(
      en.order.flow.stat.swappedEstimate,
    );
    expect(find(change, '[data-ui="change-estimate"]').textContent).toBe(
      en.order.flow.stat.estimate,
    );
    const asked = calls.find((c) => c.url.endsWith('/targets'));
    expect(asked?.url).toBe(`/v1/vaults/solana/${read.vault.address}/targets`);
    expect(asked?.body).toMatchObject({
      version: 1,
      origin: 'model',
      confirm: false,
      acceptedWarnings: [],
      allocations: [
        { assetId: 'solana:gldx', weightBps: 4000 },
        { assetId: 'solana:usdc', weightBps: 6000 },
      ],
    });
    // Every figure of the review carries its pin; the confirm waits for the tick.
    const lines = find(host, '[data-ui="mix-review-lines"]');
    // each row by the name every other step gives it, never the chain's symbol (the UI audit, I4)
    expect(lines.textContent).toContain('GLDx');
    expect(lines.textContent).not.toContain('tGLDx');
    // and the server's warning names it the same way
    expect(find(host, '[data-ui="mix-review-warnings"]').textContent).toContain(
      'GLDx is larger than',
    );
    expect(find(host, '[data-ui="mix-review-warnings"]').textContent).not.toContain('tGLDx');
    expect(find(host, '[data-ui="exit-ceiling"]').textContent).toContain(en.mix.review.measured);
    const confirm = find<HTMLButtonElement>(host, '[data-action="mix-confirm"]');
    expect(confirm.getAttribute('aria-disabled')).toBe('true');
    await click(confirm);
    expect(calls.filter((c) => c.url.endsWith('/targets'))).toHaveLength(1);
    // A warning's figure sits in the label of its tick, and so does the popover of its source:
    // reading that popover, and pressing its words, ticks nothing (review of #214, finding 3).
    const warned = find(host, '[data-ui="mix-review-warnings"]');
    // (opened by the keyboard's focus here: happy-dom, unlike a browser, takes a press on a button
    // inside a label for the label's)
    const pin = warned.querySelector<HTMLElement>('[data-ui="pin"]') as HTMLElement;
    await fire(pin, new FocusEvent('focusin', { bubbles: true }));
    await click(find(warned, '[data-ui="pin-what"]'));
    expect(box(host).checked, 'after the words').toBe(false);
    await click(find(warned, '[data-ui="pin-popover"]'));
    expect(box(host).checked, 'after the panel').toBe(false);
    expect(confirm.getAttribute('aria-disabled')).toBe('true');
    await fire(document, new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(warned.querySelector('[data-ui="pin-popover"]')).toBeNull();
    await click(find(host, '[data-ui="mix-review-warnings"] input[type="checkbox"]'));
    expect(confirm.getAttribute('aria-disabled')).toBeNull();
    await click(confirm);
    await settle();
    const confirmed = calls.filter((c) => c.url.endsWith('/targets')).at(-1);
    expect(confirmed?.body).toMatchObject({
      confirm: true,
      reviewHash: hash,
      acceptedWarnings: ['EXIT_OVER_CAPACITY:solana:gldx'],
    });
    expect(router.push).toHaveBeenCalledWith(`/portfolio/orders/${ordered.id}`);
    expect(recallOrder(ordered.id, userId)?.terms).toEqual({
      kind: 'retarget',
      vault: read.vault.address,
      basketId: read.vault.basketId,
      targets: [{ asset: 'solana:gldx', weightBps: 4000 }],
      origin: 'model',
    });
  });

  it('sends a weight the person changed as their own, and the review is of what the field says', async () => {
    const calls: Call[] = [];
    portStore.setApi(async (url, init) => {
      if (init?.method !== 'POST') return json({}, 404);
      const body = JSON.parse(String(init.body));
      calls.push({ url, body });
      if (url.endsWith('/conversation/reply'))
        return json({ ...answer, messageId: body.messageId });
      if (!url.endsWith('/targets')) return json({}, 404);
      return json({ status: 'review', review: reviewFor(body.allocations, { origin: 'person' }) });
    });
    const host = await mount(withAccount('en', createElement(VaultConversation, { read, userId })));
    await type(find<HTMLTextAreaElement>(host, 'textarea'), 'Put 40% in gold');
    await click(find(host, '[data-ui="composer-send"]'));
    await settle();
    await click(buttonNamed(host, en.mix.preview.apply));
    await settle();
    // the review's way to the fields, which start at the preview's weights
    await click(buttonNamed(host, en.order.flow.changeWeights));
    await settle();
    expect(find<HTMLInputElement>(host, '[data-ui="targets-lines"] input').value).toBe('40');
    await type(find<HTMLInputElement>(host, '[data-ui="targets-lines"] input'), '55');
    await click(find(host, '[data-action="targets-review"]'));
    await settle();
    expect(calls.filter((c) => c.url.endsWith('/targets')).at(-1)?.body).toMatchObject({
      origin: 'person',
      confirm: false,
      allocations: [
        { assetId: 'solana:gldx', weightBps: 5500 },
        { assetId: 'solana:usdc', weightBps: 4500 },
      ],
    });
    expect(find(host, '[data-ui="mix-review-lines"]').textContent).toContain('55%');
    expect(find(host, '[data-ui="mix-review-total"]').textContent).toContain('$100.00');
  });

  /** The conversation with a preview shown and applied: its review asked for. */
  const reviewing = async (targetsAnswer: (body: Call['body'], n: number) => Response) => {
    let n = 0;
    portStore.setApi(async (url, init) => {
      if (init?.method !== 'POST') return json({}, 404);
      const body = JSON.parse(String(init.body));
      if (url.endsWith('/conversation/reply'))
        return json({ ...answer, messageId: body.messageId });
      if (!url.endsWith('/targets')) return json({}, 404);
      n += 1;
      return targetsAnswer(body, n);
    });
    const host = await mount(withAccount('en', createElement(VaultConversation, { read, userId })));
    await type(find<HTMLTextAreaElement>(host, 'textarea'), 'Put 40% in gold');
    await click(find(host, '[data-ui="composer-send"]'));
    await settle();
    await click(buttonNamed(host, en.mix.preview.apply));
    await settle();
    return host;
  };

  it('unticks a warning whose figure moved under the same id, and holds the confirm again', async () => {
    const host = await reviewing((body) =>
      json({ status: 'review', review: body.confirm ? reviewOf(moved()) : reviewOf() }),
    );
    await click(box(host));
    await click(find(host, '[data-action="mix-confirm"]'));
    await settle();
    expect(host.textContent).toContain(en.mix.review.changed);
    expect(box(host).checked).toBe(false);
    expect(find(host, '[data-action="mix-confirm"]').getAttribute('aria-disabled')).toBe('true');
    expect(router.push).not.toHaveBeenCalled();
  });

  it('refuses a review whose targets are not the lines it was sent', async () => {
    const host = await reviewing(() =>
      json({
        status: 'review',
        review: reviewOf({ targets: [{ asset: 'solana:gldx', weightBps: 9000 }], cashBps: 1000 }),
      }),
    );
    expect(host.querySelector('[data-ui="mix-review-lines"]')).toBeNull();
    expect(find(host, '[role="alert"]').textContent).toBe(en.mix.failure.unreadable);
  });

  it('does not say nothing was stored when the server took the confirm and its order does not match', async () => {
    const host = await reviewing((body) =>
      body.confirm
        ? json({
            status: 'ordered',
            review: reviewOf({ unconfirmed: [] }),
            order: { ...retargetOrder(), type: 'buy' },
          })
        : json({ status: 'review', review: reviewOf() }),
    );
    await click(box(host));
    await click(find(host, '[data-action="mix-confirm"]'));
    await settle();
    expect(find(host, '[role="alert"]').textContent).toBe(en.mix.failure.unchecked);
    expect(en.mix.failure.unchecked).not.toContain('Nothing was stored');
    expect(router.push).not.toHaveBeenCalled();
  });

  it('closes the editor when another proposal arrives, and offers the new one', async () => {
    const host = await reviewing(() => json({ status: 'review', review: reviewOf() }));
    expect(host.querySelector('[data-ui="mix-review-lines"]')).not.toBeNull();
    await type(find<HTMLTextAreaElement>(host, 'textarea'), 'And now?');
    await click(find(host, '[data-ui="composer-send"]'));
    await settle();
    expect(host.querySelector('[data-ui="mix-review-lines"]')).toBeNull();
    expect(host.querySelector('[data-ui="weight-editor"]')).toBeNull();
    expect(buttonNamed(host, en.mix.preview.apply)).not.toBeNull();
  });

  it('shows a note on a share that was not applied when the reply has no proposal', async () => {
    portStore.setApi(async (url, init) => {
      if (init?.method !== 'POST' || !url.endsWith('/conversation/reply')) return json({}, 404);
      return json({
        ...answer,
        messageId: JSON.parse(String(init.body)).messageId,
        proposal: null,
        warnings: [],
        weightNotes: [{ code: 'share_unmet', assetIds: [], quote: '70% TSLA' }],
      });
    });
    const host = await mount(withAccount('en', createElement(VaultConversation, { read, userId })));
    await type(find<HTMLTextAreaElement>(host, 'textarea'), 'I want 70% TSLA');
    await click(find(host, '[data-ui="composer-send"]'));
    await settle();
    const notes = find(host, '[data-ui="weight-notes"]').textContent ?? '';
    expect(notes).toContain(en.mix.preview.notesAlone);
    expect(notes).toContain(en.mix.preview.note.unmet('70% TSLA'));
  });
});

describe('a proposal confirmed on the vault’s own page (gate VAULT-PAGE-ACTIONS)', () => {
  /** The owner's page, with a proposal in the conversation and its confirm answered by `ordered`. */
  async function page(ordered: () => Promise<Response>) {
    portStore.setApi(async (url, init) => {
      if (url === '/v1/me')
        return json({
          userId,
          wallets: EMBEDDED,
          chain: 'solana',
          chainSource: 'picked',
          chainOptions: [],
        });
      if (url === `/v1/vaults/solana/${read.vault.address}`) return json(read);
      // the order the confirm made, as the order's own screen reads it in the pane
      if (url.startsWith('/v1/orders/') && init?.method !== 'POST') return json(retargetOrder());
      if (init?.method !== 'POST') return json({}, 404);
      const body = JSON.parse(String(init.body));
      if (url.endsWith('/conversation/reply'))
        return json({ ...answer, messageId: body.messageId });
      if (url.endsWith('/targets'))
        return body.confirm ? ordered() : json({ status: 'review', review: reviewOf() });
      return json({}, 404);
    });
    const host = await mount(
      withAccount(
        'en',
        createElement(VaultScreen, { chain: 'solana', address: read.vault.address }),
      ),
    );
    for (let i = 0; i < 4; i += 1) await settle(30);
    await type(find<HTMLTextAreaElement>(host, 'textarea'), 'Put 40% in gold');
    await click(find(host, '[data-ui="composer-send"]'));
    await settle();
    await click(buttonNamed(host, en.mix.preview.apply));
    await settle();
    await click(box(host));
    await click(find(host, '[data-action="mix-confirm"]'));
    await settle();
    return host;
  }
  const answered = () =>
    json({ status: 'ordered', review: reviewOf({ unconfirmed: [] }), order: retargetOrder() });

  it('forgets the draft and its review once the change is signed: back on the vault, the holdings (audit V2)', async () => {
    const host = await page(async () => answered());
    for (let i = 0; i < 4; i += 1) await settle(30);
    expect(host.querySelector('[data-ui="change-review"]')).not.toBeNull();
    // another order's end (a deposit, another vault, another tab) leaves the change as it is
    await act(async () => announceOrderDone('another-order'));
    await settle();
    expect(host.querySelector('[data-ui="change-review"]')).not.toBeNull();
    // the change's own order ends: its draft and review are gone
    await act(async () => announceOrderDone(retargetOrder().id));
    await settle();
    expect(host.querySelector('[data-ui="change-review"]')).toBeNull();
    expect(host.querySelector('[data-ui="vault-proposal"]')).toBeNull();
  });

  it('takes the pane with the order’s steps, and opens no other page', async () => {
    const host = await page(async () => answered());
    for (let i = 0; i < 4; i += 1) await settle(30);
    expect(find(host, '[data-ui="vault-screen"]').dataset.pane).toBe('apply');
    expect(router.push).not.toHaveBeenCalled();
    // reviewed before its order was made (ChangeReview): the pane opens on the first step, whose
    // button names it; the way back is the pane's own, and there is no second review
    const pane = find(host, '[data-ui="vault-action-pane"]');
    expect(find(pane, '[data-ui="order-screen"]').dataset.stage).toBe('steps');
    // one press of the passkey wallet signs every step: the screen is the whole change's
    expect(find(pane, '[data-ui="sign-step"] [data-ui="sign-figure"]').textContent).toBe(
      'More GLDx',
    );
    expect(find(pane, '[data-ui="sign-step"] [data-variant="primary"]').textContent).toContain(
      en.order.flow.press.change,
    );
    expect(pane.querySelector('[data-action="order-back"]')).toBeNull();
    expect(pane.querySelector('[data-action="leave-action"]')).not.toBeNull();
  });

  it('does not replace a deposit opened before its order answers', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const host = await page(async () => {
      await gate;
      return answered();
    });
    // the confirm is on its way: the person opens Deposit meanwhile
    await click(find(host, '[data-action="vault-deposit"]'));
    await settle();
    expect(find(host, '[data-ui="vault-screen"]').dataset.pane).toBe('deposit');
    release();
    for (let i = 0; i < 4; i += 1) await settle(30);
    expect(find(host, '[data-ui="vault-screen"]').dataset.pane).toBe('deposit');
    expect(host.querySelector('[data-ui="vault-action-pane"] [data-ui="order-step"]')).toBeNull();
    expect(router.push).not.toHaveBeenCalled();
  });
});

describe('a new goal’s mix, deposited from one screen (gate DEPOSIT-ONE-SCREEN)', () => {
  it('takes one amount with the goal the person said, checks it, and once the warnings are confirmed stores the plan and shows the press on the same card', async () => {
    const calls: Call[] = [];
    const proposalId = '0f6a3b9e-2c4d-4e5f-8a7b-1c2d3e4f5a6b';
    const { planOn, serverKeepsPlans } = await import('../order/test/fixtures');
    const plan = planOn('solana');
    // the server keeps the plan it stored, and answers it to the card that then reads it
    portStore.setApi(
      serverKeepsPlans(async (url, init) => {
        if (!url.endsWith('/goal/accept')) return json({}, 404);
        const body = JSON.parse(String(init?.body ?? '{}'));
        calls.push({ url, body });
        return body.confirm
          ? json({
              status: 'stored',
              review: reviewOf({ ...of(body), unconfirmed: [] }),
              proposalId,
              proposal: plan.proposal,
            })
          : json({ status: 'review', review: reviewOf(of(body)) });
      }),
    );
    const host = await goalMix('en', { goal: 'protect', risk: 'low' });
    // no form: nothing to choose from, no goal or risk label (Thom, Oct 28), the editor closed
    expect(host.querySelectorAll('select')).toHaveLength(0);
    expect(host.querySelector('[data-ui="deposit-purpose"]')).toBeNull();
    expect(host.textContent).not.toMatch(/\brisk\b|growth|keep it safe/i);
    expect(host.querySelectorAll('input')).toHaveLength(1);
    expect(host.querySelector('[data-ui="weight-editor"]')).toBeNull();
    expect(host.textContent).not.toContain(en.mix.editor.unit);
    expect([...host.querySelectorAll('button')].map((b) => b.textContent)).not.toContain(
      en.mix.editor.remove('GLDx'),
    );
    // the one press is there from the start, held, and says why once it is pressed
    expect(label(press(host))).toBe(en.mix.deposit.press);
    expect(press(host).getAttribute('aria-disabled')).toBe('true');
    await click(press(host));
    expect(calls).toEqual([]);
    expect(host.textContent).toContain(en.mix.deposit.blocked.amount);
    await deposit(host, '100');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: '/v1/conversations/solana/goal/accept',
      body: {
        origin: 'model',
        goal: 'protect',
        risk: 'low',
        amountUsd: 100,
        confirm: false,
        allocations: [
          { assetId: 'solana:gldx', weightBps: 4000 },
          { assetId: 'solana:usdc', weightBps: 6000 },
        ],
      },
    });
    // the rows carry the checked dollars and each holding's facts, with their pins; over them, the
    // vault's measured facts at this amount: $40 of gold is more than its $12 exit sells as planned
    expect(amounts(host)).toEqual({ 'solana:gldx': '$40.00', 'solana:usdc': '$60.00' });
    expect(find(host, '[data-ui="deposit-summary"]').textContent).toBe(
      `${en.mix.deposit.summary.holdings(1)} · ${en.mix.deposit.summary.over(1)}`,
    );
    expect(host.textContent).not.toMatch(/\brisk\b/i);
    const facts = find(host, '[data-row="solana:gldx"] [data-ui="deposit-facts"]');
    expect(find(facts, '[data-ui="feed-price"]').textContent).toContain(en.mix.deposit.facts.feed);
    expect(find(facts, '[data-ui="exit-ceiling"]').textContent).toContain(
      en.mix.deposit.facts.exitUpTo,
    );
    expect(facts.querySelectorAll('[data-ui="figure"]').length).toBeGreaterThanOrEqual(2);
    expect(host.querySelector('[data-row="solana:usdc"] [data-ui="deposit-facts"]')).toBeNull();
    // nothing is stored while a warning is not confirmed: the press says so
    expect(label(press(host))).toBe(en.invest.press('$100'));
    expect(reason(host)).toBe(en.mix.deposit.blocked.ack);
    expect(host.querySelector('[data-ui="deposit-sign"]')).toBeNull();
    await click(ack(host));
    await settle();
    // our server checks every line again at today's prices, with the review's hash and the ticks
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body).toMatchObject({
      confirm: true,
      reviewHash: hash,
      acceptedWarnings: ['EXIT_OVER_CAPACITY:solana:gldx'],
      amountUsd: 100,
      goal: 'protect',
      risk: 'low',
    });
    // the steps to sign are on the same card, under the amount and the rows: one screen
    expect(router.push).not.toHaveBeenCalled();
    expect(localStorage.getItem(`tf-plan:${proposalId}`)).not.toBeNull();
    const card = find(host, '[data-ui="deposit-step"]');
    const pane = find(card, '[data-ui="deposit-sign"]');
    expect(pane.getAttribute('data-state')).toBe('ready');
    expect(amountBox(host).value).toBe('100');
    expect(card.querySelectorAll('[data-ui="mix-lines"]')).toHaveLength(1);
    // no review screen of its own, nor a second table of what the deposit goes into
    expect(host.querySelector('[data-action="mix-confirm"]')).toBeNull();
    expect(host.querySelector('[data-ui="mix-review-lines"]')).toBeNull();
    expect(host.textContent).not.toContain(en.invest.buying);
    // another amount: the plan stored for the old one leaves the card, and the new one is checked
    await type(amountBox(host), '250');
    expect(host.querySelector('[data-ui="deposit-sign"]')).toBeNull();
    await settle(CHECK_MS + 50);
    expect(calls[2]?.body).toMatchObject({ amountUsd: 250, confirm: false });
  });

  it('says what is being done while it waits: the check, then today’s quotes', async () => {
    const proposalId = '0f6a3b9e-2c4d-4e5f-8a7b-1c2d3e4f5a6b';
    const { planOn } = await import('../order/test/fixtures');
    const plan = planOn('solana');
    const waiting: (() => void)[] = [];
    const calls: Call[] = [];
    portStore.setApi(async (url, init) => {
      if (!url.endsWith('/goal/accept')) return json({}, 404);
      const body = JSON.parse(String(init?.body ?? '{}'));
      calls.push({ url, body });
      await new Promise<void>((done) => waiting.push(done));
      return body.confirm
        ? json({
            status: 'stored',
            review: reviewOf({ ...of(body), unconfirmed: [] }),
            proposalId,
            proposal: plan.proposal,
          })
        : json({ status: 'review', review: reviewOf(of(body)) });
    });
    const release = async () => {
      await act(async () => waiting.shift()?.());
      await settle();
    };
    const host = await goalMix();
    await type(amountBox(host), '100');
    expect(find(host, '[data-ui="deposit-check"]').textContent).toBe(en.mix.deposit.checking);
    // no figure is shown before the server sent it
    expect(amounts(host)['solana:gldx']).toBe(`—${en.mix.deposit.unchecked}`);
    await settle(CHECK_MS + 50);
    expect(calls.map((call) => call.body.confirm)).toEqual([false]);
    expect(reason(host)).toBe(en.mix.deposit.blocked.checking);
    await release();
    expect(find(host, '[data-ui="deposit-check"]').textContent).toBe(en.mix.deposit.checked);
    await click(ack(host));
    // the store: said on the press, which waits with its mark, and on the status line
    expect(calls.map((call) => call.body.confirm)).toEqual([false, true]);
    expect(label(press(host))).toBe(en.mix.deposit.saving);
    expect(press(host).getAttribute('aria-busy')).toBe('true');
    // the status line stays as it was, so nothing under it moves
    expect(find(host, '[data-ui="deposit-check"]').textContent).toBe(en.mix.deposit.checked);
    await release();
    // stored: nobody is sent anywhere, and the steps to sign are on the card
    expect(router.push).not.toHaveBeenCalled();
    expect(host.querySelector('[data-action="deposit-press"]')).toBeNull();
    expect(find(host, '[data-ui="deposit-sign"]').getAttribute('data-state')).toBe('ready');
    // what was sent is what was sent before this change: the same two requests, nothing added
    expect(calls.map((call) => Object.keys(call.body).sort())).toEqual([
      [
        'acceptedWarnings',
        'allocations',
        'amountUsd',
        'confirm',
        'goal',
        'language',
        'origin',
        'risk',
        'version',
      ],
      [
        'acceptedWarnings',
        'allocations',
        'amountUsd',
        'confirm',
        'goal',
        'language',
        'origin',
        'reviewHash',
        'risk',
        'version',
      ],
    ]);
  });

  it('shows each row the dollars the server checked, and a dash until it has', async () => {
    portStore.setApi(async (url, init) => {
      if (!url.endsWith('/goal/accept')) return json({}, 404);
      const body = JSON.parse(String(init?.body ?? '{}'));
      // figures no arithmetic on the screen would give: only the server's can be what is shown
      const review = reviewFor(body.allocations, of(body));
      return json({
        status: 'review',
        review: {
          ...review,
          lines: review.lines.map((line) => ({
            ...line,
            amountUsd: line.cls === 'cash' ? 61.07 : 38.93,
          })),
        },
      });
    });
    const host = await goalMix();
    expect(amounts(host)).toEqual({
      'solana:gldx': `—${en.mix.deposit.unchecked}`,
      'solana:usdc': `—${en.mix.deposit.unchecked}`,
    });
    expect(find(host, '[data-ui="deposit-check"]').textContent).toBe(en.mix.deposit.needAmount);
    await type(amountBox(host), '100');
    // typed, not yet checked: still no figure
    expect(amounts(host)['solana:gldx']).toBe(`—${en.mix.deposit.unchecked}`);
    expect(find(host, '[data-ui="deposit-check"]').textContent).toBe(en.mix.deposit.checking);
    await settle(CHECK_MS + 50);
    expect(amounts(host)).toEqual({ 'solana:gldx': '$38.93', 'solana:usdc': '$61.07' });
    expect(find(host, '[data-ui="deposit-check"]').textContent).toBe(en.mix.deposit.checked);
    // another amount: the old figures go at once, never shown beside an amount they are not of
    await type(amountBox(host), '250');
    expect(amounts(host)['solana:usdc']).toBe(`—${en.mix.deposit.unchecked}`);
    expect(host.querySelector('[data-ui="deposit-facts"]')).toBeNull();
  });

  it('holds the amount to the limits and says which one, without asking the server', async () => {
    const calls: Call[] = [];
    portStore.setApi(async (url, init) => {
      if (!url.endsWith('/goal/accept')) return json({}, 404);
      const body = JSON.parse(String(init?.body ?? '{}'));
      calls.push({ url, body });
      return json({ status: 'review', review: reviewOf(of(body)) });
    });
    const host = await goalMix();
    expect(host.textContent).toContain(en.mix.deposit.limits);
    for (const [text, error] of [
      ['9.99', en.mix.deposit.errors.belowMin],
      ['1000000.01', en.mix.deposit.errors.aboveMax],
      ['ten', en.mix.deposit.errors.notAmount],
    ] as const) {
      await deposit(host, text);
      expect(host.textContent).toContain(error);
      expect(amountBox(host).getAttribute('aria-invalid')).toBe('true');
      expect(press(host).getAttribute('aria-disabled')).toBe('true');
      expect(label(press(host))).toBe(en.mix.deposit.press);
    }
    expect(calls).toEqual([]);
    for (const text of ['10', '1000000']) {
      await deposit(host, text);
      expect(amountBox(host).getAttribute('aria-invalid')).toBeNull();
    }
    expect(calls.map((call) => call.body.amountUsd)).toEqual([10, 1_000_000]);
    // a quick amount types itself, and the press names it
    await click(find(host, '[data-ui="amount-chips"] li:nth-child(2) button'));
    expect(amountBox(host).value).toBe('500');
    expect(label(press(host))).toBe(en.invest.press('$500'));
  });

  it('asks nothing it was not told: sends the unsaid goal and risk as not said, and says what the server worked out from the mix', async () => {
    const calls: Call[] = [];
    portStore.setApi(async (url, init) => {
      if (!url.endsWith('/goal/accept')) return json({}, 404);
      const body = JSON.parse(String(init?.body ?? '{}'));
      calls.push({ url, body });
      return json({ status: 'review', review: reviewOf(of(body)) });
    });
    const host = await goalMix('en', { goal: null, risk: null });
    // no question, no tap, no sentence until the server has read the mix
    expect(host.querySelector('[data-ui="deposit-purpose"]')).toBeNull();
    expect(host.querySelector('[data-ui="deposit-goal"]')).toBeNull();
    expect(host.querySelector('[data-ui="deposit-risk"]')).toBeNull();
    expect(host.querySelectorAll('select')).toHaveLength(0);
    // no toggle to tap a goal or a risk; a holding's row in the picture is the only pressable thing
    expect(host.querySelectorAll('[aria-pressed]:not([data-ui="composition-row"])')).toHaveLength(
      0,
    );
    await deposit(host, '100');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toMatchObject({ goal: null, risk: null, confirm: false });
    // what the server worked out is never shown as a label: the card says measured facts instead
    expect(host.querySelector('[data-ui="deposit-purpose"]')).toBeNull();
    expect(host.textContent).not.toMatch(/\brisk\b|protect|keep it safe/i);
    expect(find(host, '[data-ui="deposit-summary"]')).not.toBeNull();
    expect(find(host, '[data-ui="deposit-check"]').textContent).toBe(en.mix.deposit.checked);
  });

  it('sends what the person said with the check, and shows it as no label', async () => {
    const calls: Call[] = [];
    portStore.setApi(async (url, init) => {
      if (!url.endsWith('/goal/accept')) return json({}, 404);
      const body = JSON.parse(String(init?.body ?? '{}'));
      calls.push({ url, body });
      return json({ status: 'review', review: reviewOf(of(body)) });
    });
    const host = await goalMix('en', { goal: 'grow', risk: null });
    await deposit(host, '100');
    expect(calls[0]?.body).toMatchObject({ goal: 'grow', risk: null });
    expect(host.textContent).not.toMatch(/\brisk\b|growth/i);
  });

  it('says the vault’s measured facts at this amount in one line: holdings, the worst exit cost, and whether each sells as planned', async () => {
    const at = (fetchedAt: string) => ({
      source: 'fixture exit read',
      fetchedAt,
      method: 'test measured exit',
      provenance: 'sandbox' as const,
    });
    const [cash, gold] = reviewOf().lines as [
      MixReview['lines'][number],
      MixReview['lines'][number],
    ];
    const review = (body: { amountUsd: number }) =>
      reviewOf({
        ...of(body),
        lines: [
          cash,
          {
            ...gold,
            exitCeiling: { usd: 1_000, measured: true, ...at('2026-10-05T12:00:00.000Z') },
            exitCost: { bps: 7, sizeUsd: 40, ...at('2026-10-05T12:00:00.000Z') },
          },
        ],
        warnings: [],
        unconfirmed: [],
      });
    portStore.setApi(async (url, init) => {
      if (!url.endsWith('/goal/accept')) return json({}, 404);
      const body = JSON.parse(String(init?.body ?? '{}'));
      return json({ status: 'review', review: review(body) });
    });
    const host = await goalMix();
    expect(host.querySelector('[data-ui="deposit-summary"]')).toBeNull();
    await deposit(host, '100');
    const summary = find(host, '[data-ui="deposit-summary"]');
    expect(summary.textContent?.replace(/\s+/g, ' ')).toBe(
      `${en.mix.deposit.summary.holdings(1)} · ${en.mix.deposit.summary.exitCostAt('$100.00')} 0.07% ${en.mix.deposit.summary.atWorst} · ${en.mix.deposit.summary.within}`,
    );
    // the exit cost carries its pin, from the server's figure
    expect(find(summary, '[data-ui="summary-exit-cost"] [data-ui="figure"]')).not.toBeNull();
    // and the row says the same cost at its own size
    expect(find(host, '[data-row="solana:gldx"] [data-ui="exit-cost"]').textContent).toContain(
      '0.07%',
    );
  });

  it('a re-check whose figures moved: shows the new ones, unticks the warning, and stores nothing until it is confirmed again', async () => {
    const sent: Record<string, unknown>[] = [];
    portStore.setApi(async (url, init) => {
      if (!url.endsWith('/goal/accept')) return json({}, 404);
      const body = JSON.parse(String(init?.body ?? '{}'));
      sent.push(body);
      return json({
        status: 'review',
        review: body.confirm ? reviewOf(moved(of(body))) : reviewOf(of(body)),
      });
    });
    const host = await goalMix();
    await deposit(host, '100');
    await click(ack(host));
    await settle();
    expect(sent.map((body) => body.confirm)).toEqual([false, true]);
    // said, with the figure that moved, and the one box unticked again
    expect(find(host, '[data-ui="deposit-moved"]').textContent).toBe(en.mix.review.changed);
    expect(ack(host).checked).toBe(false);
    expect(find(host, '[data-ui="mix-review-warnings"]').textContent).toContain('$3.00');
    expect(host.querySelector('[data-ui="deposit-sign"]')).toBeNull();
    expect(reason(host)).toBe(en.mix.deposit.blocked.ack);
    expect(router.push).not.toHaveBeenCalled();
    // confirmed again: the store is sent with the new review's hash
    await click(ack(host));
    await settle();
    expect(sent.at(-1)).toMatchObject({ confirm: true, reviewHash: 'cd'.repeat(32) });
  });

  it('starts the check of changed weights with nothing ticked', async () => {
    portStore.setApi(async (url, init) => {
      if (!url.endsWith('/goal/accept')) return json({}, 404);
      const body = JSON.parse(String(init?.body ?? '{}'));
      // a store that never answers: only the ticks are read here
      if (body.confirm) return new Promise<Response>(() => {});
      const gold = body.allocations.find((l: { assetId: string }) => l.assetId === 'solana:gldx');
      // the same warning id at 40% and at 90%; the hash is the review's own
      return json({
        status: 'review',
        review: reviewFor(body.allocations, gold.weightBps === 4000 ? of(body) : moved(of(body))),
      });
    });
    const host = await goalMix();
    await deposit(host, '100');
    await click(ack(host));
    expect(ack(host).checked).toBe(true);
    await openEditor(host);
    await type(find<HTMLInputElement>(host, '[data-ui="targets-lines"] input'), '90');
    await settle(CHECK_MS + 50);
    expect(find(host, '[data-ui="mix-lines"]').textContent).toContain('90%');
    expect(ack(host).checked).toBe(false);
    expect(reason(host)).toBe(en.mix.deposit.blocked.ack);
  });

  it('reads a Portuguese amount with a decimal comma, and names it on the press', async () => {
    const calls: Call[] = [];
    portStore.setApi(async (url, init) => {
      if (!url.endsWith('/goal/accept')) return json({}, 404);
      const body = JSON.parse(String(init?.body ?? '{}'));
      calls.push({ url, body });
      return json({ status: 'review', review: reviewOf(of(body)) });
    });
    const pt = dictionary('pt');
    const host = await goalMix('pt');
    expect(host.querySelector('[data-ui="deposit-purpose"]')).toBeNull();
    await deposit(host, '100,50');
    expect(find(host, '[data-ui="deposit-summary"]').textContent).toContain(
      pt.mix.deposit.summary.holdings(1),
    );
    expect(host.textContent).not.toMatch(/risco/i);
    expect(calls[0]?.body.amountUsd).toBe(100.5);
    expect(press(host).textContent).toMatch(/100,50/);
    expect(find(host, '[data-row="solana:gldx"] [data-ui="exit-ceiling"]').textContent).toContain(
      pt.mix.deposit.facts.exitUpTo,
    );
  });

  it('says each asset the goal refuses on a line of its own, with what to do', async () => {
    portStore.setApi(async (url) =>
      url.endsWith('/goal/accept')
        ? json(
            {
              error: 'this mix cannot be bought as it is',
              code: 'MIX_NOT_VALID',
              details: { issues: ['NOT_FOR_GOAL:solana:gldx', 'NOT_FOR_GOAL:solana:btc'] },
            },
            422,
          )
        : json({}, 404),
    );
    const host = await goalMix('en', { goal: 'protect', risk: 'low' });
    await deposit(host, '100');
    const said = (find(host, '[data-ui="deposit-refused"] span').textContent ?? '').split('\n');
    expect(find(host, '[data-ui="deposit-refused"]').getAttribute('role')).toBe('alert');
    expect(said).toHaveLength(4);
    expect(said[0]).toBe(en.mix.failure.invalid);
    expect(said[1]).toMatch(/gold|GLD/i);
    expect(said[1]).toContain('Take it out, or choose another goal.');
    expect(said[2]).not.toBe(said[1]);
    expect(said[2]).toContain('Take it out, or choose another goal.');
    // and where to do that: the conversation, or the editor; asking again would change nothing
    expect(said[3]).toBe(en.mix.deposit.invalidNext);
    expect(host.querySelector('[data-action="deposit-check-again"]')).toBeNull();
    expect(reason(host)).toBe(en.mix.deposit.blocked.refused);
    expect(amounts(host)['solana:gldx']).toBe(`—${en.mix.deposit.unchecked}`);
    const pt = dictionary('pt');
    expect(pt.mix.issue('NOT_FOR_GOAL', 'Ouro')).toContain('Ouro');
    expect(pt.mix.issue('NOT_FOR_GOAL', 'Ouro')).not.toBe(pt.mix.issue('', 'Ouro'));
  });

  it('says a check that did not get through, and asks again on asking', async () => {
    let up = false;
    portStore.setApi(async (_url, init) =>
      up
        ? json({ status: 'review', review: reviewOf(of(JSON.parse(String(init?.body ?? '{}')))) })
        : json({}, 502),
    );
    const host = await goalMix();
    await deposit(host, '100');
    expect(find(host, '[data-ui="deposit-refused"] span').textContent).toBe(
      en.mix.failure.unreachable,
    );
    up = true;
    await checkAgain(host);
    expect(host.querySelector('[data-ui="deposit-refused"]')).toBeNull();
    expect(amounts(host)['solana:gldx']).toBe('$40.00');
  });

  it('goes back to the conversation to change the holdings', async () => {
    const back = vi.fn();
    const host = await goalMix('en', SAID, back);
    await click(find(host, '[data-action="change-mix"]'));
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('stores a few plans by itself, then asks before checking today’s prices again', async () => {
    const proposalId = '0f6a3b9e-2c4d-4e5f-8a7b-1c2d3e4f5a6b';
    const { planOn, serverKeepsPlans } = await import('../order/test/fixtures');
    const plan = planOn('solana');
    const stores: number[] = [];
    portStore.setApi(
      serverKeepsPlans(async (url, init) => {
        if (!url.endsWith('/goal/accept')) return json({}, 404);
        const body = JSON.parse(String(init?.body ?? '{}'));
        const review = reviewOf({ ...of(body), warnings: [], unconfirmed: [] });
        if (!body.confirm) return json({ status: 'review', review });
        stores.push(body.amountUsd);
        return json({ status: 'stored', review, proposalId, proposal: plan.proposal });
      }),
    );
    const host = await goalMix();
    for (const text of ['100', '200', '300', '400']) {
      await deposit(host, text);
      await settle();
    }
    expect(stores).toEqual([100, 200, 300, 400]);
    expect(host.querySelector('[data-ui="deposit-sign"]')).not.toBeNull();
    await deposit(host, '500');
    await settle();
    // the fifth waits for the person: the press says why, and one more is a press away
    expect(stores).toHaveLength(4);
    expect(host.querySelector('[data-ui="deposit-sign"]')).toBeNull();
    expect(reason(host)).toBe(en.mix.deposit.blocked.ask);
    await click(find(host, '[data-action="deposit-again"]'));
    await settle();
    expect(stores).toEqual([100, 200, 300, 400, 500]);
    expect(host.querySelector('[data-ui="deposit-sign"]')).not.toBeNull();
  });
});

describe('the deposit step, kept honest while things move', () => {
  const accepts = (answer: (body: Record<string, unknown>, n: number) => Promise<Response>) => {
    const calls: Call[] = [];
    portStore.setApi(async (url, init) => {
      if (!url.endsWith('/goal/accept')) return json({}, 404);
      const body = JSON.parse(String(init?.body ?? '{}'));
      calls.push({ url, body });
      return answer(body, calls.length);
    });
    return calls;
  };
  const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('drops a late answer about an amount that is no longer the one typed', async () => {
    // the check of 100 answers after the check of 250 has
    const calls = accepts(async (body) => {
      if (body.amountUsd === 100) await later(400);
      if (body.confirm) return new Promise<Response>(() => {});
      return json({
        status: 'review',
        review: reviewFor(body.allocations as never, of(body as never)),
      });
    });
    const host = await goalMix();
    await type(amountBox(host), '100');
    await settle(CHECK_MS + 20);
    await type(amountBox(host), '250');
    await settle(CHECK_MS + 100);
    const shown = amounts(host);
    await settle(400);
    // the rows are still the newer amount's check, and the store is of it
    expect(amounts(host)).toEqual(shown);
    expect(find(host, '[data-ui="deposit-check"]').textContent).toBe(en.mix.deposit.checked);
    await click(ack(host));
    expect(calls.filter((call) => call.body.confirm).map((call) => call.body.amountUsd)).toEqual([
      250,
    ]);
  });

  it('a plan stored for an amount that is no longer typed is nobody’s: never shown, and the new amount is checked', async () => {
    const proposalId = '0f6a3b9e-2c4d-4e5f-8a7b-1c2d3e4f5a6b';
    const { planOn, serverKeepsPlans } = await import('../order/test/fixtures');
    const plan = planOn('solana');
    let release: () => void = () => {};
    const calls: Call[] = [];
    portStore.setApi(
      serverKeepsPlans(async (url, init) => {
        if (!url.endsWith('/goal/accept')) return json({}, 404);
        const body = JSON.parse(String(init?.body ?? '{}'));
        calls.push({ url, body });
        const review = reviewOf({ ...of(body), warnings: [], unconfirmed: [] });
        if (!body.confirm) return json({ status: 'review', review });
        if (body.amountUsd === 100)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        return json({ status: 'stored', review, proposalId, proposal: plan.proposal });
      }),
    );
    const host = await goalMix();
    await deposit(host, '100');
    expect(calls.map((call) => [call.body.amountUsd, call.body.confirm])).toEqual([
      [100, false],
      [100, true],
    ]);
    await type(amountBox(host), '200');
    await act(async () => release());
    await settle();
    // the plan of $100 never takes the card; $200 is checked and stored for itself
    expect(host.querySelector('[data-ui="deposit-sign"]')).toBeNull();
    await settle(CHECK_MS + 50);
    await settle();
    expect(calls.slice(2).map((call) => [call.body.amountUsd, call.body.confirm])).toEqual([
      [200, false],
      [200, true],
    ]);
    expect(find(host, '[data-ui="deposit-sign"]').getAttribute('data-state')).toBe('ready');
  });

  it('refuses a review that is not of the amount, the goal or the risk it was asked for', async () => {
    let wrong: Record<string, unknown> = { amountUsd: 200 };
    accepts(async (body) =>
      json({ status: 'review', review: reviewOf({ ...of(body as never), ...wrong }) }),
    );
    const host = await goalMix();
    await deposit(host, '500');
    expect(find(host, '[data-ui="deposit-refused"] span').textContent).toBe(
      en.mix.failure.unreadable,
    );
    expect(amounts(host)['solana:gldx']).toBe(`—${en.mix.deposit.unchecked}`);
    // a goal or risk the person said, changed by the server, even when it says it worked it out
    for (const over of [
      { goal: 'protect' },
      { risk: 'high' },
      { risk: 'high', fromMix: ['risk'] },
    ]) {
      wrong = over;
      await checkAgain(host);
      expect(host.querySelector('[data-ui="deposit-facts"]')).toBeNull();
      expect(find(host, '[data-ui="deposit-refused"] span').textContent).toBe(
        en.mix.failure.unreadable,
      );
    }
  });

  it('refuses a goal or risk the person did not say that the server fills in without saying so', async () => {
    let wrong: Record<string, unknown> = { fromMix: ['risk'] };
    accepts(async (body) =>
      json({ status: 'review', review: reviewOf({ ...of(body as never), ...wrong }) }),
    );
    const host = await goalMix('en', { goal: null, risk: null });
    await deposit(host, '500');
    expect(find(host, '[data-ui="deposit-refused"] span').textContent).toBe(
      en.mix.failure.unreadable,
    );
    expect(host.querySelector('[data-ui="deposit-purpose"]')).toBeNull();
    wrong = { fromMix: undefined };
    await checkAgain(host);
    expect(host.querySelector('[data-ui="deposit-facts"]')).toBeNull();
    wrong = {};
    await checkAgain(host);
    expect(find(host, '[data-ui="mix-lines"]').textContent).toContain('40%');
    expect(host.querySelector('[data-ui="deposit-facts"]')).not.toBeNull();
  });

  it('moves focus on purpose: the amount on open, and nothing takes it as the plan is stored', async () => {
    const proposalId = '0f6a3b9e-2c4d-4e5f-8a7b-1c2d3e4f5a6b';
    const { planOn, serverKeepsPlans } = await import('../order/test/fixtures');
    const plan = planOn('solana');
    portStore.setApi(
      serverKeepsPlans(async (url, init) => {
        if (!url.endsWith('/goal/accept')) return json({}, 404);
        const body = JSON.parse(String(init?.body ?? '{}'));
        const review = reviewOf({ ...of(body), warnings: [], unconfirmed: [] });
        return json(
          body.confirm
            ? { status: 'stored', review, proposalId, proposal: plan.proposal }
            : { status: 'review', review },
        );
      }),
    );
    const host = await goalMix();
    expect(document.activeElement).toBe(amountBox(host));
    await deposit(host, '100');
    await settle();
    expect(find(host, '[data-ui="deposit-sign"]').getAttribute('data-state')).toBe('ready');
    expect(document.activeElement).toBe(amountBox(host));
  });

  it('keeps focus in the editor when a row is removed', async () => {
    accepts(async (body) =>
      json({ status: 'review', review: reviewFor(body.allocations as never, of(body as never)) }),
    );
    const host = await goalMix();
    await openEditor(host);
    await click(buttonNamed(host, en.mix.editor.remove('GLDx')));
    await settle(50);
    // the only row is gone: the way to add one takes focus
    expect(document.activeElement).toBe(find(host, '[data-ui="weight-editor"] select'));
  });

  it('does not call an amount wrong on the first digit, only after a pause or on leaving the field', async () => {
    accepts(async (body) => json({ status: 'review', review: reviewOf(of(body as never)) }));
    const host = await goalMix();
    await type(amountBox(host), '5');
    expect(host.textContent).not.toContain(en.mix.deposit.errors.belowMin);
    expect(amountBox(host).getAttribute('aria-invalid')).toBeNull();
    await fire(amountBox(host), new FocusEvent('focusout', { bubbles: true }));
    expect(host.textContent).toContain(en.mix.deposit.errors.belowMin);
    await type(amountBox(host), '7');
    expect(host.textContent).not.toContain(en.mix.deposit.errors.belowMin);
    await settle(CHECK_MS + 50);
    expect(host.textContent).toContain(en.mix.deposit.errors.belowMin);
  });

  it('says the wallet is checked before signing, and stores nothing while a reply is on its way', async () => {
    const calls = accepts(async (body) =>
      json({
        status: 'review',
        review: reviewOf({ ...of(body as never), warnings: [], unconfirmed: [] }),
      }),
    );
    const host = await mount(
      withAccount(
        'en',
        createElement(DepositStep, {
          chain: 'solana',
          userId,
          allocations: [{ assetId: 'solana:gldx', weightBps: 4000 }],
          said: SAID,
          amountText: '100',
          onAmountText: () => {},
          provenance: 'sandbox',
          onChangeMix: () => {},
          onClose: () => {},
          host: { onOpen: () => {}, onRunning: () => {}, onLeave: () => {} },
          waiting: true,
        }),
      ),
    );
    await settle(CHECK_MS + 50);
    expect(host.textContent).toContain(en.mix.deposit.balance);
    expect(press(host).getAttribute('aria-disabled')).toBe('true');
    expect(reason(host)).toBe(en.mix.deposit.blocked.reply);
    // checked, never stored: the mix may change with the reply
    expect(calls.every((call) => call.body.confirm === false)).toBe(true);
  });

  it('keeps the edited mark and the way back while the hand weights do not add up, and shows no stale mix', async () => {
    accepts(async (body) =>
      json({ status: 'review', review: reviewFor(body.allocations as never, of(body as never)) }),
    );
    const host = await goalMix();
    await deposit(host, '100');
    await openEditor(host);
    await type(find<HTMLInputElement>(host, '[data-ui="targets-lines"] input'), '140');
    expect(find(host, '[data-ui="deposit-edited"]').textContent).toBe(en.mix.deposit.edited);
    expect(host.querySelector('[data-action="reset-mix"]')).not.toBeNull();
    // the proposal's 40% is not shown as if it were the mix now
    expect(host.querySelector('[data-ui="mix-lines"]')).toBeNull();
    expect(find(host, '[data-ui="deposit-broken"]').textContent).toBe(en.mix.deposit.brokenMix);
    expect(reason(host)).toBe(en.mix.deposit.blocked.weights);
    await click(find(host, '[data-action="reset-mix"]'));
    expect(host.querySelector('[data-ui="deposit-edited"]')).toBeNull();
    expect(find(host, '[data-ui="mix-lines"]').textContent).toContain('40%');
  });
});

describe('a new goal’s mix, with a weight the person changed', () => {
  it('keeps the editor closed until asked, marks the mix as edited, and sends the person’s weights', async () => {
    const calls: Call[] = [];
    portStore.setApi(async (url, init) => {
      if (!url.endsWith('/goal/accept')) return json({}, 404);
      const body = JSON.parse(String(init?.body ?? '{}'));
      calls.push({ url, body });
      return json({
        status: 'review',
        review: reviewFor(body.allocations, { ...of(body), origin: 'person' }),
      });
    });
    const host = await goalMix();
    const open = find(host, '[data-action="edit-by-hand"]');
    expect(open.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('[data-ui="targets-lines"]')).toBeNull();
    expect(host.querySelector('[data-ui="deposit-edited"]')).toBeNull();
    await deposit(host, '100');
    expect(calls[0]?.body.origin).toBe('model');
    await openEditor(host);
    expect(open.getAttribute('aria-expanded')).toBe('true');
    // tidied: percents only, no count of lines
    expect(host.querySelectorAll('select')).toHaveLength(1);
    expect(host.textContent).not.toContain(en.mix.editor.unit);
    expect(host.textContent).not.toContain(en.mix.editor.lines(1));
    const weight = find<HTMLInputElement>(host, '[data-ui="targets-lines"] input');
    expect(weight.value).toBe('40');
    // a weight that does not read holds the press back
    await type(weight, '140');
    expect(reason(host)).toBe(en.mix.deposit.blocked.weights);
    await type(weight, '25');
    await settle(CHECK_MS + 50);
    expect(find(host, '[data-ui="deposit-edited"]').textContent).toBe(en.mix.deposit.edited);
    expect(calls.at(-1)?.body).toMatchObject({
      origin: 'person',
      confirm: false,
      allocations: [
        { assetId: 'solana:gldx', weightBps: 2500 },
        { assetId: 'solana:usdc', weightBps: 7500 },
      ],
    });
    // the read-only rows are the edited mix, with the server's dollars for it
    expect(find(host, '[data-ui="mix-lines"]').textContent).toContain('25%');
    expect(amounts(host)).toEqual({ 'solana:gldx': '$25.00', 'solana:usdc': '$75.00' });
    // stored as the person's weights once the warning is confirmed
    await click(ack(host));
    expect(calls.at(-1)?.body).toMatchObject({
      origin: 'person',
      confirm: true,
      allocations: [
        { assetId: 'solana:gldx', weightBps: 2500 },
        { assetId: 'solana:usdc', weightBps: 7500 },
      ],
    });
    // back to the proposed weights: the mix is the conversation's again
    await click(find(host, '[data-action="reset-mix"]'));
    await settle(CHECK_MS + 50);
    expect(host.querySelector('[data-ui="deposit-edited"]')).toBeNull();
    expect(calls.at(-1)?.body).toMatchObject({ origin: 'model' });
  });
});

describe('the weight editor of a vault the person owns', () => {
  const vaultPath = `/v1/vaults/solana/${derived}`;
  const showEditor = async (calls: Call[]) => {
    portStore.setApi(async (url, init) => {
      if (url === vaultPath && !init?.method) return json(read);
      if (url === `${vaultPath}/targets` && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        calls.push({ url, body });
        // The review reads back the lines sent, as the server does.
        return json({
          status: 'review',
          review: reviewFor(body.allocations, { origin: 'person' }),
        });
      }
      return json({}, 404);
    });
    const { TargetsScreen } = await import('./TargetsScreen');
    // Mounted twice, as development does: the review still arrives.
    const host = await mount(
      withAccount(
        'en',
        createElement(
          StrictMode,
          null,
          createElement(TargetsScreen, { chain: 'solana', address: derived }),
        ),
      ),
    );
    await settle();
    return host;
  };
  const inputs = (host: HTMLElement) => [
    ...host.querySelectorAll<HTMLInputElement>('[data-ui="targets-lines"] input'),
  ];

  it('starts from the vault’s targets, shows the rest as cash, and says what to change', async () => {
    const calls: Call[] = [];
    const host = await showEditor(calls);
    expect(inputs(host).map((input) => input.value)).toEqual(['30']);
    expect(find(host, '[data-ui="targets-cash"]').textContent).toBe(en.mix.editor.cash('70%'));
    await type(inputs(host)[0] as HTMLInputElement, '120');
    expect(host.textContent).toContain(en.mix.editor.issues['not-whole']);
    await type(inputs(host)[0] as HTMLInputElement, '');
    expect(find(host, '[data-ui="targets-issues"]').textContent).toContain(
      en.mix.editor.issues['all-cash'],
    );
    const review = find(host, '[data-action="targets-review"]');
    expect(review.getAttribute('aria-disabled')).toBe('true');
    await click(review);
    expect(calls).toEqual([]);
  });

  it('empties a weight that did not read when the unit changes, never giving it another meaning', async () => {
    const host = await showEditor([]);
    await type(inputs(host)[0] as HTMLInputElement, '150');
    const unit = host.querySelector('select') as HTMLSelectElement;
    unit.value = 'bps';
    unit.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(inputs(host)[0]?.value).toBe('');
    expect(find(host, '[data-action="targets-review"]').getAttribute('aria-disabled')).toBe('true');
  });

  it('switches between percents and basis points without changing a weight, and sends the person’s mix', async () => {
    const calls: Call[] = [];
    const host = await showEditor(calls);
    await type(inputs(host)[0] as HTMLInputElement, '62.5');
    const unit = host.querySelector('select') as HTMLSelectElement;
    unit.value = 'bps';
    unit.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(inputs(host)[0]?.value).toBe('6250');
    expect(find(host, '[data-ui="targets-cash"]').textContent).toBe(en.mix.editor.cash('37.5%'));
    await click(find(host, '[data-action="targets-review"]'));
    await settle();
    expect(calls[0]?.body).toMatchObject({
      origin: 'person',
      confirm: false,
      allocations: [
        { assetId: 'solana:gldx', weightBps: 6250 },
        { assetId: 'solana:usdc', weightBps: 3750 },
      ],
    });
    expect(find(host, '[data-ui="mix-review-lines"]')).not.toBeNull();
  });
});
