// @vitest-environment happy-dom
import { type OrderDetail, TRUST_STATUS } from '@colosseum/schemas';
import { basketIdOfPlan, type ExecutionResult, type ExecutorDeps } from '@colosseum/sdk';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, settle, unmountAll } from '../../components/ui/test/dom';
import { dictionary } from '../../i18n';
import type { Person } from '../account/person';
import { withAccount } from '../account/test/screen';
import { OrderScreen } from '../order/OrderScreen';
import type { OrderRecord } from '../order/order-record';
import { EMBEDDED, json, signedInPort } from '../wallet/test/fake-port';
import { portStore } from '../wallet/test/mock-provider';
import type { SharedTerms } from './terms';
import {
  FAMILY_ID,
  familyBuyOrder,
  followOrder,
  ORDER_ID,
  publishOrder,
  RECIPE,
  rebalanceOrder,
  SLUG,
  USER,
  VAULT,
  WEIGHTS,
} from './test/fixtures';

// The order screen with an order about a shared portfolio (WEB-4), on the real runner: only `execute`
// is a double, which records what it is handed. The guard's terms are the ones the screen that made
// the order kept (terms.ts): the publish form's id, text and weights, the version and weights a follow
// read. Never the order the API answered: an order whose shape or trades are not those terms is shown
// and not offered for signing.

const run = vi.hoisted(() => ({
  calls: [] as { order: OrderDetail; deps: ExecutorDeps }[],
}));

vi.mock('@colosseum/sdk', async (original) => ({
  ...(await original<typeof import('@colosseum/sdk')>()),
  execute: (order: OrderDetail, deps: ExecutorDeps) => {
    run.calls.push({ order, deps });
    return Promise.resolve({ status: 'done', order } as unknown as ExecutionResult);
  },
}));
vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('../wallet/signing', () => import('../wallet/test/mock-signing'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));

const en = dictionary('en');

function installLocks() {
  const locks = {
    request: async (
      _name: string,
      _options: object,
      work: (lock: { name: string }) => Promise<unknown>,
    ) => work({ name: 'order' }),
  };
  Object.defineProperty(window.navigator, 'locks', { value: locks, configurable: true });
}

const person: Person = {
  userId: USER,
  wallets: EMBEDDED,
  chain: 'solana',
  chainSource: 'picked',
  chainOptions: [],
};

function api(order: OrderDetail) {
  portStore.setApi(async (path) => {
    if (path === '/v1/me') return json(person);
    if (path === `/v1/orders/${ORDER_ID}`) return json(order);
    return json({ error: 'not found' }, 404);
  });
}

function seed(terms: SharedTerms, amountUsd = 0) {
  const record: OrderRecord = {
    orderId: ORDER_ID,
    userId: USER,
    proposalId: '',
    chain: 'solana',
    amountUsd,
    lines: [],
    terms,
    approved: null,
  };
  window.localStorage.setItem(`tf-order:${ORDER_ID}`, JSON.stringify(record));
}

const screen = async () => {
  const host = await mount(withAccount('en', createElement(OrderScreen, { id: ORDER_ID })));
  await settle();
  await settle();
  return host;
};
const primary = (host: HTMLElement) =>
  host.querySelector<HTMLElement>('[data-variant="primary"]') as HTMLElement;
/** Past the review of what changes to the first step (gate SIGN-ONE-STEP): approves nothing. */
const onward = async (host: HTMLElement) => {
  await click(host.querySelector('[data-action="order-continue"]') as HTMLElement);
  await settle();
};
const tick = async (host: HTMLElement) => {
  for (const box of host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
    await click(box);
};

const PUBLISH: SharedTerms = {
  kind: 'publish',
  action: 'publish',
  familyId: FAMILY_ID,
  components: WEIGHTS,
  text: {
    slug: SLUG,
    name: 'Three <b>of</b> the largest',
    copy: 'See https://x.invalid',
    kind: 'index',
  },
  version: 1,
};
const FAMILY: SharedTerms = {
  kind: 'family',
  slug: SLUG,
  familyId: FAMILY_ID,
  follow: { recipeOnchainId: RECIPE, version: 2 },
  targets: WEIGHTS,
  source: 'chain',
};
const FOLLOW: SharedTerms = {
  kind: 'follow',
  slug: SLUG,
  familyId: FAMILY_ID,
  vault: VAULT,
  basketId: '42',
  follow: { recipeOnchainId: RECIPE, version: 2 },
  autoFollow: true,
  source: 'api',
};

beforeEach(() => {
  window.localStorage.clear();
  // The person accepted the trust notice before, with the keeper's limits shown: an order opened
  // here by someone who never did is held for it (see "the trust notice on the order's own page").
  window.localStorage.setItem(
    `tf-trust:${USER}`,
    JSON.stringify({ textVersion: TRUST_STATUS.textVersion, keeperShown: true }),
  );
  run.calls.length = 0;
  installLocks();
  portStore.set(signedInPort(EMBEDDED, { userId: USER }));
});
afterEach(unmountAll);

describe('a publish on the order screen', () => {
  it('shows the form’s text as text, asks the consent, and hands the executor the form’s terms', async () => {
    api(publishOrder());
    seed(PUBLISH);
    const host = await screen();
    const review = find(host, `[aria-label="${en.order.shared.publishTitle}"]`);
    // the creator's words are text: no element and no link are made of them
    expect(review.textContent).toContain('Three <b>of</b> the largest');
    expect(review.querySelector('b')).toBeNull();
    expect(review.querySelector('a')).toBeNull();
    expect(review.textContent).toContain(FAMILY_ID);
    // no deposit is shown for an order that deposits nothing
    expect(host.textContent).not.toContain(en.order.review.deposit);
    // the consent holds the way on to the steps; the step's button then names what it signs
    expect(primary(host).textContent).toContain(en.order.flow.continue);
    expect(primary(host).getAttribute('aria-disabled')).toBe('true');
    await tick(host);
    await onward(host);
    expect(run.calls).toHaveLength(0);
    expect(primary(host).textContent).toContain(en.order.flow.press.publish);
    await click(primary(host));
    await settle();
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.deps.plan).toEqual({
      basketId: '0',
      publish: {
        action: 'publish',
        familyId: FAMILY_ID,
        components: WEIGHTS,
        text: PUBLISH.kind === 'publish' ? PUBLISH.text : null,
        version: 1,
      },
    });
    expect(run.calls[0]?.deps.consents).toEqual(['publish']);
  });

  it('offers nothing to sign when the order has a step the publish does not call for', async () => {
    api(
      publishOrder([
        {
          id: '99999999-9999-4999-8999-999999999999',
          orderId: ORDER_ID,
          chain: 'solana',
          seq: 1,
          kind: 'set_auto_follow',
          signer: 'owner',
          description: 'server text',
          trades: [],
          expected: [],
          status: 'planned',
          attempt: 0,
          txId: null,
          explorerUrl: null,
          validUntil: null,
          error: null,
          trigger: 'manual',
          provenance: 'sandbox',
        },
      ]),
    );
    seed(PUBLISH);
    const host = await screen();
    expect(host.querySelector('[data-variant="primary"]')).toBeNull();
    expect(find(host, '[role="alert"]').textContent).toContain(en.order.mismatch.shape);
  });
});

describe('a buy that follows a shared portfolio, on the order screen', () => {
  it('holds the trades to the weights read, and hands the executor the version followed', async () => {
    api(familyBuyOrder());
    seed(FAMILY, 10);
    const host = await screen();
    expect(find(host, `[aria-label="${en.order.shared.followTitle}"]`).textContent).toContain(SLUG);
    await onward(host);
    await click(primary(host));
    await settle();
    expect(run.calls[0]?.deps.plan).toEqual({
      basketId: basketIdOfPlan(FAMILY_ID),
      follow: { recipeOnchainId: RECIPE, version: 2 },
      autoFollow: false,
    });
  });

  it('offers nothing to sign when the API spends the deposit on other weights', async () => {
    api(familyBuyOrder(['5000000', '2500000', '2500000']));
    seed(FAMILY, 10);
    const host = await screen();
    expect(host.querySelector('[data-variant="primary"]')).toBeNull();
    expect(find(host, '[role="alert"]').textContent).toContain(en.order.mismatch.trades);
    expect(run.calls).toHaveLength(0);
  });
});

describe('a follow by a vault, on the order screen', () => {
  it('hands the executor the vault’s plan number, the version and the switch, with both consents', async () => {
    api(followOrder(['accept_version', 'set_auto_follow']));
    seed(FOLLOW);
    const host = await screen();
    expect(host.textContent).toContain(en.shared.check.notChecked);
    expect(primary(host).textContent).toContain(en.order.flow.continue);
    await tick(host);
    await onward(host);
    expect(primary(host).textContent).toContain(en.order.flow.press.follow);
    await click(primary(host));
    await settle();
    expect(run.calls[0]?.deps.plan).toEqual({
      basketId: '42',
      follow: { recipeOnchainId: RECIPE, version: 2 },
      autoFollow: true,
    });
    expect(run.calls[0]?.deps.consents).toEqual(['new_asset', 'auto_follow_on']);
  });

  it('offers nothing to sign when the order accepts a version the screen did not ask for', async () => {
    api(followOrder(['accept_version', 'set_auto_follow']));
    seed({ ...FOLLOW, follow: null });
    const host = await screen();
    expect(host.querySelector('[data-variant="primary"]')).toBeNull();
    expect(find(host, '[role="alert"]').textContent).toContain(en.order.mismatch.shape);
  });

  it('once done with auto-follow off, says the holdings are not traded yet and leads to the rebalance; with it on, the keeper’s', async () => {
    for (const autoFollow of [false, true]) {
      const open = followOrder(
        autoFollow ? ['accept_version', 'set_auto_follow'] : ['accept_version'],
      );
      // not while it is still to be signed
      api(open);
      seed({ ...FOLLOW, autoFollow });
      expect((await screen()).querySelector('[data-ui="follow-done"]')).toBeNull();
      await unmountAll();
      // read back with every step confirmed
      api({
        ...open,
        status: 'done',
        legs: open.legs.map((l) => ({ ...l, status: 'confirmed', txId: 'sig' })),
      } as typeof open);
      const host = await screen();
      const done = host.querySelector('[data-ui="follow-done"]');
      expect(done !== null).toBe(!autoFollow);
      if (done) {
        expect(done.textContent).toContain(en.order.shared.followDone);
        const link = find(host, '[data-action="follow-rebalance"]');
        expect(link.textContent).toBe(en.order.shared.followRebalance);
        expect(link.getAttribute('href')).toBe(`/vaults/solana/${VAULT}?do=rebalance`);
      }
      await unmountAll();
    }
  });
});

describe('a rebalance to a vault’s targets, on the order screen', () => {
  const REBALANCE: SharedTerms = {
    kind: 'rebalance',
    vault: VAULT,
    basketId: '42',
    targets: [
      { asset: 'solana:paxg', weightBps: 2_000 },
      { asset: 'solana:syrupusdc', weightBps: 3_000 },
    ],
    trades: rebalanceOrder().legs.flatMap((l) => l.trades),
  };
  it('hands the guard the targets and the reviewed trades, and nothing that could change the vault', async () => {
    api(rebalanceOrder());
    seed(REBALANCE);
    const host = await screen();
    expect(primary(host).textContent).toContain(en.order.flow.continue);
    await onward(host);
    // the first swap alone, with a button that names it and its amount
    expect(primary(host).textContent).toContain(en.order.flow.press.rebalance);
    await click(primary(host));
    await settle();
    // the targets and the reviewed trades: the guard refuses any other step or trade
    expect(run.calls[0]?.deps.plan).toEqual({
      basketId: '42',
      rebalance: { targets: REBALANCE.targets, trades: REBALANCE.trades },
    });
    expect(run.calls[0]?.deps.consents).toEqual([]);
  });

  it.each([
    [
      'a step that sets targets',
      [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', seq: 9, kind: 'set_targets' }],
    ],
    [
      'a step that follows a portfolio',
      [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', seq: 9, kind: 'accept_version' }],
    ],
    [
      'a withdrawal',
      [
        {
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          seq: 9,
          kind: 'withdraw',
          withdrawals: [{ asset: 'solana:usdc', amountRaw: null, heldRaw: '1' }],
        },
      ],
    ],
  ])('offers nothing to sign when the order also has %s', async (_what, more) => {
    const base = rebalanceOrder();
    const template = base.legs[0];
    api({
      ...base,
      legs: [...base.legs, ...more.map((m) => ({ ...template, trades: [], expected: [], ...m }))],
    } as typeof base);
    seed(REBALANCE);
    const host = await screen();
    expect(host.querySelector('[data-variant="primary"]')).toBeNull();
    expect(find(host, '[role="alert"]').textContent).toContain(en.order.mismatch.shape);
  });

  it('offers nothing to sign when a swap acquires an asset that is no target of the vault', async () => {
    api(rebalanceOrder([{ sell: 'solana:usdc', buy: 'solana:tslax', amountInRaw: '1000000' }]));
    seed(REBALANCE);
    const host = await screen();
    expect(host.querySelector('[data-variant="primary"]')).toBeNull();
  });
});
