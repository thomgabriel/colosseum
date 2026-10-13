'use client';
import type { ChainId, Provenance } from '@colosseum/schemas';
import { useEffect, useState } from 'react';
import type { PinSource } from '../../components/ui/provenance';
import { MIN_USD } from '../order/limits';
import { type BuyOf, readFunding } from '../order/order-api';
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

const whole = (raw: string, decimals: number) => Number(BigInt(raw)) / 10 ** decimals;

export function useWalletBalance(
  buyOf: BuyOf | null,
  owner: string | null,
  chain: ChainId,
  mock: boolean,
): WalletBalance {
  const apiFetch = useApiFetch();
  const [balance, setBalance] = useState<WalletBalance>({ kind: 'idle' });
  const key = buyOf && owner ? JSON.stringify([buyOf, owner]) : null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for what is bought and the wallet
  useEffect(() => {
    if (!buyOf || !owner) return setBalance({ kind: 'idle' });
    let mine = true;
    setBalance({ kind: 'reading' });
    readFunding(apiFetch, { ...buyOf, amountUsd: MIN_USD, wallet: owner }).then((read) => {
      if (!mine) return;
      if (read.kind !== 'read') return setBalance({ kind: 'failed' });
      const f = read.funding;
      const units = unitsFor(chain, mock);
      const cashDecimals = units?.tokens[f.cash.asset]?.decimals ?? f.cash.decimals;
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
