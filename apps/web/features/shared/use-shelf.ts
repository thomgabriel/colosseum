'use client';
import { ChainId } from '@colosseum/schemas';
import { useEffect, useState } from 'react';
import { useApiFetch, useWalletPort } from '../wallet/WalletProvider';
import { readConfig } from './shared-api';

// Whether the server lists live portfolios only (gate PRODUCTS-MAINNET-ONLY, `SHELF_LIVE_ONLY` in
// GET /v1/config), and the chains it runs live: the shelf and the publish form follow the server, never
// a guess of this app's. Null while it is read, and where it cannot be: nothing is held back then.

export type ShelfScope = { liveOnly: boolean; live: ChainId[] };

export function useShelfScope(): ShelfScope | null {
  const apiFetch = useApiFetch();
  const port = useWalletPort();
  const [liveOnly, setLiveOnly] = useState<boolean | null>(null);
  useEffect(() => {
    let mine = true;
    readConfig(apiFetch).then((read) => {
      if (mine) setLiveOnly(read.kind === 'read' ? read.value.flags.shelfLiveOnly : false);
    });
    return () => {
      mine = false;
    };
  }, [apiFetch]);
  if (liveOnly === null) return null;
  const live = ChainId.options.filter((chain) => {
    const network = port.network(chain);
    return network?.on === true && network.provenance === 'live';
  });
  return { liveOnly, live };
}
