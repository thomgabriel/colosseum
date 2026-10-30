// @vitest-environment happy-dom
import type { FundingResponse, MixReview } from '@colosseum/schemas';
import { act, createElement, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, settle, type, unmountAll } from '../../components/ui/test/dom';
import { withAccount } from '../account/test/screen';
import { planOn } from '../order/test/fixtures';
import { EMBEDDED, json, SOLANA, signedInPort } from '../wallet/test/fake-port';
import { portStore } from '../wallet/test/mock-provider';
import type { DepositHost } from './DepositSign';
import { CHECK_MS, DepositStep } from './DepositStep';

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));
vi.mock('../wallet/signing', () => import('../wallet/test/mock-signing'));

// Gate FAUCET-TOP, after the press: the button at the top of the card goes with the amount, so the
// card's funds step has its own again. Otherwise a run that stopped, followed by "Make a new order" on
// a short wallet, would point up to a button that isn't there. The card's steps are stood in for here:
// what is under test is what the deposit step tells them.

const seen = vi.hoisted(() => ({
  faucetAbove: [] as boolean[],
  host: null as DepositHost | null,
}));
vi.mock('./DepositSign', () => ({
  DepositSign: (props: { faucetAbove?: boolean; host: DepositHost }) => {
    seen.faucetAbove.push(props.faucetAbove === true);
    seen.host = props.host;
    return null;
  },
}));

const userId = 'did:privy:test';
const stamp = {
  source: 'test',
  fetchedAt: '2026-10-30T11:00:00.000Z',
  method: 'the wallet balance',
  provenance: 'sandbox' as const,
};
const funding: FundingResponse = {
  chain: 'solana',
  name: 'Solana',
  mode: 'live',
  provenance: 'sandbox',
  wallet: SOLANA,
  cash: {
    ...stamp,
    asset: 'solana:usdc',
    symbol: 'USDC',
    decimals: 6,
    haveRaw: '0',
    needRaw: '0',
    missingRaw: '0',
  },
  gas: { ...stamp, symbol: 'SOL', decimals: 9, haveRaw: '0', needRaw: '0', missingRaw: '0' },
  steps: 0,
  newVault: false,
  ok: true,
  testFunds: true,
};
const review: MixReview = {
  chain: 'solana',
  origin: 'model',
  goal: 'grow',
  risk: 'medium',
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
      price: null,
      exitCeiling: null,
    },
  ],
  targets: [{ asset: 'solana:gldx', weightBps: 4000 }],
  cashBps: 6000,
  warnings: [],
  unconfirmed: [],
  reviewHash: 'ab'.repeat(32),
  provenance: 'sandbox',
  disclaimer: 'Test disclaimer',
};

function Deposit() {
  const [amountText, setAmountText] = useState('100');
  return createElement(DepositStep, {
    chain: 'solana',
    userId,
    allocations: [
      { assetId: 'solana:usdc', weightBps: 6000 },
      { assetId: 'solana:gldx', weightBps: 4000 },
    ],
    said: { goal: 'grow', risk: 'medium' },
    amountText,
    onAmountText: setAmountText,
    provenance: 'sandbox',
    onChangeMix: () => {},
    onClose: () => {},
    host: { onOpen: () => {}, onRunning: () => {}, onLeave: () => {} },
  });
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_CHAIN_NETWORK_SOLANA', 'testnet');
  localStorage.clear();
  seen.faucetAbove = [];
  seen.host = null;
  portStore.set(signedInPort(EMBEDDED, { userId }));
  portStore.setApi(async (path, init) => {
    if (path.startsWith('/v1/funding?')) return json(funding);
    if (!path.endsWith('/goal/accept')) return json({}, 404);
    return JSON.parse(String(init?.body)).confirm
      ? json({
          status: 'stored',
          review,
          proposalId: '0f6a3b9e-2c4d-4e5f-8a7b-1c2d3e4f5a6b',
          proposal: planOn('solana').proposal,
        })
      : json({ status: 'review', review });
  });
});
afterEach(async () => {
  await unmountAll();
  vi.unstubAllEnvs();
});

describe('the faucet at the top, once the deposit is pressed (FAUCET-TOP)', () => {
  it('goes, and the card’s funds step has its own button again', async () => {
    const host = await mount(withAccount('en', createElement(Deposit)));
    const input = host.querySelector<HTMLInputElement>('[data-ui="amount-well"] input');
    if (input) await type(input, '100');
    await settle(CHECK_MS + 50);
    await settle(CHECK_MS + 50);
    // before the press: the button is at the top, and the steps are told so
    expect(host.querySelector('[data-action="test-funds-top"]')).not.toBeNull();
    expect(seen.faucetAbove.at(-1)).toBe(true);

    await act(async () => {
      seen.host?.onOpen({
        planId: '0f6a3b9e-2c4d-4e5f-8a7b-1c2d3e4f5a6b',
        orderId: 'order-1',
        amountUsd: 100,
      });
    });
    await settle();
    expect(host.querySelector('[data-action="test-funds-top"]')).toBeNull();
    expect(seen.faucetAbove.at(-1)).toBe(false);
  });
});
