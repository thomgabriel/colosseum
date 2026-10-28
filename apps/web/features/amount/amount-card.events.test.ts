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
      asset: evm ? 'robinhood:tusdg' : 'solana:usdc',
      symbol: evm ? 'tUSDG' : 'USDC',
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
    await type(field(host), '0.5');
    // not on the first digit
    expect(host.querySelector('[data-ui="amount-problem"]')).toBeNull();
    expect(held(primary(host))).toBe(true);
    await settle(SETTLE_MS + 50);
    expect(find(host, '[data-ui="amount-problem"]').textContent).toBe(
      en.amount.errors.belowMin('$1'),
    );
    // said where a screen reader hears it, by someone still in the field
    expect(find(host, '[data-ui="amount-problem"]').closest('[role="status"]')).not.toBeNull();
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
    expect(primary(host).textContent).toBe(en.amount.modes.deposit);
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
    // the shared composition, now and after: a new vault holds nothing now; after, the weights
    expect(find(preview, '[data-ui="composition"]').dataset.mode).toBe('single');
    expect(preview.textContent).toContain('40%');
    expect(preview.textContent).toContain('30%');
    expect(preview.textContent).toContain(en.amount.preview.cash);
    // one primary button, and it names the action and the amount
    expect(host.querySelectorAll('[data-variant="primary"]')).toHaveLength(1);
    expect(primary(host).textContent).toBe(en.amount.press.deposit('$250'));
    await click(primary(host));
    expect(find(host, '[data-ui="the-flow"]').textContent).toBe('flow for 250');
    // the button went with the press: the focus is on what took its place, never the page
    expect(document.activeElement).toBe(find(host, '[data-ui="deposit-pressed"]'));
    expect(find(host, '[data-ui="deposit-fact"]').textContent).toContain(en.amount.pressed('$250'));
    await click(find(host, 'button[data-action="amount-change"]'));
    expect(host.querySelector('[data-ui="the-flow"]')).toBeNull();
    expect(field(host).value).toBe('250');
  });

  it('compares an existing vault now with after the deposit, by its values as read', async () => {
    api();
    acceptTrust(USER, TRUST_STATUS.textVersion, true);
    // $100 of SPY now; $100 in at 40% SPY, 30% NVDA and 30% cash
    const host = await mount(
      inLanguage(
        'en',
        deposit({
          held: {
            rows: [{ asset: 'solana:spy', valueUsd: 100, weightBps: 10_000 }],
            totalUsd: 100,
          },
        }),
      ),
    );
    await settle(10);
    await type(field(host), '100');
    const composition = find(host, '[data-ui="amount-preview"] [data-ui="composition"]');
    expect(composition.dataset.mode).toBe('compare');
    // SPY moves from 100% to 70%: both strips, now over after
    expect(composition.querySelectorAll('[data-bar]').length).toBeGreaterThan(0);
    const rows = [...composition.querySelectorAll('[data-ui="composition-list"] li')].map(
      (li) => li.textContent,
    );
    // after: SPY (100 + 40) of 200, NVDA 30 of 200, cash 30 of 200
    expect(rows.join(' | ')).toContain('70%');
    expect(rows.join(' | ')).toContain('15%');
  });

  it('says nothing of what the vault will hold while its targets are not read', async () => {
    api();
    acceptTrust(USER, TRUST_STATUS.textVersion, true);
    const host = await mount(
      inLanguage(
        'en',
        deposit({
          holdings: null,
          held: {
            rows: [{ asset: 'solana:spy', valueUsd: 100, weightBps: 10_000 }],
            totalUsd: 100,
          },
        }),
      ),
    );
    await settle(10);
    await type(field(host), '100');
    // never "SPY 50%": with no targets the deposit goes nowhere the card can say
    expect(host.querySelector('[data-ui="amount-preview"]')).toBeNull();
  });

  it('draws one strip where no share moves, at the precision the rows write it, and for a new vault', async () => {
    api();
    acceptTrust(USER, TRUST_STATUS.textVersion, true);
    // on its targets: SPY 40, NVDA 30, cash 30 of $100; $100 more at the same weights moves nothing
    const onTarget = await mount(
      inLanguage(
        'en',
        deposit({
          held: {
            rows: [
              { asset: 'solana:spy', valueUsd: 40, weightBps: 4_000 },
              { asset: 'solana:nvda', valueUsd: 30, weightBps: 3_000 },
              { asset: 'solana:usdc', valueUsd: 30, weightBps: 3_000, cash: true },
            ],
            totalUsd: 100,
          },
        }),
      ),
    );
    await settle(10);
    await type(field(onTarget), '100');
    const same = find(onTarget, '[data-ui="amount-preview"] [data-ui="composition"]');
    expect(same.dataset.mode).toBe('compare');
    expect(same.querySelectorAll('[data-bar]')).toHaveLength(0);
    await unmountAll();

    // a new vault: nothing now to compare with, one composition
    const fresh = await mount(inLanguage('en', deposit()));
    await settle(10);
    await type(field(fresh), '100');
    expect(find(fresh, '[data-ui="amount-preview"] [data-ui="composition"]').dataset.mode).toBe(
      'single',
    );
    await unmountAll();

    // a holding with no price: no comparison, the weights alone
    const unpriced = await mount(
      inLanguage(
        'en',
        deposit({
          held: { rows: [{ asset: 'solana:spy', valueUsd: null, weightBps: 0 }], totalUsd: 100 },
        }),
      ),
    );
    await settle(10);
    await type(field(unpriced), '100');
    expect(find(unpriced, '[data-ui="amount-preview"] [data-ui="composition"]').dataset.mode).toBe(
      'single',
    );
  });

  it('keeps the line without its way back once the steps are being signed', async () => {
    api();
    const host = await mount(inLanguage('en', deposit({ running: true, pressed: 300 })));
    await settle(10);
    expect(find(host, '[data-ui="the-flow"]').textContent).toBe('flow for 300');
    expect(host.querySelector('button[data-action="amount-change"]')).toBeNull();
  });

  it('sets the details as labelled figures: least and most, slippage, the network fee with its pin, and no line of where it was read', async () => {
    api();
    const host = await mount(inLanguage('en', deposit()));
    await settle(10);
    // the figures once there is an amount to hold them to
    expect(host.querySelector('[data-ui="amount-details"]')).toBeNull();
    await type(field(host), '250');
    const details = find(host, '[data-ui="amount-details"]');
    // in sight, as the portfolio board sets its figures: a label over each
    expect(details.querySelectorAll('dt').length).toBeGreaterThanOrEqual(4);
    const text = details.textContent ?? '';
    expect(text).toContain(en.amount.details.least);
    expect(text).toContain('Least$1Most');
    expect(text).toContain('$1,000,000');
    expect(text).toContain(en.amount.details.slippage);
    // the slippage the order is built with (ORDER_DEFAULT_SLIPPAGE_BPS), not the request's cap
    expect(text).toContain(en.amount.details.slippageValue('1%'));
    // Solana's swaps have no per-token limits of their own: nothing said of them
    expect(text).not.toContain(en.amount.details.tradeLimits);
    expect(text).toContain('0.0101 SOL');
    expect(text).not.toMatch(/read from/i);
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
    // the portfolio board's one quiet pill: the long line is the order card's (BUY-STEPS)
    expect(find(host, '[data-ui="data-note"]').textContent).toBe(en.shell.testNetworkLine);
    expect(host.querySelector('[data-ui="sample-note"]')).toBeNull();
  });

  it('says sample figures on the mock in the kit’s one pill, in the head’s top right, with no hatch on the panel', async () => {
    api({ provenance: 'mock' });
    const host = await mount(inLanguage('en', deposit({ mock: true, provenance: 'mock' })));
    await settle(10);
    expect(host.querySelector('[data-ui="data-note"]')).toBeNull();
    expect(find(host, '[data-ui="sample-plate"]').textContent).toBe(en.shell.mockAnnounce);
    // in the panel's head, with its actions on the right, not beside the amount
    expect(
      find(host, '[data-ui="hero-figure"]').contains(find(host, '[data-ui="sample-plate"]')),
    ).toBe(false);
    expect(find(host, '[data-ui="sample-plate"]').closest('.ml-auto')).not.toBeNull();
    // one pill, not the card's own tag beside it
    expect(host.querySelector('[data-ui="sample-tag"]')).toBeNull();
    expect(host.querySelector('[data-ui="hatch-band"]')).toBeNull();
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
          holdings: [{ asset: 'robinhood:tsla', weightBps: 5000 }],
        }),
      ),
    );
    await settle(10);
    expect(find(host, '[data-ui="amount-token"]').textContent).toMatch(/USDG/);
    expect(find(host, '[data-ui="amount-balance"]').textContent).toMatch(/1,234\.56 t?USDG/);
    expect(find(host, '[data-ui="data-note"]').textContent).toBe(en.shell.testNetworkLine);
    // its swaps are held to each token's own limit: said in the details, in words
    await type(field(host), '250');
    expect(find(host, '[data-ui="amount-details"]').textContent).toContain(
      en.amount.details.tradeLimitsValue,
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
