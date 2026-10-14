// @vitest-environment happy-dom
import type { OrderDetail, VaultView } from '@colosseum/schemas';
import { type ExecutionResult, type ExecutorDeps, solanaVaultAddress } from '@colosseum/sdk';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, settle, type, unmountAll } from '../../components/ui/test/dom';
import { dictionary } from '../../i18n';
import type { Person } from '../account/person';
import { withAccount } from '../account/test/screen';
import { SETTLE_MS } from '../amount/AmountCard';
import { OrderScreen } from '../order/OrderScreen';
import { dollarsShapeOk } from '../order/order-check';
import { type OrderRecord, recallOrder } from '../order/order-record';
import { EMBEDDED, fakePort, json, SOLANA, signedInPort } from '../wallet/test/fake-port';
import { router } from '../wallet/test/mock-next';
import { portStore } from '../wallet/test/mock-provider';
import { readTerms, type SharedTerms } from './terms';
import { CREATOR, dollarsOrder, ORDER_ID, USER, vaultOf, withdrawOrder } from './test/fixtures';
import { shareBpsOf, WithdrawScreen } from './WithdrawScreen';

// A withdrawal in the browser (WITHDRAW), with real events against a double of the API: the screen
// that chooses and reviews what leaves a vault, for its owner only, and the order screen that is handed
// those terms. Only `execute` is a double: it records what the guard would be held to. What the order
// may sign is what the person reviewed, never the order the API answered.

const run = vi.hoisted(() => ({
  calls: [] as { order: OrderDetail; deps: ExecutorDeps }[],
}));
vi.mock('@colosseum/sdk', async (original) => ({
  ...(await original<typeof import('@colosseum/sdk')>()),
  execute: (order: OrderDetail, deps: ExecutorDeps) => {
    run.calls.push({ order, deps });
    // As the executor answers once every step has confirmed: the order, done.
    return Promise.resolve({
      status: 'done',
      order: { ...order, status: 'done' },
    } as unknown as ExecutionResult);
  },
}));
vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('../wallet/signing', () => import('../wallet/test/mock-signing'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));

const en = dictionary('en');
const w = en.withdraw;

/** The vault of the fake port's wallet for plan 42, as the guard derives it on Solana's test network. */
const MY_VAULT = solanaVaultAddress('529j92ASeopFHuLLueGdyaUy4BsZ7UWqrgoVWn2iK1QW', SOLANA, '42');
const CASH = 'solana:usdc';
const SPYX = 'solana:spyx';
const holding = (asset: string, raw: string) => ({ asset, raw, multiplier: '1', display: raw });
/** 600 USDC and 2.5 SPYx. */
const holdingVault = (over: Partial<VaultView> = {}) =>
  vaultOf({
    address: MY_VAULT,
    cash: holding(CASH, '600000000'),
    positions: [
      {
        ...holding(SPYX, '250000000'),
        targetBps: 4_000,
        lastKeeperAt: null,
        valueUsd: '400',
        weightBps: 4_000,
        driftBps: 0,
      },
    ] as VaultView['positions'],
    valueUsd: '1000',
    ...over,
  });

type Call = { method: string; path: string; body?: unknown };
const person: Person = {
  userId: USER,
  wallets: EMBEDDED,
  chain: 'solana',
  chainSource: 'picked',
  chainOptions: [],
};

function api(
  o: {
    vault?: VaultView | null;
    order?: () => Response | OrderDetail;
    /** GET /v1/portfolio/exposure: Bearing's measured cost of selling each holding, where it has one. */
    exposure?: () => Response;
  } = {},
) {
  const calls: Call[] = [];
  const vault = o.vault === undefined ? holdingVault() : o.vault;
  portStore.setApi(async (path, init) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path === '/v1/me') return json(person);
    if (path.startsWith('/v1/vaults/solana/'))
      return vault
        ? json({
            chain: 'solana',
            name: 'Solana',
            mode: 'live',
            provenance: 'sandbox',
            vault: { ...vault, provenance: 'sandbox' },
            prices: [],
            disclaimer: 'the disclaimer',
          })
        : json({ error: 'no vault at that address' }, 404);
    if (path.startsWith('/v1/portfolio/exposure'))
      return o.exposure?.() ?? json({ error: 'not here' }, 404);
    if (path === '/v1/orders' && method === 'POST') {
      const answer = o.order?.() ?? withdrawOrder([[item(CASH, null, '600000000')]]);
      return answer instanceof Response ? answer : json(answer);
    }
    if (path === `/v1/orders/${ORDER_ID}`)
      return json(o.order?.() ?? withdrawOrder([[item(CASH, null, '600000000')]]));
    return json({ error: 'not found' }, 404);
  });
  return {
    calls,
    placed: () => calls.filter((c) => c.path === '/v1/orders' && c.method === 'POST'),
  };
}
/** A token as a review keeps it: with the multiplier its amounts are shown with. */
const term = (asset: string, amountRaw: string | null, heldRaw: string, multiplier = '1') => ({
  asset,
  amountRaw,
  heldRaw,
  multiplier,
});
/** A token as a step of an order carries it. */
const item = (asset: string, amountRaw: string | null, heldRaw: string) => ({
  asset,
  amountRaw,
  heldRaw,
});

const show = async () => {
  const host = await mount(
    withAccount('en', createElement(WithdrawScreen, { chain: 'solana', address: MY_VAULT })),
  );
  await settle();
  await settle();
  return host;
};
/** The amount card's one button (gate AMOUNT-CARD): it names the withdrawal and makes the order. */
const button = (host: HTMLElement) =>
  find<HTMLButtonElement>(host, 'button[data-action="amount-withdraw"]');
const held = (host: HTMLElement) => button(host).getAttribute('aria-disabled') === 'true';
/** What the button says now, not its busy words. */
const label = (host: HTMLElement) =>
  [...button(host).querySelectorAll('span span')].find(
    (span) => span.getAttribute('aria-hidden') !== 'true',
  )?.textContent;
/** 25% · 50% · 75% · Max under the field. */
const chip = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll<HTMLElement>('[data-ui="amount-chips"] button')].find(
    (b) => b.textContent === label,
  ) as HTMLElement;
/** The amount in dollars of the vault's value. */
const field = (host: HTMLElement) => find<HTMLInputElement>(host, '[data-ui="amount-well"] input');
/** What reaches the wallet, and what the details say. */
const gets = (host: HTMLElement) => find(host, '[data-ui="amount-preview"]');
const details = (host: HTMLElement) => find(host, '[data-ui="amount-details"]');
/** The tokens chosen one by one, behind their own control. */
const choose = async (host: HTMLElement) =>
  click(find(host, 'button[data-action="withdraw-pick"]'));
const pick = (host: HTMLElement, asset: string) =>
  find(host, `[data-ui="withdraw-picks"] li[data-asset="${asset}"]`);
/** Each token that leaves, as its line says. */
const tokens = (host: HTMLElement) =>
  [...gets(host).querySelectorAll('[data-ui="withdraw-tokens"] li')].map((li) => li.textContent);
/** Each holding sold, as its row reads in the details: the holding, the amount sold, the cost. */
const sales = (host: HTMLElement) =>
  [...host.querySelectorAll('[data-ui="withdraw-sales"] tbody tr')].map((tr) =>
    [...tr.querySelectorAll('th, td')].map((cell) => cell.textContent).join(' | '),
  );

/** The press, and the answer it waits for. */
async function through(host: HTMLElement) {
  await click(button(host));
  await settle();
  await settle();
}

beforeEach(() => {
  window.localStorage.clear();
  run.calls.length = 0;
  router.push.mockClear();
  Object.defineProperty(window.navigator, 'locks', {
    value: {
      request: async (_n: string, _o: object, work: (lock: { name: string }) => Promise<unknown>) =>
        work({ name: 'order' }),
    },
    configurable: true,
  });
  portStore.set(signedInPort(EMBEDDED, { userId: USER }));
});
afterEach(unmountAll);

describe('the withdraw screen', () => {
  it('is the owner’s alone: anybody else’s vault, or none, offers nothing', async () => {
    const server = api({ vault: holdingVault({ owner: CREATOR }) });
    const theirs = await show();
    expect(theirs.textContent).toContain(w.notYours);
    expect(theirs.querySelector('[data-ui="amount-card"]')).toBeNull();
    await unmountAll();
    api({ vault: null });
    expect((await show()).textContent).toContain(w.notYours);
    await unmountAll();
    // signed out: asked to sign in, and nothing is read
    portStore.set(fakePort());
    const out = await show();
    expect(out.textContent).toContain(en.plan.signedOut);
    expect(server.placed()).toEqual([]);
  });

  it('says plainly that an emptied vault is empty', async () => {
    api({ vault: holdingVault({ cash: holding(CASH, '0'), positions: [] }) });
    const host = await show();
    expect(host.textContent).toContain(w.empty);
    expect(host.querySelector('[data-ui="amount-card"]')).toBeNull();
  });

  it('is the amount card: the vault’s value with its pin, quick shares, and the one button held until an amount', async () => {
    const server = api();
    const host = await show();
    const balance = find(host, '[data-ui="amount-balance"]');
    expect(balance.textContent).toContain(`${en.amount.balance.vault}:`);
    expect(balance.textContent).toContain('$1,000');
    expect(balance.querySelector('button[data-ui="pin"]')).not.toBeNull();
    expect(
      [...host.querySelectorAll('[data-ui="amount-chips"] button')].map((b) => b.textContent),
    ).toEqual(['25%', '50%', '75%', en.amount.out.max]);
    expect(held(host)).toBe(true);
    expect(label(host)).toBe(en.amount.enter);
    await click(button(host));
    expect(server.placed()).toEqual([]);
    // one primary button on the card
    expect(host.querySelectorAll('[data-variant="primary"]')).toHaveLength(1);
  });

  it('everything: shows each token and the owner’s own address, then orders exactly that', async () => {
    const server = api({
      order: () =>
        withdrawOrder([[item(CASH, null, '600000000')], [item(SPYX, null, '250000000')]]),
    });
    const host = await show();
    await click(chip(host, en.amount.out.max));
    expect(field(host).value).toBe('1000');
    expect(tokens(host)).toEqual([w.check.all('600 USDC'), w.check.all('2.5 SPYx')]);
    // where it goes: the owner's own wallet, in full, and nowhere else
    expect(find(details(host), '[data-ui="withdraw-to"]').textContent).toBe(SOLANA);
    expect(details(host).textContent).toContain(MY_VAULT);
    expect(details(host).textContent).toContain(w.check.emptied);
    expect(details(host).textContent).toContain(w.check.noSale);
    expect(label(host)).toBe(en.amount.press.withdrawAll);
    await through(host);
    expect(server.placed().map((c) => c.body)).toEqual([
      { type: 'withdraw', vaults: [MY_VAULT], sellToCash: false },
    ]);
    expect(recallOrder(ORDER_ID, USER)?.terms).toEqual({
      kind: 'withdraw',
      vault: MY_VAULT,
      basketId: '42',
      owner: SOLANA,
      everything: true,
      items: [term(CASH, null, '600000000'), term(SPYX, null, '250000000')],
      autoFollowOff: false,
    });
    expect(router.push).toHaveBeenCalledWith(`/orders/${ORDER_ID}`);
  });

  it('a share typed in dollars: that share of each token, rounded down, and the rest stays', async () => {
    const server = api({
      order: () =>
        withdrawOrder([
          [item(CASH, '150000000', '600000000')],
          [item(SPYX, '62500000', '250000000')],
        ]),
    });
    const host = await show();
    await type(field(host), '250');
    // a quarter of $1,000: a quarter of each token
    expect(tokens(host)).toEqual(['150 USDC', '0.625 SPYx']);
    expect(chip(host, '25%').getAttribute('aria-pressed')).toBe('true');
    expect(details(host).textContent).toContain(w.check.stays);
    expect(label(host)).toBe(en.amount.press.withdraw('$250'));
    await through(host);
    expect(server.placed().map((c) => c.body)).toEqual([
      {
        type: 'withdraw',
        vaults: [MY_VAULT],
        sellToCash: false,
        withdrawals: [
          { asset: CASH, amountRaw: '150000000' },
          { asset: SPYX, amountRaw: '62500000' },
        ],
      },
    ]);
  });

  it('on a $1,000,000 vault: refuses less than one basis point, and names what the basis points come to', async () => {
    const server = api({
      vault: holdingVault({ valueUsd: '1000000' }),
      order: () =>
        withdrawOrder([[item(CASH, '60000', '600000000')], [item(SPYX, '25000', '250000000')]]),
    });
    const host = await show();
    // a cent, and $99.99, are less than one basis point ($100): refused, with the least named
    for (const under of ['0.01', '99.99']) {
      await type(field(host), under);
      await settle(SETTLE_MS + 50);
      expect(find(host, '[data-ui="amount-problem"]').textContent, under).toBe(
        en.amount.errors.belowMin('$100'),
      );
      expect(held(host), under).toBe(true);
    }
    // $150 is one basis point, cut down: the button and "You get" say $100, never $150
    await type(field(host), '150');
    await settle(SETTLE_MS + 50);
    expect(host.querySelector('[data-ui="amount-problem"]')).toBeNull();
    expect(label(host)).toBe(en.amount.press.withdraw('$100'));
    expect(find(host, '[data-ui="withdraw-worth"]').textContent).toContain(
      en.amount.preview.about('$100'),
    );
    expect(tokens(host)).toEqual(['0.06 USDC', '0.00025 SPYx']);
    await through(host);
    expect(server.placed().map((c) => c.body)).toEqual([
      {
        type: 'withdraw',
        vaults: [MY_VAULT],
        sellToCash: false,
        withdrawals: [
          { asset: CASH, amountRaw: '60000' },
          { asset: SPYX, amountRaw: '25000' },
        ],
      },
    ]);
  });

  it('on a $300 vault: the least it names, three cents, is one basis point, and goes on', async () => {
    const server = api({
      vault: holdingVault({ valueUsd: '300' }),
      order: () =>
        withdrawOrder([[item(CASH, '60000', '600000000')], [item(SPYX, '25000', '250000000')]]),
    });
    const host = await show();
    await type(field(host), '0.02');
    await settle(SETTLE_MS + 50);
    expect(find(host, '[data-ui="amount-problem"]').textContent).toBe(
      en.amount.errors.belowMin('$0.03'),
    );
    await type(field(host), '0.03');
    await settle(SETTLE_MS + 50);
    // not a hair under one basis point: no problem, and the button names what it sends
    expect(host.querySelector('[data-ui="amount-problem"]')).toBeNull();
    expect(held(host)).toBe(false);
    expect(label(host)).toBe(en.amount.press.withdraw('$0.03'));
    await through(host);
    expect(server.placed().at(-1)?.body).toMatchObject({
      withdrawals: [
        { asset: CASH, amountRaw: '60000' },
        { asset: SPYX, amountRaw: '25000' },
      ],
    });
  });

  it('says quietly when the amount is more than the vault holds, and holds the press', async () => {
    api();
    const host = await show();
    await type(field(host), '1500');
    await settle(SETTLE_MS + 50);
    expect(find(host, '[data-ui="amount-problem"]').textContent).toBe(en.amount.errors.overVault);
    expect(held(host)).toBe(true);
  });

  it('part of the cash, chosen by hand: that amount, in raw units, and the rest stays', async () => {
    const server = api({ order: () => withdrawOrder([[item(CASH, '250500000', '600000000')]]) });
    const host = await show();
    await choose(host);
    // nothing chosen yet: nothing to withdraw
    expect(held(host)).toBe(true);
    expect(host.textContent).toContain(w.what.errors.none);
    await click(find(pick(host, CASH), 'input[type="checkbox"]'));
    expect(pick(host, CASH).textContent).toContain(w.what.holds('600 USDC'));
    await type(find<HTMLInputElement>(pick(host, CASH), 'input[inputmode="decimal"]'), '250.5');
    expect(tokens(host)).toEqual(['250.5 USDC']);
    expect(details(host).textContent).toContain(w.check.stays);
    expect(host.querySelector('[data-ui="withdraw-keeper"]')).toBeNull();
    expect(label(host)).toBe(en.amount.press.withdrawPicked(1));
    await through(host);
    expect(server.placed().map((c) => c.body)).toEqual([
      {
        type: 'withdraw',
        vaults: [MY_VAULT],
        sellToCash: false,
        withdrawals: [{ asset: CASH, amountRaw: '250500000' }],
      },
    ]);
    expect(recallOrder(ORDER_ID, USER)?.terms).toMatchObject({
      everything: false,
      items: [term(CASH, '250500000', '600000000')],
    });
  });

  it('holds the amount to the vault: exactly the balance goes on, one unit over does not', async () => {
    api();
    const host = await show();
    await choose(host);
    await click(find(pick(host, CASH), 'input[type="checkbox"]'));
    const input = find<HTMLInputElement>(pick(host, CASH), 'input[inputmode="decimal"]');
    for (const [typed, error] of [
      ['600.000001', w.what.errors.over('600 USDC')],
      ['601', w.what.errors.over('600 USDC')],
      ['abc', w.what.errors.amount],
      ['0', w.what.errors.amount],
      ['1.0000001', w.what.errors.amount],
    ] as const) {
      await type(input, typed);
      expect(pick(host, CASH).textContent, typed).toContain(error);
      expect(held(host), typed).toBe(true);
    }
    await type(input, '600');
    expect(held(host)).toBe(false);
    expect(tokens(host)).toEqual(['600 USDC']);
    // the stock token stays, so the vault is not emptied
    expect(details(host).textContent).toContain(w.check.stays);
  });

  it('says that automatic following stops, on a vault that has it on, whatever leaves, and orders it so', async () => {
    const server = api({
      vault: holdingVault({ autoFollow: true }),
      order: () =>
        withdrawOrder([[item(CASH, null, '600000000')], [item(SPYX, null, '250000000')]], {}, true),
    });
    const host = await show();
    // said on the card, never folded away, before anything is chosen
    expect(find(host, '[data-ui="withdraw-keeper"]').textContent).toBe(w.check.autoFollow);
    expect(find(host, '[data-ui="withdraw-keeper"]').closest('details')).toBeNull();
    expect(w.check.autoFollow).toMatch(/^Automatic following stops for this vault\./);
    await choose(host);
    await click(find(pick(host, SPYX), 'input[type="checkbox"]'));
    expect(host.querySelector('[data-ui="withdraw-keeper"]')).not.toBeNull();
    await choose(host);
    await click(chip(host, en.amount.out.max));
    await through(host);
    expect(server.placed()).toHaveLength(1);
    expect(recallOrder(ORDER_ID, USER)?.terms).toMatchObject({ autoFollowOff: true });
  });

  it('says nothing of auto-follow on a vault that has it off', async () => {
    api();
    const host = await show();
    await click(chip(host, en.amount.out.max));
    expect(host.querySelector('[data-ui="withdraw-keeper"]')).toBeNull();
  });

  it('shows a stock token as the portfolio does, with its multiplier, and signs exact raw units, rounded down', async () => {
    // SPYx: one token on the chain stands for 1.0057 shares. 2.5 tokens held are shown as 2.51425.
    const server = api({
      vault: holdingVault({
        positions: [
          {
            ...holding(SPYX, '250000000'),
            multiplier: '1.0057',
            display: '2.51425',
            targetBps: 4_000,
            lastKeeperAt: null,
            valueUsd: '400',
            weightBps: 4_000,
            driftBps: 0,
          },
        ] as VaultView['positions'],
      }),
      order: () => withdrawOrder([[item(SPYX, '99433230', '250000000')]]),
    });
    const host = await show();
    await choose(host);
    await click(find(pick(host, SPYX), 'input[type="checkbox"]'));
    expect(pick(host, SPYX).textContent).toContain(w.what.holds('2.51425 SPYx'));
    const input = find<HTMLInputElement>(pick(host, SPYX), 'input[inputmode="decimal"]');
    // more than is shown is refused, by a unit of the shown figure
    await type(input, '2.51425001');
    expect(pick(host, SPYX).textContent).toContain(w.what.errors.over('2.51425 SPYx'));
    // one share: 1 / 1.0057 of a token, rounded down, so never more than was typed
    await type(input, '1');
    expect(tokens(host)).toEqual(['0.99999999 SPYx']);
    await through(host);
    expect(server.placed().at(-1)?.body).toMatchObject({
      withdrawals: [{ asset: SPYX, amountRaw: '99433230' }],
    });
    expect(recallOrder(ORDER_ID, USER)?.terms).toMatchObject({
      items: [term(SPYX, '99433230', '250000000', '1.0057')],
    });
  });

  it('the whole shown balance is the whole raw balance, whatever the rounding', async () => {
    api({
      vault: holdingVault({
        positions: [
          {
            ...holding(SPYX, '250000001'),
            multiplier: '1.0057',
            display: '2.51425001',
            targetBps: 4_000,
            lastKeeperAt: null,
            valueUsd: '400',
            weightBps: 4_000,
            driftBps: 0,
          },
        ] as VaultView['positions'],
      }),
    });
    const host = await show();
    await choose(host);
    await click(find(pick(host, SPYX), 'input[type="checkbox"]'));
    // 250000001 raw is shown as 2.51425001 (rounded down from 2.514250010057)
    expect(pick(host, SPYX).textContent).toContain(w.what.holds('2.51425001 SPYx'));
    await type(
      find<HTMLInputElement>(pick(host, SPYX), 'input[inputmode="decimal"]'),
      '2.51425001',
    );
    expect(held(host)).toBe(false);
    // the cash stays, so the vault is not emptied; the stock token leaves in full
    expect(tokens(host)).toEqual(['2.51425001 SPYx']);
  });

  it('offers nothing for a vault it cannot hold to the person’s wallet', async () => {
    // A vault the API says is theirs under a plan number that does not lead to its address.
    const server = api({ vault: holdingVault({ basketId: '43' }) });
    const host = await show();
    await click(chip(host, en.amount.out.max));
    await through(host);
    expect(find(host, '[role="alert"]').textContent).toBe(w.confirm.blocked.vault);
    expect(server.placed()).toEqual([]);
    expect(router.push).not.toHaveBeenCalled();
  });

  it('shows the server’s refusal, keeps nothing and goes nowhere', async () => {
    api({
      order: () => json({ error: 'the vault holds no solana:usdc to withdraw' }, 409),
    });
    const host = await show();
    await click(chip(host, en.amount.out.max));
    await through(host);
    expect(find(host, '[role="alert"]').textContent).toBe(
      en.shared.publish.failure.said('the vault holds no solana:usdc to withdraw'),
    );
    expect(recallOrder(ORDER_ID, USER)).toBeNull();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('where the vault’s value is not known, takes a share by the quick chips alone', async () => {
    // a holding with no price: the value leaves it out, so no dollar amount is a share of it
    const vault = holdingVault();
    api({
      vault: {
        ...vault,
        positions: vault.positions.map((p) => ({ ...p, valueUsd: null })),
      } as VaultView,
      order: () =>
        withdrawOrder([
          [item(CASH, '300000000', '600000000')],
          [item(SPYX, '125000000', '250000000')],
        ]),
    });
    const host = await show();
    await settle(SETTLE_MS + 50);
    expect(host.querySelector('[data-ui="amount-balance"]')).toBeNull();
    expect(host.textContent).toContain(en.amount.out.noValue);
    await click(chip(host, '50%'));
    expect(tokens(host)).toEqual(['300 USDC', '1.25 SPYx']);
    expect(label(host)).toBe(en.amount.press.withdrawShare('50%'));
  });
});

describe('a withdrawal on the order screen', () => {
  const PART: SharedTerms = {
    kind: 'withdraw',
    vault: MY_VAULT,
    basketId: '42',
    owner: SOLANA,
    everything: false,
    items: [term(CASH, '250000000', '600000000'), term(SPYX, null, '250000000')],
    autoFollowOff: false,
  };
  const ALL: SharedTerms = { ...PART, everything: true, items: [term(CASH, null, '600000000')] };

  function seed(terms: SharedTerms) {
    const record: OrderRecord = {
      orderId: ORDER_ID,
      userId: USER,
      proposalId: '',
      chain: 'solana',
      amountUsd: 0,
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
  const sign = (host: HTMLElement) =>
    host.querySelector<HTMLElement>('[data-variant="primary"]') as HTMLElement | null;
  const asReviewed = () =>
    withdrawOrder([[item(CASH, '250000000', '600000000')], [item(SPYX, null, '250000000')]]);

  it('shows what leaves and the owner’s address, and hands the guard the reviewed tokens and amounts', async () => {
    api({ order: asReviewed });
    seed(PART);
    const host = await screen();
    const review = find(host, `[aria-label="${en.order.shared.withdrawTitle}"]`);
    expect([...review.querySelectorAll('tbody tr')].map((r) => r.textContent)).toEqual([
      'USDC250 USDC',
      `SPYx${w.check.all('2.5 SPYx')}`,
    ]);
    expect(find(review, '[data-ui="withdraw-to"]').textContent).toBe(SOLANA);
    expect(
      [...host.querySelectorAll('[data-ui="order-withdrawal"]')].map((l) => l.textContent),
    ).toEqual([en.order.shared.withdraws('250 USDC'), en.order.shared.withdrawsAll('2.5 SPYx')]);
    expect(host.textContent).not.toContain(en.order.review.deposit);
    expect(sign(host)?.textContent).toContain(en.order.shared.signWithdraw);
    await click(sign(host) as HTMLElement);
    await settle();
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.deps.plan).toEqual({
      basketId: '42',
      withdrawals: [
        { asset: CASH, amountRaw: '250000000' },
        { asset: SPYX, amountRaw: null },
      ],
    });
    // done: what stayed is read again on the portfolio
    await settle();
    const done = find(host, '[data-ui="withdraw-done"]');
    expect(done.textContent).toContain(en.order.shared.withdrawDone);
    expect(find(done, 'a').getAttribute('href')).toBe('/monitor');
  });

  it('everything: the guard is held to the vault, and may take any token it holds to its owner', async () => {
    api({ order: () => withdrawOrder([[item(CASH, null, '600000000')]]) });
    seed(ALL);
    const host = await screen();
    await click(sign(host) as HTMLElement);
    await settle();
    expect(run.calls[0]?.deps.plan).toEqual({ basketId: '42' });
  });

  it('a vault with auto-follow on: the switch off comes first, and the guard is told off and nothing else', async () => {
    api({ order: () => withdrawOrder([[item(CASH, null, '600000000')]], {}, true) });
    seed({ ...ALL, autoFollowOff: true });
    const host = await screen();
    const review = find(host, `[aria-label="${en.order.shared.withdrawTitle}"]`);
    expect(find(review, '[data-ui="withdraw-keeper"]').textContent).toBe(
      en.order.shared.autoFollowStops,
    );
    expect(host.querySelectorAll('[data-ui="order-step"]')).toHaveLength(2);
    await click(sign(host) as HTMLElement);
    await settle();
    expect(run.calls[0]?.deps.plan).toEqual({ basketId: '42', autoFollow: false });
  });

  it.each([
    ['a switch the review did not show', false, true],
    ['no switch where the review showed one', true, false],
  ])('is not offered for signing when the order has %s', async (_name, reviewed, ordered) => {
    api({ order: () => withdrawOrder([[item(CASH, null, '600000000')]], {}, ordered) });
    seed({ ...ALL, autoFollowOff: reviewed });
    const host = await screen();
    expect(host.textContent).toContain(en.order.mismatch.withdraw);
    expect(sign(host)).toBeNull();
  });

  it('a token that could not move: its step says so, and the order is done except for it, never plainly done', async () => {
    const answered = asReviewed();
    const order = {
      ...answered,
      status: 'done',
      legs: answered.legs.map((l, i) =>
        i === 0
          ? { ...l, status: 'confirmed', txId: 'sig' }
          : {
              ...l,
              status: 'skipped',
              error: { code: 'BalanceUnreadable', message: 'frozen', retryable: false },
            },
      ),
    } as OrderDetail;
    api({ order: () => order });
    seed(PART);
    const host = await screen();
    expect(find(host, '[data-ui="order-skipped"]').textContent).toBe(
      en.order.shared.skipped('SPYx'),
    );
    expect(host.textContent).toContain(en.order.shared.doneExcept('Solana', 1));
    expect(host.textContent).not.toContain(en.order.outcome.done('Solana'));
    expect(host.querySelectorAll('[data-ui="order-step"][data-status="skipped"]')).toHaveLength(1);
  });

  /** The reviewed order with every step confirmed on chain. */
  const confirmed = () => {
    const answered = asReviewed();
    return {
      ...answered,
      status: 'done',
      legs: answered.legs.map((l) => ({ ...l, status: 'confirmed', txId: 'sig' })),
    } as OrderDetail;
  };

  it('a withdrawal that stopped offers no Finish: that is for a buy with its cash in the vault', async () => {
    // one step landed, the next failed for good: nothing was deposited, and there is nothing to buy
    const answered = asReviewed();
    const stoppedOrder = {
      ...answered,
      status: 'failed',
      legs: answered.legs.map((l, i) =>
        i === 0
          ? { ...l, status: 'confirmed', txId: 'sig' }
          : {
              ...l,
              status: 'failed',
              error: { code: 'Unknown', message: 'it failed on chain', retryable: false },
            },
      ),
    } as OrderDetail;
    const server = api({ order: () => stoppedOrder });
    seed(PART);
    const host = await screen();
    await settle();
    expect(host.textContent).not.toContain(en.order.outcome.finish);
    expect(host.querySelector('[data-ui="order-stopped"] [data-variant="primary"]')).toBeNull();
    expect(host.querySelector('[data-ui="order-deposit-kept"]')).toBeNull();
    expect(server.calls.filter((c) => c.path.endsWith('/continue'))).toEqual([]);
    // and it is not called done
    expect(host.textContent).not.toContain(en.order.outcome.done('Solana'));
  });

  it('a token a confirmed step left behind: the vault is read again and the order is done except for it', async () => {
    // as an EVM vault's withdrawAll does: the step confirmed, and the vault still holds the token
    const server = api({ order: confirmed });
    seed(PART);
    const host = await screen();
    await settle();
    expect(server.calls.filter((c) => c.path.startsWith('/v1/vaults/solana/'))).toHaveLength(1);
    expect(host.textContent).toContain(en.order.shared.doneStayed('Solana', 'SPYx'));
    expect(host.textContent).not.toContain(en.order.outcome.done('Solana'));
    expect(find(host, '[data-ui="withdraw-stayed"]').textContent).toBe(
      en.order.shared.stayed('SPYx'),
    );
  });

  it('is plainly done only once the vault, read again, holds none of what was to leave whole', async () => {
    api({
      order: confirmed,
      // part of the cash was taken: what is left of it is no token left behind
      vault: holdingVault({ positions: [] }),
    });
    seed(PART);
    const host = await screen();
    await settle();
    expect(host.textContent).toContain(en.order.outcome.done('Solana'));
    expect(host.querySelector('[data-ui="withdraw-stayed"]')).toBeNull();
  });

  it('never says plainly done when the vault cannot be read again', async () => {
    api({ order: confirmed, vault: null });
    seed(PART);
    const host = await screen();
    await settle();
    expect(host.textContent).toContain(en.order.shared.doneUnread('Solana'));
    expect(host.textContent).not.toContain(en.order.outcome.done('Solana'));
  });

  it.each([
    [
      'a larger amount',
      () =>
        withdrawOrder([[item(CASH, '250000001', '600000000')], [item(SPYX, null, '250000000')]]),
    ],
    [
      'all of a token where part was reviewed',
      () => withdrawOrder([[item(CASH, null, '600000000')], [item(SPYX, null, '250000000')]]),
    ],
    [
      'another token',
      () =>
        withdrawOrder([[item(CASH, '250000000', '600000000')], [item('solana:qqqx', null, '1')]]),
    ],
    [
      'a token more',
      () =>
        withdrawOrder([
          [item(CASH, '250000000', '600000000')],
          [item(SPYX, null, '250000000')],
          [item('solana:qqqx', null, '1')],
        ]),
    ],
    ['a token fewer', () => withdrawOrder([[item(CASH, '250000000', '600000000')]])],
    [
      'a step that is no withdrawal',
      () => {
        const order = asReviewed();
        return {
          ...order,
          legs: order.legs.map((l, i) =>
            i === 1 ? { ...l, kind: 'set_auto_follow', withdrawals: undefined } : l,
          ),
        } as OrderDetail;
      },
    ],
    ['a deposit beside it', () => ({ ...asReviewed(), depositRaw: '1' }) as OrderDetail],
  ])(
    'is not offered for signing when the order takes %s than the review showed',
    async (_name, order) => {
      api({ order });
      seed(PART);
      const host = await screen();
      expect(host.textContent).toContain(en.order.mismatch.withdraw);
      expect(sign(host)).toBeNull();
      expect(run.calls).toEqual([]);
    },
  );
});

// In dollars (gate WITHDRAW-DOLLARS): the same vault, 600 USDC and 2.5 SPYx.
const way = (host: HTMLElement, which: 'tokens' | 'dollars') =>
  host.querySelectorAll<HTMLInputElement>('[data-ui="withdraw-way"] input')[
    which === 'tokens' ? 0 : 1
  ] as HTMLInputElement;
/** All of it: the 2.5 SPYx sold for at least 395 USDC, and the 600 USDC of cash. */
const allOrder = (over: Parameters<typeof dollarsOrder>[2] = {}, off = false) =>
  dollarsOrder(
    [{ sell: SPYX, amountInRaw: '250000000', minOutRaw: '395000000' }],
    { heldRaw: '600000000', cashRaw: '600000000' },
    over,
    off,
  );
const ALL_DOLLARS: SharedTerms = {
  kind: 'withdraw',
  vault: MY_VAULT,
  basketId: '42',
  owner: SOLANA,
  everything: false,
  items: [term(CASH, null, '600000000')],
  autoFollowOff: false,
  dollars: {
    shareBps: 10_000,
    sales: [{ asset: SPYX, amountRaw: '250000000' }],
    cashRaw: '600000000',
  },
};

describe('the withdraw screen, in dollars', () => {
  it('offers two ways, the tokens themselves first and chosen, and the dollars as the chain’s cash token', async () => {
    api();
    const host = await show();
    expect(way(host, 'tokens').checked).toBe(true);
    const group = find(host, '[data-ui="withdraw-way"]');
    expect(group.textContent).toContain(en.amount.out.asTokens);
    expect(group.textContent).toContain(en.amount.out.asCash('USDC'));
    // what the way chosen means, one at a time, in the details
    expect(find(host, '[data-ui="withdraw-way-hint"]').textContent).toBe(w.way.tokensHint);
    // the tokens one by one are there until dollars is chosen
    expect(host.querySelector('button[data-action="withdraw-pick"]')).not.toBeNull();
    await click(way(host, 'dollars'));
    expect(find(host, '[data-ui="withdraw-way-hint"]').textContent).toBe(w.way.dollarsHint('USDC'));
    expect(host.querySelector('button[data-action="withdraw-pick"]')).toBeNull();
    // paid out in the cash token, beside the figure
    expect(find(host, '[data-ui="amount-token"]').textContent).toContain('USDC');
    expect(host.querySelectorAll('[data-variant="primary"]')).toHaveLength(1);
  });

  it('all of it: shows each holding sold and the cash that leaves with it, then orders exactly that', async () => {
    const server = api({ order: () => allOrder() });
    const host = await show();
    await click(way(host, 'dollars'));
    await click(chip(host, en.amount.out.max));
    expect(sales(host)).toEqual([`SPYx | 2.5 SPYx | ${w.check.dollars.notMeasured}`]);
    expect(find(gets(host), '[data-ui="withdraw-cash"]').textContent).toBe(
      w.check.dollars.cash('600 USDC'),
    );
    // about what it is worth, with its pin
    expect(find(gets(host), '[data-ui="withdraw-worth"]').textContent).toContain(
      en.amount.preview.about('$1,000'),
    );
    expect(find(details(host), '[data-ui="withdraw-to"]').textContent).toBe(SOLANA);
    expect(details(host).textContent).toContain(w.check.dollars.emptied);
    expect(details(host).textContent).not.toContain(w.check.emptied);
    expect(details(host).textContent).toContain(w.check.dollars.quotes);
    // a holding that cannot be sold stays, and the tokens themselves are the way for it
    expect(find(details(host), '[data-ui="withdraw-not-sold"]').textContent).toBe(
      w.check.dollars.notSold,
    );
    expect(details(host).textContent).toContain(w.check.dollars.onlyOwner('USDC'));
    expect(details(host).textContent).not.toContain(w.check.noSale);
    expect(label(host)).toBe(en.amount.press.withdrawAll);
    await through(host);
    expect(server.placed().map((c) => c.body)).toEqual([
      { type: 'withdraw', vaults: [MY_VAULT], sellToCash: true },
    ]);
    expect(recallOrder(ORDER_ID, USER)?.terms).toEqual(ALL_DOLLARS);
    expect(router.push).toHaveBeenCalledWith(`/orders/${ORDER_ID}`);
  });

  it('a share: that share of each holding and of the cash, rounded down, and the rest stays', async () => {
    const server = api({
      order: () =>
        dollarsOrder([{ sell: SPYX, amountInRaw: '83325000', minOutRaw: '131000000' }], {
          heldRaw: '600000000',
          cashRaw: '199980000',
        }),
    });
    const host = await show();
    await click(way(host, 'dollars'));
    // $333.30 of $1,000: 33.33% of each
    await type(field(host), '333.3');
    expect(sales(host)).toEqual([`SPYx | 0.83325 SPYx | ${w.check.dollars.notMeasured}`]);
    expect(find(gets(host), '[data-ui="withdraw-cash"]').textContent).toBe(
      w.check.dollars.cash('199.98 USDC'),
    );
    expect(details(host).textContent).toContain(w.check.dollars.stays);
    expect(details(host).textContent).toContain(w.check.dollars.targets);
    await through(host);
    expect(server.placed().map((c) => c.body)).toEqual([
      { type: 'withdraw', vaults: [MY_VAULT], sellToCash: true, shareBps: 3_333 },
    ]);
    expect(recallOrder(ORDER_ID, USER)?.terms).toMatchObject({
      dollars: {
        shareBps: 3_333,
        sales: [{ asset: SPYX, amountRaw: '83325000' }],
        cashRaw: '199980000',
      },
    });
  });

  it('a quick share is that share exactly, whatever the cents of its dollars', async () => {
    const server = api({
      vault: holdingVault({ valueUsd: '999.99' }),
      order: () =>
        dollarsOrder([{ sell: SPYX, amountInRaw: '125000000', minOutRaw: '195000000' }], {
          heldRaw: '600000000',
          cashRaw: '300000000',
        }),
    });
    const host = await show();
    await click(way(host, 'dollars'));
    await click(chip(host, '50%'));
    expect(chip(host, '50%').getAttribute('aria-pressed')).toBe('true');
    await through(host);
    expect(server.placed().map((c) => c.body)).toEqual([
      { type: 'withdraw', vaults: [MY_VAULT], sellToCash: true, shareBps: 5_000 },
    ]);
  });

  it('shows Bearing’s measured cost of selling a holding with its source, and says so where there is none', async () => {
    const exit = (more: object) => ({
      total: null,
      chains: [
        {
          chain: 'solana',
          name: 'Solana',
          provenance: 'sandbox',
          vaults: 1,
          valueUsd: '1000',
          observedAt: '2026-10-13T11:50:00.000Z',
          byUnderlying: [],
          byIssuer: [],
          rollUp: null,
          exit: [{ asset: SPYX, usd: '400', ...more }],
          unvalued: [],
          source: 'vault_snapshots',
          method: 'the newest snapshot',
        },
      ],
      unavailable: [],
      disclaimer: 'the disclaimer',
    });
    api({
      exposure: () =>
        json(
          exit({
            measured: true,
            costBps: 12.5,
            source: 'Bearing exit curves',
            method: 'facts-0.1',
            fetchedAt: '2026-10-13T11:00:00.000Z',
            provenance: 'sandbox',
          }),
        ),
    });
    const host = await show();
    await click(way(host, 'dollars'));
    await settle();
    await click(chip(host, en.amount.out.max));
    const sale = find(host, '[data-ui="withdraw-sales"] tbody tr');
    expect(sale.textContent).toContain(w.check.dollars.costBps('12.5'));
    expect(sale.textContent).not.toContain(w.check.dollars.notMeasured);
    expect(details(host).textContent).toContain(w.check.dollars.costNote);
    await unmountAll();

    // measured with no source: no figure is shown without where it came from
    api({ exposure: () => json(exit({ measured: true, costBps: 12.5 })) });
    const bare = await show();
    await click(way(bare, 'dollars'));
    await settle();
    await click(chip(bare, en.amount.out.max));
    expect(find(bare, '[data-ui="withdraw-sales"] tbody tr').textContent).toContain(
      w.check.dollars.notMeasured,
    );
  });

  it('going back to the tokens themselves is the withdrawal it was: nothing sold', async () => {
    const server = api({
      order: () =>
        withdrawOrder([[item(CASH, null, '600000000')], [item(SPYX, null, '250000000')]]),
    });
    const host = await show();
    await click(way(host, 'dollars'));
    await click(chip(host, en.amount.out.max));
    await click(way(host, 'tokens'));
    expect(details(host).textContent).toContain(w.check.noSale);
    expect(tokens(host)).toEqual([w.check.all('600 USDC'), w.check.all('2.5 SPYx')]);
    await through(host);
    expect(server.placed().map((c) => c.body)).toEqual([
      { type: 'withdraw', vaults: [MY_VAULT], sellToCash: false },
    ]);
  });

  it('reads a share in percent to the basis point, and nothing else', () => {
    expect(shareBpsOf('100')).toBe(10_000);
    expect(shareBpsOf('25')).toBe(2_500);
    expect(shareBpsOf('0.01')).toBe(1);
    expect(shareBpsOf('33,3')).toBe(3_330);
    for (const bad of ['', '0', '0.001', '100.01', '-5', 'half', '1e2']) {
      expect(shareBpsOf(bad), bad).toBeNull();
    }
  });
});

describe('a withdrawal in dollars on the order screen', () => {
  function seed(terms: SharedTerms) {
    const record: OrderRecord = {
      orderId: ORDER_ID,
      userId: USER,
      proposalId: '',
      chain: 'solana',
      amountUsd: 0,
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
  const sign = (host: HTMLElement) =>
    host.querySelector<HTMLElement>('[data-variant="primary"]') as HTMLElement | null;

  it('shows the sale with the least it accepts, then the cash with the least you receive, and hands the guard exactly that', async () => {
    api({ order: () => allOrder() });
    seed(ALL_DOLLARS);
    const host = await screen();
    const review = find(host, `[aria-label="${en.order.shared.withdrawTitle}"]`);
    expect([...review.querySelectorAll('tbody tr')].map((r) => r.textContent)).toEqual([
      'SPYx2.5 SPYx',
    ]);
    expect(find(review, '[data-ui="withdraw-to"]').textContent).toBe(SOLANA);
    const steps = [...host.querySelectorAll('[data-ui="order-step"]')];
    expect(steps).toHaveLength(2);
    // the sale: what is sold, and the least it accepts, in the cash token's own units
    expect(steps[0]?.textContent).toContain(en.order.review.sell('2.5 SPYx'));
    expect(steps[0]?.textContent).toContain(en.order.review.atLeastWhole('395 USDC'));
    // the cash: the least it pays, which is the cash held plus the sale's minimum
    expect(
      [...host.querySelectorAll('[data-ui="order-withdrawal"]')].map((l) => l.textContent),
    ).toEqual([en.order.shared.withdrawsAtLeast('995 USDC')]);
    expect(find(host, '[data-ui="withdraw-least"]').textContent).toBe('995 USDC');
    expect(sign(host)?.textContent).toContain(en.order.shared.signWithdraw);
    expect(host.querySelectorAll('[data-variant="primary"]')).toHaveLength(1);
    await click(sign(host) as HTMLElement);
    await settle();
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.deps.plan).toEqual({
      basketId: '42',
      dollars: { cashRaw: '600000000', sales: [{ asset: SPYX, amountRaw: '250000000' }] },
    });
  });

  it('with auto-follow on: the switch off comes first, and the guard is told off', async () => {
    api({ order: () => allOrder({}, true) });
    seed({ ...ALL_DOLLARS, autoFollowOff: true });
    const host = await screen();
    expect(host.querySelectorAll('[data-ui="order-step"]')).toHaveLength(3);
    await click(sign(host) as HTMLElement);
    await settle();
    expect(run.calls[0]?.deps.plan).toEqual({
      basketId: '42',
      autoFollow: false,
      dollars: { cashRaw: '600000000', sales: [{ asset: SPYX, amountRaw: '250000000' }] },
    });
  });

  it('a holding the order left unsold: the order says which and why, and the tokens themselves are offered once it is done', async () => {
    const text =
      'SPYx is not sold: no fresh reference price for SPYx: the market is closed. It stays in your vault, and you can withdraw the tokens themselves.';
    api({
      order: () =>
        dollarsOrder(
          [],
          { heldRaw: '600000000', cashRaw: '600000000' },
          { warnings: [{ code: `NOT_SOLD:${SPYX}`, text }] },
        ),
    });
    seed(ALL_DOLLARS);
    const host = await screen();
    expect(host.textContent).toContain(text);
    expect(host.querySelectorAll('[data-ui="order-step"]')).toHaveLength(1);
    expect(find(host, '[data-ui="withdraw-least"]').textContent).toBe('600 USDC');
    await click(sign(host) as HTMLElement);
    await settle();
    await settle();
    const done = find(host, '[data-ui="withdraw-done"]');
    const link = find(done, '[data-ui="withdraw-tokens-instead"]');
    expect(link.textContent).toBe(en.order.shared.tokensInstead);
    expect(link.getAttribute('href')).toBe(`/vaults/solana/${MY_VAULT}/withdraw`);
  });

  const least = '995000000';
  const sale = { sell: SPYX, amountInRaw: '250000000', minOutRaw: '395000000' };
  const held = { heldRaw: '600000000', cashRaw: '600000000' };
  it.each([
    ['a sale into another token', () => dollarsOrder([{ ...sale, buy: 'solana:gldx' }], held)],
    [
      'a sale of more than the review showed',
      () => dollarsOrder([{ ...sale, amountInRaw: '250000001' }], held),
    ],
    [
      'a sale of a holding the review did not name',
      () => dollarsOrder([{ ...sale, sell: 'solana:gldx' }], held),
    ],
    [
      'a purchase with the vault’s cash',
      () => dollarsOrder([{ ...sale, sell: CASH, buy: SPYX }], held),
    ],
    ['the same holding sold twice', () => dollarsOrder([sale, sale], held, {})],
    [
      'a cash step that states less than the cash reviewed plus the minimums',
      () => dollarsOrder([sale], { ...held, leastRaw: (BigInt(least) - 1n).toString() }),
    ],
    [
      'a sale whose quote is a hundred times its minimum, which would lift the cash step’s most',
      () => dollarsOrder([{ ...sale, outRaw: (BigInt(sale.minOutRaw) * 100n).toString() }], held),
    ],
    ['a reviewed holding left out with no word of why', () => dollarsOrder([], held)],
    [
      'a cash step that may pay more than the cash reviewed and the quotes',
      () => dollarsOrder([sale], { ...held, mostRaw: '10000000000' }),
    ],
    [
      'a cash step that states no least',
      () => {
        const o = allOrder();
        return {
          ...o,
          legs: o.legs.map((l) =>
            l.withdrawals ? { ...l, withdrawals: [item(CASH, null, '600000000')] } : l,
          ),
        } as OrderDetail;
      },
    ],
    [
      'a withdrawal of a holding beside the cash',
      () => {
        const o = allOrder();
        return {
          ...o,
          legs: o.legs.map((l) =>
            l.withdrawals
              ? { ...l, withdrawals: [...l.withdrawals, item(SPYX, null, '250000000')] }
              : l,
          ),
        } as OrderDetail;
      },
    ],
    ['a deposit', () => allOrder({ depositRaw: '1' })],
    ['a switch the review did not show', () => allOrder({}, true)],
    [
      'no sale at all, as a withdrawal of the tokens themselves',
      () => withdrawOrder([[item(CASH, null, '600000000')]]),
    ],
  ])('is not offered for signing when the order has %s', async (_name, order) => {
    api({ order });
    seed(ALL_DOLLARS);
    const host = await screen();
    expect(host.textContent).toContain(en.order.mismatch.withdraw);
    expect(sign(host)).toBeNull();
    expect(dollarsShapeOk(order(), ALL_DOLLARS as never, { cash: CASH })).toBe(false);
  });

  it('stopped after a sale landed: says which holdings were sold, and that the same percentage would sell them again', async () => {
    const two = dollarsOrder(
      [
        { sell: SPYX, amountInRaw: '125000000', minOutRaw: '197000000' },
        { sell: 'solana:gldx', amountInRaw: '100', minOutRaw: '50000000' },
      ],
      { heldRaw: '600000000', cashRaw: '300000000' },
    );
    api({
      order: () =>
        ({
          ...two,
          status: 'failed',
          legs: two.legs.map((l, i) =>
            i === 0
              ? { ...l, status: 'confirmed', txId: 'sig' }
              : i === 1
                ? {
                    ...l,
                    status: 'failed',
                    error: { code: 'PriceDeviation', message: 'far', retryable: false },
                  }
                : l,
          ),
        }) as OrderDetail,
    });
    seed({
      ...ALL_DOLLARS,
      dollars: {
        shareBps: 5_000,
        sales: [
          { asset: SPYX, amountRaw: '125000000' },
          { asset: 'solana:gldx', amountRaw: '100' },
        ],
        cashRaw: '300000000',
      },
    });
    const host = await screen();
    const sold = find(host, '[data-ui="withdraw-sold-before"]');
    expect(sold.textContent).toContain(en.order.shared.soldBefore('SPYx', '197 USDC'));
    expect(sold.textContent).toContain(en.order.shared.notAgain);
    expect(find(sold, 'a').getAttribute('href')).toBe(`/vaults/solana/${MY_VAULT}/withdraw`);
    expect(find(sold, 'a').textContent).toBe(en.order.shared.tokensInstead);
  });

  it('takes a quote at most the largest slippage above its minimum, to the unit, and not one more', () => {
    // 97 is what 101 less 3% rounds down to. The bound is (97 + 1) / 0.97 rounded up, 102: one unit
    // of room for the minimum's own rounding down, and no more
    for (const [out, ok] of [
      ['101', true],
      ['102', true],
      ['103', false],
    ] as const) {
      const order = dollarsOrder([{ ...sale, minOutRaw: '97', outRaw: out }], held);
      expect(dollarsShapeOk(order, ALL_DOLLARS as never, { cash: CASH }), out).toBe(ok);
    }
  });

  it('a withdrawal of the tokens themselves is never offered an order that trades', async () => {
    api({ order: () => allOrder() });
    seed({ ...ALL_DOLLARS, dollars: undefined } as SharedTerms);
    const host = await screen();
    expect(host.textContent).toContain(en.order.mismatch.withdraw);
    expect(sign(host)).toBeNull();
  });

  it('a share: the cash that stays is not said to have stayed behind by mistake', async () => {
    const part = dollarsOrder([{ sell: SPYX, amountInRaw: '125000000', minOutRaw: '197000000' }], {
      heldRaw: '600000000',
      cashRaw: '300000000',
    });
    api({
      order: () =>
        ({
          ...part,
          status: 'done',
          legs: part.legs.map((l) => ({ ...l, status: 'confirmed', txId: 'sig' })),
        }) as OrderDetail,
    });
    seed({
      ...ALL_DOLLARS,
      dollars: {
        shareBps: 5_000,
        sales: [{ asset: SPYX, amountRaw: '125000000' }],
        cashRaw: '300000000',
      },
    });
    const host = await screen();
    await settle();
    expect(host.querySelector('[data-ui="withdraw-stayed"]')).toBeNull();
    expect(host.textContent).toContain(en.order.outcome.done(en.chain.names.solana));
  });
});

describe('the terms of a withdrawal in dollars, read back', () => {
  it('reads what was written, and nothing that is not one in full', () => {
    expect(readTerms(ALL_DOLLARS)).toEqual(ALL_DOLLARS);
    const d = (ALL_DOLLARS as Extract<SharedTerms, { kind: 'withdraw' }>).dollars;
    for (const bad of [
      { ...ALL_DOLLARS, dollars: { ...d, shareBps: 0 } },
      { ...ALL_DOLLARS, dollars: { ...d, shareBps: 10_001 } },
      { ...ALL_DOLLARS, dollars: { ...d, shareBps: 12.5 } },
      { ...ALL_DOLLARS, dollars: { ...d, cashRaw: '-1' } },
      { ...ALL_DOLLARS, dollars: { ...d, sales: [{ asset: SPYX }] } },
      { ...ALL_DOLLARS, dollars: { ...d, sales: [...(d?.sales ?? []), ...(d?.sales ?? [])] } },
      { ...ALL_DOLLARS, dollars: 'yes' },
      // in dollars the one token that leaves is the cash, all of it
      { ...ALL_DOLLARS, items: [term(CASH, '1', '600000000')] },
      { ...ALL_DOLLARS, items: [term(CASH, null, '1'), term(SPYX, null, '1')] },
    ])
      expect(readTerms(bad), JSON.stringify(bad)).toBeNull();
  });
});

describe('the terms of a withdrawal, read back', () => {
  const good = {
    kind: 'withdraw',
    vault: MY_VAULT,
    basketId: '42',
    owner: SOLANA,
    everything: false,
    items: [term(CASH, '1', '2')],
    autoFollowOff: false,
  };
  it('reads what was written, and nothing that is not a withdrawal in full', () => {
    expect(readTerms(good)).toEqual(good);
    for (const bad of [
      { ...good, owner: '' },
      { ...good, basketId: 'x' },
      { ...good, items: [] },
      { ...good, items: [term(CASH, '1', '2'), term(CASH, null, '2')] },
      { ...good, items: [term(CASH, '-1', '2')] },
      { ...good, items: [{ asset: CASH, amountRaw: '1' }] },
      // everything names no amount
      { ...good, everything: true },
      { ...good, everything: 'yes' },
      { ...good, autoFollowOff: undefined },
      { ...good, items: [{ ...term(CASH, '1', '2'), multiplier: '-1' }] },
      { ...good, items: [item(CASH, '1', '2')] },
    ])
      expect(readTerms(bad), JSON.stringify(bad)).toBeNull();
  });
});
