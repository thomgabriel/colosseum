import { type ChainId, chainFamily } from '@colosseum/schemas';
import { publicWalletEnv, walletChains } from '../wallet/chains';

/**
 * The explorer's page of a slot (Solana) or a block (EVM) on the chain the app runs, from the same
 * table as every transaction link (`explorerTx`, chain-presets): its `/tx/{txId}` becomes
 * `/block/{height}`, the network's query kept (Solscan's `?cluster=devnet`). Null on the mock, on a
 * network with no explorer, or where the table cannot be read.
 */
export function explorerHeightUrlFor(chain: ChainId, height: string, mock: boolean): string | null {
  if (mock || !/^\d+$/.test(height)) return null;
  try {
    const { explorerTx } = walletChains(publicWalletEnv())[chain].config;
    if (!explorerTx?.includes('/tx/{txId}')) return null;
    return explorerTx.replace('/tx/{txId}', `/block/${height}`);
  } catch {
    return null;
  }
}

/** Whether the chain counts its height in slots (Solana) or in blocks (EVM). */
export const heightWord = (chain: ChainId): 'slot' | 'block' =>
  chainFamily(chain) === 'solana' ? 'slot' : 'block';
