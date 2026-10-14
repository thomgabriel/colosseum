import { afterEach, describe, expect, it, vi } from 'vitest';
import { explorerHeightUrlFor, heightWord } from './explorer-height';

// The explorer's page of the slot or block a vault was read at (VaultDetails, "Read at"): from the
// same table as every transaction link, for the network the app runs.

afterEach(() => vi.unstubAllEnvs());

describe('the page of a slot or a block', () => {
  it('is Solscan’s block page on Solana, with the devnet cluster on the test network', () => {
    vi.stubEnv('NEXT_PUBLIC_CHAIN_NETWORK_SOLANA', 'testnet');
    expect(explorerHeightUrlFor('solana', '51073956', false)).toBe(
      'https://solscan.io/block/51073956?cluster=devnet',
    );
    expect(heightWord('solana')).toBe('slot');
  });

  it('is Etherscan’s block page on Robinhood Chain mainnet', () => {
    vi.stubEnv('NEXT_PUBLIC_CHAIN_NETWORK_ROBINHOOD', 'mainnet');
    expect(explorerHeightUrlFor('robinhood', '87782231', false)).toBe(
      'https://robin.etherscan.io/block/87782231',
    );
    expect(heightWord('robinhood')).toBe('block');
  });

  it('is none on the mock, and none for what is not a height', () => {
    expect(explorerHeightUrlFor('solana', '51073956', true)).toBeNull();
    expect(explorerHeightUrlFor('solana', '12ab', false)).toBeNull();
  });
});
