// @vitest-environment happy-dom
import { type ChainId, TRUST_STATUS } from '@colosseum/schemas';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, settle, type, unmountAll } from '../../components/ui/test/dom';
import { hatchProblems } from '../../components/ui/test/hatch';
import { parse } from '../../components/ui/test/html';
import { dictionary, type Lang } from '../../i18n';
import { inLanguage } from '../account/test/screen';
import { dollars } from '../goal/sheet';
import { acceptTrust, trustAccepted } from '../order/order-record';
import { json } from '../wallet/test/fake-port';
import { portStore } from '../wallet/test/mock-provider';
import { AmountCard, SETTLE_MS } from './AmountCard';
import { DepositCard, type DepositCardProps } from './DepositCard';

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));

// The amount card as a person uses it (gate AMOUNT-CARD), with real events against a double of the
// funding read: the wallet's balance with its pin and Max, quiet words for an amount that is wrong,
// the trust notice the first time and one line after, the test-network tag and the sample hatch, the
// chain's own dollar, Deposit | Withdraw, and the press that hands the amount to the order flow.

const en = dictionary('en');
const pt = dictionary('pt');
const USER = 'user-amount-card';
const WALLET = 'So1anaWa11et1111111111111111111111111111111';

/** GET /v1/funding: what the wallet holds of the chain's dollar and fee token, with its stamp. */
const funding = (o: {
  chain?: ChainId;
  haveRaw?: string;
  provenance?: 'mock' | 'sandbox' | 'live';
  testFunds?: boolean;
}) => {
  const chain = o.chain ?? 'solana';
  const provenance = o.provenance ?? 'sandbox';
  const stamp = {
    source: chain === 'solana' ? 'devnet RPC' : 'Robinhood Chain testnet RPC',
    fetchedAt: '2026-10-13T12:00:00.000Z',
    method: 'the wallet balance',
    provenance,
  };
  const evm = chain !== 'solana';
  return {
    chain,
    name: evm ? 'Robinhood Chain' : 'Solana',
    mode: provenance === 'mock' ? 'mock' : 'live',
    provenance,
    wallet: WALLET,
    cash: {
      ...stamp,
      asset: evm ? 'robinhood:usdg' : 'solana:usdc',
      symbol: evm ? 'USDG' : 'USDC',
      decimals: 6,
      haveRaw: o.haveRaw ?? '1234560000',
      needRaw: '10000000',
      missingRaw: '0',
    },
    gas: {
      ...stamp,
      symbol: evm ? 'ETH' : 'SOL',
      decimals: 9,
      haveRaw: '1000000000',
      needRaw: '10100000',
      missingRaw: '0',
    },
    steps: 4,
    newVault: true,
    ok: true,
    ...(o.testFunds ? { testFunds: true } : {}),
  };
};

let calls: string[] = [];
function api(o: Parameters<typeof funding>[0] = {}) {
  calls = [];
  portStore.setApi(async (path) => {
    calls.push(path);
    if (path.startsWith('/v1/funding?')) return json(funding(o));
    return json({ error: 'not here' }, 404);
  });
}

const flows: number[] = [];
function deposit(o: Partial<DepositCardProps> = {}, lang: Lang = 'en') {
  return createElement(DepositCard, {
    chain: 'solana',
    chainName: 'Solana',
    mock: false,
    provenance: 'sandbox',
    owner: WALLET,
    userId: USER,
    buyOf: { family: 'three-of-the-largest', chain: 'solana' },
    holdings: [
      { asset: 'solana:spy', weightBps: 4000 },
      { asset: 'solana:nvda', weightBps: 3000 },
    ],
    keeper: true,
    into: {
      label: dictionary(lang).amount.into.label,
      value: 'family',
      options: [{ value: 'family', label: dictionary(lang).amount.into.newVault }],
    },
    blocked: [],
    running: false,
    flow: (amount) => {
      flows.push(amount);
      return createElement('p', { 'data-ui': 'the-flow' }, `flow for ${amount}`);
    },
    ...o,
  });
}

const field = (host: HTMLElement) => find<HTMLInputElement>(host, '[data-ui="amount-well"] input');
const primary = (host: HTMLElement) =>
  find<HTMLButtonElement>(host, 'button[data-action="amount-deposit"]');
const held = (button: HTMLElement) =>
  button.hasAttribute('disabled') || button.getAttribute('aria-disabled') === 'true';

beforeEach(() => {
  localStorage.clear();
  flows.length = 0;
});
afterEach(unmountAll);

describe('the amount card on a deposit', () => {
  it('reads the wallet’s balance once, with its pin, and Max types the whole of it', async () => {
    api();
    const host = await mount(inLanguage('en', deposit()));
    await settle(10);
    const balance = find(host, '[data-ui="amount-balance"]');
    expect(balance.dataset.state).toBe('read');
    expect(balance.textContent).toContain(`${en.amount.balance.wallet}:`);
    expect(balance.textContent).toContain('1,234.56 USDC');
    // the figure has its pin, which names where it was read
    expect(balance.querySelector('button[data-ui="pin"]')).not.toBeNull();
    await click(find(host, `button[aria-label="${en.amount.balance.maxLabel('1,234.56 USDC')}"]`));
    expect(field(host).value).toBe('1234.56');
    expect(primary(host).textContent).toBe(en.amount.press.deposit('$1,234.56'));
    // typing does not read the wallet again
    await type(field(host), '250');
    await settle(10);
    expect(calls.filter((c) => c.startsWith('/v1/funding?'))).toHaveLength(1);
    // the token beside the figure is the chain's dollar, named for screen readers
    expect(find(host, '[data-ui="amount-token"]').textContent).toContain('USDC');
    expect(find(host, '[data-ui="amount-token"]').textContent).toContain(en.amount.token('USDC'));
  });

  it('says what is wrong under the field, quietly and only once the amount is still', async () => {
    api();
    const host = await mount(inLanguage('en', deposit()));
    await settle(10);
    await type(field(host), '5');
    // not on the first digit
    expect(host.querySelector('[data-ui="amount-problem"]')).toBeNull();
    expect(held(primary(host))).toBe(true);
    await settle(SETTLE_MS + 50);
    expect(find(host, '[data-ui="amount-problem"]').textContent).toBe(
      en.amount.errors.belowMin('$10'),
    );
    expect(field(host).getAttribute('aria-invalid')).toBe('true');
    // no sentence under the disabled button for it: the field says it
    expect(host.querySelector('[data-ui="amount-reasons"]')).toBeNull();
    await type(field(host), '2000000');
    await settle(SETTLE_MS + 50);
    expect(find(host, '[data-ui="amount-problem"]').textContent).toBe(
      en.amount.errors.aboveMax('$1,000,000'),
    );
    await type(field(host), 'ten');
    await settle(SETTLE_MS + 50);
    expect(find(host, '[data-ui="amount-problem"]').textContent).toBe(en.amount.errors.notAmount);
    // more than the wallet holds, where nothing on the next step fills it: held
    await type(field(host), '5000');
    await settle(SETTLE_MS + 50);
    expect(find(host, '[data-ui="amount-problem"]').textContent).toBe(en.amount.errors.overBalance);
    expect(held(primary(host))).toBe(true);
    // the button names nothing until there is an amount
    await type(field(host), '');
    expect(primary(host).textContent).toBe(en.amount.enter);
  });

  it('lets a short wallet on, where the next step sends test funds, and says so quietly', async () => {
    api({ testFunds: true, haveRaw: '0' });
    const host = await mount(inLanguage('en', deposit()));
    await settle(10);
    await click(find(host, '[data-ui="amount-trust"] input[type="checkbox"]'));
    await type(field(host), '250');
    await settle(SETTLE_MS + 50);
    expect(host.querySelector('[data-ui="amount-problem"]')).toBeNull();
    expect(find(host, '[data-ui="amount-note"]').textContent).toBe(en.amount.errors.overFunded);
    expect(held(primary(host))).toBe(false);
    // no Max for a balance under the least deposit
    expect(host.querySelector('[data-ui="amount-max"]')).toBeNull();
  });

  it('asks for the trust notice the first time, keeps it as the person presses, and says it in one line after', async () => {
    api();
    const host = await mount(inLanguage('en', deposit()));
    await settle(10);
    const ask = find(host, '[data-ui="amount-trust"]');
    expect(ask.dataset.state).toBe('ask');
    expect(ask.querySelectorAll('[data-ui="trust-short"] li')).toHaveLength(4);
    expect(ask.textContent).toContain(en.trust.short.full);
    await type(field(host), '250');
    await settle(SETTLE_MS + 50);
    // held by the notice alone, and the button says why to a screen reader
    expect(held(primary(host))).toBe(true);
    expect(primary(host).getAttribute('aria-describedby')).toContain(ask.id);
    await click(find(ask, 'input[type="checkbox"]'));
    expect(held(primary(host))).toBe(false);
    expect(trustAccepted(USER, TRUST_STATUS.textVersion, true)).toBe(false);
    await click(primary(host));
    // kept as the person pressed, where the order flow reads it, so it does not ask again
    expect(trustAccepted(USER, TRUST_STATUS.textVersion, true)).toBe(true);
    expect(flows.length).toBeGreaterThan(0);
    expect(new Set(flows)).toEqual(new Set([250]));
    await unmountAll();

    const again = await mount(inLanguage('en', deposit()));
    await settle(10);
    const kept = find(again, '[data-ui="amount-trust"]');
    expect(kept.dataset.state).toBe('accepted');
    expect(kept.textContent).toContain(en.amount.trust.accepted);
    expect(kept.querySelector('[data-ui="trust-notice"]')).toBeNull();
    await click(find(kept, `button[aria-expanded="false"]`));
    // the whole notice, still there to read, with nothing to tick
    expect(kept.querySelector('[data-ui="trust-notice"]')).not.toBeNull();
    expect(kept.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it('hands the amount to the order flow on the press, and takes it back while nothing is signed', async () => {
    api();
    acceptTrust(USER, TRUST_STATUS.textVersion, true);
    const host = await mount(inLanguage('en', deposit()));
    await settle(10);
    await type(field(host), '250');
    // what the vault will hold at that amount, by the weights shown, the rest as cash
    const preview = find(host, '[data-ui="amount-preview"]');
    expect(preview.textContent).toContain(en.amount.preview.deposit);
    expect(preview.textContent).toContain('$100');
    expect(preview.textContent).toContain('$75');
    expect(preview.textContent).toContain(en.amount.preview.cash);
    // one primary button, and it names the action and the amount
    expect(host.querySelectorAll('[data-variant="primary"]')).toHaveLength(1);
    expect(primary(host).textContent).toBe(en.amount.press.deposit('$250'));
    await click(primary(host));
    expect(find(host, '[data-ui="the-flow"]').textContent).toBe('flow for 250');
    expect(find(host, '[data-ui="deposit-fact"]').textContent).toContain(en.amount.pressed('$250'));
    await click(find(host, 'button[data-action="amount-change"]'));
    expect(host.querySelector('[data-ui="the-flow"]')).toBeNull();
    expect(field(host).value).toBe('250');
  });

  it('keeps the line without its way back once the steps are being signed', async () => {
    api();
    const host = await mount(inLanguage('en', deposit({ running: true, pressed: 300 })));
    await settle(10);
    expect(find(host, '[data-ui="the-flow"]').textContent).toBe('flow for 300');
    expect(host.querySelector('button[data-action="amount-change"]')).toBeNull();
  });

  it('sets the details as labelled figures: least and most, slippage, the network fee with its pin, and where it was read', async () => {
    api();
    const host = await mount(
      inLanguage('en', deposit({ source: createElement('span', { 'data-ui': 'src' }, 'read') })),
    );
    await settle(10);
    const details = find(host, '[data-ui="amount-details"]');
    // in sight, as the portfolio board sets its figures: a label over each
    expect(details.querySelectorAll('dt').length).toBeGreaterThanOrEqual(4);
    const text = details.textContent ?? '';
    expect(text).toContain(en.amount.details.least);
    expect(text).toContain('$10');
    expect(text).toContain('$1,000,000');
    expect(text).toContain(en.amount.details.slippage);
    expect(text).toContain('0.0101 SOL');
    expect(details.querySelector('[data-ui="src"]')).not.toBeNull();
    expect(details.querySelectorAll('button[data-ui="pin"]').length).toBeGreaterThan(0);
  });

  it('says the host’s own reasons under the button', async () => {
    api();
    const host = await mount(inLanguage('en', deposit({ blocked: [en.shared.check.reading] })));
    await settle(10);
    expect(find(host, '[data-ui="amount-reasons"]').textContent).toBe(en.shared.check.reading);
    expect(held(primary(host))).toBe(true);
  });
});

describe('what the card says of the chain', () => {
  it('tags a test network’s figures, and says no sample', async () => {
    api();
    const host = await mount(inLanguage('en', deposit()));
    await settle(10);
    expect(find(host, '[data-ui="data-note"]').textContent).toBe(
      en.buy.steps.note.testNetwork('Solana'),
    );
    expect(host.querySelector('[data-ui="sample-note"]')).toBeNull();
  });

  it('hatches the card on the mock, with its one quiet line', async () => {
    api({ provenance: 'mock' });
    const host = await mount(inLanguage('en', deposit({ mock: true, provenance: 'mock' })));
    await settle(10);
    expect(host.querySelector('[data-ui="data-note"]')).toBeNull();
    expect(host.querySelector('[data-ui="sample-note"]')).not.toBeNull();
    expect(hatchProblems(parse(host.innerHTML))).toEqual([]);
  });

  it('pays a deposit on Robinhood Chain in its own dollar, USDG', async () => {
    api({ chain: 'robinhood' });
    const host = await mount(
      inLanguage(
        'en',
        deposit({
          chain: 'robinhood',
          chainName: 'Robinhood Chain',
          buyOf: { family: 'three-of-the-largest', chain: 'robinhood' },
          holdings: null,
        }),
      ),
    );
    await settle(10);
    expect(find(host, '[data-ui="amount-token"]').textContent).toMatch(/USDG/);
    expect(find(host, '[data-ui="amount-balance"]').textContent).toMatch(/1,234\.56 t?USDG/);
    expect(find(host, '[data-ui="data-note"]').textContent).toBe(
      en.buy.steps.note.testNetwork('Robinhood Chain'),
    );
  });

  it('speaks Portuguese, and reads an amount as a Brazilian types it', async () => {
    api();
    const host = await mount(inLanguage('pt', deposit({}, 'pt')));
    await settle(10);
    await click(find(host, `button[aria-label="${pt.amount.balance.maxLabel('1.234,56 USDC')}"]`));
    expect(field(host).value).toBe('1234,56');
    expect(primary(host).textContent).toBe(pt.amount.press.deposit(dollars(1234.56, 'pt')));
    expect(host.textContent).toContain(pt.amount.field.deposit);
  });
});

describe('Deposit | Withdraw', () => {
  it('shows both where both apply, and tells the host of the other', async () => {
    const picked: string[] = [];
    const host = await mount(
      inLanguage(
        'en',
        createElement(AmountCard, {
          mode: 'deposit',
          onMode: (m) => picked.push(m),
          chain: 'solana',
          chainName: 'Solana',
          provenance: 'sandbox',
          field: null,
          action: { label: 'Go', onPress: () => {}, reasons: [] },
        }),
      ),
    );
    const modes = find(host, '[data-ui="amount-modes"]');
    const buttons = [...modes.querySelectorAll('button')];
    expect(buttons.map((b) => b.textContent)).toEqual([
      en.amount.modes.deposit,
      en.amount.modes.withdraw,
    ]);
    expect(buttons[0]?.getAttribute('aria-pressed')).toBe('true');
    await click(buttons[1] as HTMLElement);
    expect(picked).toEqual(['withdraw']);
  });

  it('shows the one action alone where only it applies', async () => {
    api();
    const host = await mount(inLanguage('en', deposit()));
    await settle(10);
    expect(host.querySelector('[data-ui="amount-modes"]')).toBeNull();
    expect(find(host, 'section h2').textContent).toBe(en.amount.modes.deposit);
  });
});
