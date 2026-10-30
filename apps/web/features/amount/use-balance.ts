'use client';
import { type ChainId, FundingResponse, type Provenance } from '@colosseum/schemas';
import { useEffect, useState } from 'react';
import type { PinSource } from '../../components/ui/provenance';
import type { ApiFetch } from '../account/person';
import { MIN_USD } from '../order/limits';
import { type BuyOf, type FundingOutcome, readFunding } from '../order/order-api';
import { unitsFor } from '../order/units';
import { useApiFetch } from '../wallet/WalletProvider';

// The wallet's dollar token and fee token, as the amount card shows them under the field ("Balance:
// 1,234.56 USDC · Max") and in its details (the network fee). Read by our server from the chain
// (GET /v1/funding, the same read the invest card makes), with its source, time and method on each
// figure. Read once for what is deposited into and the wallet, never on each key: the balance does not
// depend on the amount, and the read is asked for the least deposit so what it plans is the smallest.
// The decimals are this repository's own for the chain (units.ts), never the answer's, as the invest
// card reads them.

export type WalletFigure = {
  /** The amount in whole tokens. */
  amount: number;
  symbol: string;
  obs: PinSource;
};

export type WalletBalance =
  | { kind: 'idle' }
  | { kind: 'reading' }
  | { kind: 'failed' }
  | {
      kind: 'read';
      /** The chain's dollar token: what a deposit is paid in. */
      cash: WalletFigure & { asset: string };
      /** What the network fee of the deposit's steps may cost, in the chain's own token. */
      fee: WalletFigure;
      /** What the chain's figures are: `mock`, `sandbox` on a test network, `live`. */
      provenance: Provenance;
      /** Our server sends a short wallet test funds on this chain (the invest card offers it). */
      testFunds: boolean;
    };

/** GET /v1/funding with the wallet alone: its balances on the person's current chain, nothing planned. */
async function readBalance(apiFetch: ApiFetch, wallet: string): Promise<FundingOutcome> {
  try {
    const res = await apiFetch(`/v1/funding?${new URLSearchParams({ wallet })}`);
    if (!res.ok) return { kind: 'unreadable' };
    const read = FundingResponse.safeParse(await res.json());
    return read.success ? { kind: 'read', funding: read.data } : { kind: 'unreadable' };
  } catch {
    return { kind: 'unreachable' };
  }
}

const whole = (raw: string, decimals: number) => Number(BigInt(raw)) / 10 ** decimals;

export function useWalletBalance(
  /** What is deposited into; `wallet` reads the balance alone, before there is anything to name. */
  buyOf: BuyOf | 'wallet' | null,
  owner: string | null,
  chain: ChainId,
  mock: boolean,
  /** Changed by the caller when the wallet changed (test funds arrived): read again. */
  round = 0,
): WalletBalance {
  const apiFetch = useApiFetch();
  const [balance, setBalance] = useState<WalletBalance>({ kind: 'idle' });
  const key = buyOf && owner ? JSON.stringify([buyOf, owner, round]) : null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for what is bought, the wallet and the round
  useEffect(() => {
    if (!buyOf || !owner) return setBalance({ kind: 'idle' });
    let mine = true;
    setBalance({ kind: 'reading' });
    const asked =
      buyOf === 'wallet'
        ? readBalance(apiFetch, owner)
        : readFunding(apiFetch, { ...buyOf, amountUsd: MIN_USD, wallet: owner });
    asked.then((read) => {
      if (!mine) return;
      if (read.kind !== 'read') return setBalance({ kind: 'failed' });
      // GET /v1/funding with the wallet alone reads the person's current chain: where that is not this
      // deposit's (a conversation on another chain), no balance is said at all, rather than a wrong one.
      if (read.funding.chain !== chain) return setBalance({ kind: 'idle' });
      const f = read.funding;
      const units = unitsFor(chain, mock);
      // this repository's decimals for the chain's dollar, never the answer's: none, no figure
      const cashDecimals = units?.tokens[f.cash.asset]?.decimals;
      if (cashDecimals === undefined) return setBalance({ kind: 'failed' });
      const stamp = (figure: typeof f.cash | typeof f.gas): PinSource => ({
        source: figure.source,
        fetchedAt: figure.fetchedAt,
        method: figure.method,
        provenance: f.provenance,
      });
      setBalance({
        kind: 'read',
        cash: {
          asset: f.cash.asset,
          amount: whole(f.cash.haveRaw, cashDecimals),
          symbol: units?.tokens[f.cash.asset]?.symbol ?? f.cash.symbol,
          obs: stamp(f.cash),
        },
        fee: {
          amount: whole(f.gas.needRaw, f.gas.decimals),
          symbol: f.gas.symbol,
          obs: stamp(f.gas),
        },
        provenance: f.provenance,
        testFunds: f.testFunds === true,
      });
    });
    return () => {
      mine = false;
    };
  }, [apiFetch, key, chain, mock]);

  return balance;
}
