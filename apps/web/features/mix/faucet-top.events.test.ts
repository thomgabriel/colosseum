// @vitest-environment happy-dom
import type { FundingResponse, Provenance } from '@colosseum/schemas';
import { createElement, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, settle, unmountAll } from '../../components/ui/test/dom';
import { dictionary } from '../../i18n';
import { withAccount } from '../account/test/screen';
import { FundingStep } from '../order/FundingStep';
import { unitsFor } from '../order/units';
import { EMBEDDED, json, SOLANA, signedInPort } from '../wallet/test/fake-port';
import { portStore } from '../wallet/test/mock-provider';
import { DepositStep } from './DepositStep';

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));
vi.mock('../wallet/signing', () => import('../wallet/test/mock-signing'));

// Gate FAUCET-TOP (Thom, Oct 30): on a test network where our server sends test funds, the deposit
// card of /invest opens with the faucet at its top, before any amount is typed; one press asks for one
// send over what the wallet holds, with no buy named, and the wallet is read again. Not on mainnet, not
// on the mock. The range line under the field is gone.

const userId = 'did:privy:test';
const en = dictionary('en');

/** GET /v1/funding with the wallet alone, as the card reads it before there is anything to name. */
const balance = (o: {
  provenance: Provenance;
  testFunds?: boolean;
  haveRaw?: string;
}): FundingResponse => {
  const stamp = {
    source: 'test',
    fetchedAt: '2026-10-30T11:00:00.000Z',
    method: 'the wallet balance',
    provenance: o.provenance,
  };
  return {
    chain: 'solana',
    name: 'Solana',
    mode: o.provenance === 'mock' ? 'mock' : 'live',
    provenance: o.provenance,
    wallet: SOLANA,
    cash: {
      ...stamp,
      asset: 'solana:usdc',
      symbol: 'USDC',
      decimals: 6,
      haveRaw: o.haveRaw ?? '0',
      needRaw: '0',
      missingRaw: '0',
    },
    gas: {
      ...stamp,
      symbol: 'SOL',
      decimals: 9,
      haveRaw: '0',
      needRaw: '0',
      missingRaw: '0',
    },
    steps: 0,
    newVault: false,
    ok: true,
    ...(o.testFunds ? { testFunds: true } : {}),
  };
};

type Sent = { path: string; body: unknown };
let sent: Sent[] = [];
let reads = 0;
function api(o: { provenance: Provenance; testFunds?: boolean }) {
  sent = [];
  reads = 0;
  let have = '0';
  portStore.setApi(async (path, init) => {
    if (path.startsWith('/v1/funding?')) {
      reads += 1;
      return json(balance({ ...o, haveRaw: have }));
    }
    if (path === '/v1/testnet/fund' && init?.method === 'POST') {
      sent.push({ path, body: JSON.parse(String(init.body)) });
      have = '9999000000';
      return json({
        chain: 'solana',
        provenance: 'sandbox',
        wallet: SOLANA,
        cash: { symbol: 'USDC', decimals: 6, raw: '9999000000' },
        gas: { symbol: 'SOL', decimals: 9, raw: '28000000' },
        txIds: ['devnet-signature'],
        left: 2,
      });
    }
    return json({ error: 'not here' }, 404);
  });
}

function Deposit({ provenance }: { provenance: Provenance }) {
  const [amountText, setAmountText] = useState('');
  return createElement(DepositStep, {
    chain: 'solana',
    userId,
    allocations: [
      { assetId: 'solana:usdc', weightBps: 6000 },
      { assetId: 'solana:gldx', weightBps: 4000 },
    ],
    said: { goal: 'grow', risk: null },
    amountText,
    onAmountText: setAmountText,
    provenance,
    onChangeMix: () => {},
    onClose: () => {},
    host: { onOpen: () => {}, onRunning: () => {}, onLeave: () => {} },
  });
}
const card = async (provenance: Provenance) => {
  const host = await mount(withAccount('en', createElement(Deposit, { provenance })));
  await settle();
  return host;
};
const faucetButtons = (host: HTMLElement) =>
  [...host.querySelectorAll('button')].filter((b) =>
    [en.buy.funding.testFunds, en.buy.funding.testFundsUpTo('$10,000')].some((name) =>
      b.textContent?.includes(name),
    ),
  );

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_CHAIN_NETWORK_SOLANA', 'testnet');
  localStorage.clear();
  portStore.set(signedInPort(EMBEDDED, { userId }));
});
afterEach(async () => {
  await unmountAll();
  vi.unstubAllEnvs();
});

describe('the faucet at the top of the deposit card (FAUCET-TOP)', () => {
  it('is there before any amount on a test network that sends test funds, and is the only one', async () => {
    api({ provenance: 'sandbox', testFunds: true });
    const host = await card('sandbox');
    const top = find(host, '[data-ui="test-funds-top"]');
    // above the amount
    const amount = find(host, '[data-ui="amount-well"]');
    expect(top.compareDocumentPosition(amount) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(top.textContent).toContain(en.buy.funding.testTop);
    expect(faucetButtons(host)).toHaveLength(1);
    expect(faucetButtons(host)[0]?.textContent).toContain(en.buy.funding.testFundsUpTo('$10,000'));
  });

  it('asks for one send with no buy named, says what arrived, and reads the wallet again', async () => {
    api({ provenance: 'sandbox', testFunds: true });
    const host = await card('sandbox');
    const before = reads;
    await click(find(host, '[data-action="test-funds-top"]'));
    await settle();
    // one send over what the wallet holds ($0): within one send of $10,000 with the server's margin
    expect(sent.map((s) => s.body)).toEqual([{ amountUsd: 9_900, wallet: SOLANA }]);
    expect(reads).toBeGreaterThan(before);
    expect(find(host, '[data-ui="test-funds-sent"]').textContent).toBe(
      en.buy.funding.testSent('9,999 USDC and 0.028 SOL'),
    );
    // the balance follows what arrived
    expect(find(host, '[data-ui="amount-well"]').textContent).toContain('9,999');
    // and a second press asks for as much again over it
    await click(find(host, '[data-action="test-funds-top"]'));
    await settle();
    expect(sent.at(-1)?.body).toEqual({ amountUsd: 9_999 + 9_900, wallet: SOLANA });
  });

  it('is not there on a chain whose server sends no test funds, on mainnet, or on the mock', async () => {
    for (const o of [
      { provenance: 'sandbox' as const },
      { provenance: 'live' as const },
      { provenance: 'mock' as const },
    ]) {
      api(o);
      const host = await card(o.provenance);
      expect(host.querySelector('[data-ui="test-funds-top"]')).toBeNull();
      await unmountAll();
    }
  });

  it('says no range under the amount', async () => {
    api({ provenance: 'sandbox', testFunds: true });
    const host = await card('sandbox');
    expect(host.textContent).not.toContain('From $1 to $1,000,000');
  });
});

describe('the funds step under a card with the faucet at its top', () => {
  const short = {
    kind: 'read' as const,
    funding: { ...balance({ provenance: 'sandbox', testFunds: true }), ok: false },
  };
  const step = (faucetAbove: boolean) =>
    mount(
      withAccount(
        'en',
        createElement(FundingStep, {
          funding: short,
          chainName: 'Solana',
          owner: SOLANA,
          mock: false,
          units: unitsFor('solana', false),
          gasUnits: null,
          mockBusy: false,
          onReadAgain: () => {},
          onMock: () => {},
          testFunds: { busy: false, outcome: null, onAsk: () => {} },
          faucetAbove,
        }),
      ),
    );

  it('has no test-funds button of its own there, and keeps it elsewhere', async () => {
    expect(faucetButtons(await step(true))).toHaveLength(0);
    await unmountAll();
    expect(faucetButtons(await step(false))).toHaveLength(1);
  });
});
