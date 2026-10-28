// @vitest-environment happy-dom
import { DISCLAIMER, type LeaderboardResponse, type LeaderboardRow } from '@colosseum/schemas';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, settle, unmountAll } from '../../components/ui/test/dom';
import { dictionary } from '../../i18n';
import { inLanguage } from '../account/test/screen';
import { LeaderboardScreen } from './LeaderboardScreen';

vi.mock('next/link', () => import('../wallet/test/mock-next'));

// The leaderboard page against a double of GET /v1/leaderboard: the rows in the API's order, each with
// its name or number, its owner in short, what it holds, its value and what it made with their pins;
// a vault with no deposit made in the app says so; the test network said once; and the page while it
// waits, when it is empty and when the server does not answer.

const en = dictionary('en');
const w = en.leaderboard;
const SOURCED = {
  source: 'snapshot worker',
  method: 'a read of the vault',
  fetchedAt: '2026-10-28T12:00:00.000Z',
  provenance: 'sandbox' as const,
};
const A = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const B = '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj';
const C = '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R';

const row = (
  over: Partial<LeaderboardRow> & Pick<LeaderboardRow, 'rank' | 'address'>,
): LeaderboardRow => ({
  chain: 'solana',
  owner: 'Abcd…wxyz',
  holdings: [],
  value: { usd: '1000.00', ...SOURCED },
  pnl: null,
  noPnl: 'no_deposit_record',
  follows: null,
  ...over,
});

const pnl = (usd: string, pct: number | null) => ({
  usd,
  pct,
  netInUsd: '800.00',
  depositsUsd: '1000.00',
  withdrawalsUsd: '200.00',
  unvaluedWithdrawals: 0,
  ...SOURCED,
});

const ANSWER: LeaderboardResponse = {
  chain: 'solana',
  name: 'Solana',
  provenance: 'sandbox',
  readAt: '2026-10-28T12:01:00.000Z',
  rule: 'the rule',
  disclaimer: DISCLAIMER.en,
  vaults: [
    row({
      rank: 1,
      address: A,
      owner: '9xQe…VFin',
      value: { usd: '1100.00', ...SOURCED },
      pnl: pnl('300.00', 0.375),
      noPnl: null,
      holdings: [
        { asset: 'solana:spyx', weightBps: 4000 },
        { asset: 'solana:nvdax', weightBps: 3000 },
        { asset: 'solana:usdc', weightBps: 1500 },
        { asset: 'solana:gldx', weightBps: 1000 },
        { asset: 'solana:tslax', weightBps: 500 },
      ],
    }),
    row({
      rank: 2,
      address: B,
      pnl: pnl('-12.50', -0.0125),
      noPnl: null,
      follows: { name: 'The Seven', slug: 'the-seven' },
    }),
    row({ rank: 3, address: C }),
  ],
};

/** The page, with the API answering `answer` (or failing). */
async function page(answer: () => Promise<Response>, lang: 'en' | 'pt' = 'en') {
  const fetch = vi.fn((_url: string) => answer());
  vi.stubGlobal('fetch', fetch);
  const host = await mount(inLanguage(lang, createElement(LeaderboardScreen)));
  await settle();
  return { host, fetch };
}
const json = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );

afterEach(async () => {
  await unmountAll();
  vi.unstubAllGlobals();
});

describe('the leaderboard page', () => {
  it('shows the rows in the order the API ranked them, each with what makes it a row', async () => {
    const { host, fetch } = await page(() => json(ANSWER));
    // public: no sign-in is asked for or sent
    expect(String(fetch.mock.calls[0]?.[0])).toMatch(/\/v1\/leaderboard\?chain=solana$/);
    const rows = [...host.querySelectorAll('[data-ui="leaderboard-row"]')];
    expect(rows.map((r) => r.getAttribute('data-address'))).toEqual([A, B, C]);
    expect(rows.map((r) => find(r, '[data-ui="leaderboard-rank"]').textContent)).toEqual([
      '1',
      '2',
      '3',
    ]);

    const [first, second, third] = rows as [Element, Element, Element];
    // a vault is called by its address in short: its owner's name for it and number are theirs alone
    expect(find(first, '[data-ui="leaderboard-vault"]').textContent).toBe(w.unnamed('9xQe…VFin'));
    expect(find(third, '[data-ui="leaderboard-vault"]').textContent).toBe(w.unnamed('4k3D…kX6R'));
    // the row opens the vault's own page, which anybody may read
    expect(find(first, 'a').getAttribute('href')).toBe(`/portfolio/vaults/solana/${A}`);
    expect(find(second, '[data-ui="leaderboard-follows"]').textContent).toBe(
      w.follows('The Seven'),
    );
    expect(find(first, '[data-ui="leaderboard-owner"]').textContent).toBe('9xQe…VFin');

    // the three largest holdings with their shares, and how many more
    const holds = find(first, '[data-ui="leaderboard-holds"]').textContent ?? '';
    expect(holds).toContain('40%');
    expect(holds).toContain(w.more(2));
    expect(first.querySelectorAll('[data-ui="asset-mark"]')).toHaveLength(3);

    // value and what it made, signed and coloured by direction, each a figure with its pin
    expect(find(first, '[data-ui="leaderboard-value"]').textContent).toContain('$1,100.00');
    const made = find(first, '[data-ui="leaderboard-made"]');
    expect(made.textContent).toContain('+$300.00');
    expect(find(first, '[data-ui="leaderboard-share"]').textContent).toBe('+37.50%');
    expect(find(second, '[data-ui="leaderboard-made"]').textContent).toContain('−$12.50');
    expect(find(second, '[data-ui="leaderboard-share"]').className).toContain('text-destructive');

    // no deposit made in the app: said, never a made-up figure
    expect(find(third, '[data-ui="leaderboard-no-figure"]').textContent).toBe(w.noDeposit);
    expect(third.querySelector('[data-ui="leaderboard-share"]')).toBeNull();

    // the test network is said once, in words, never as MOCK
    expect(find(host, '[data-ui="sample-tag"]').textContent).toBe(en.shell.testNetworkLine);
    expect(host.textContent).not.toContain('MOCK');
    expect(find(host, '[data-ui="leaderboard-count"]').textContent).toContain('3');
  });

  it('says so when no vault is open', async () => {
    const { host } = await page(() => json({ ...ANSWER, vaults: [] }));
    expect(host.querySelector('[data-ui="leaderboard-row"]')).toBeNull();
    expect(host.textContent).toContain(w.empty('Solana'));
  });

  it('waits in outline while the API is read', async () => {
    const { host } = await page(() => new Promise<Response>(() => {}));
    expect(host.querySelector('[data-ui="leaderboard-wait"]')).not.toBeNull();
    expect(host.querySelector('[data-ui="leaderboard-row"]')).toBeNull();
  });

  it('says the server did not answer, and reads again when asked', async () => {
    let calls = 0;
    const { host } = await page(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new TypeError('fetch failed')) : json(ANSWER);
    });
    expect(find(host, '[data-ui="leaderboard-failure"]').textContent).toContain(
      w.failure.unreachable,
    );
    await click(find(host, '[data-ui="leaderboard-failure"] button'));
    await settle();
    expect(host.querySelectorAll('[data-ui="leaderboard-row"]')).toHaveLength(3);
  });

  it('says an answer it cannot read, rather than show part of it', async () => {
    const { host } = await page(() => json({ vaults: 'no' }));
    expect(host.textContent).toContain(w.failure.unreadable);
  });

  it('speaks Portuguese', async () => {
    const { host } = await page(() => json(ANSWER), 'pt');
    const pt = dictionary('pt').leaderboard;
    expect(host.textContent).toContain(pt.title);
    expect(host.querySelector('[data-ui="leaderboard-vault"]')?.textContent).toBe(
      pt.unnamed('9xQe…VFin'),
    );
  });
});
