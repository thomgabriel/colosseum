import { join } from 'node:path';
import { parseChainConfigs, parseFlags } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { evmDeployment, evmRecordFile } from './deployments';
import { FAUCET_KEY_ENV, faucetKeysFrom, onTestNetwork } from './faucet/test-funds';
import { createChainRegistry, MAINNET_SWITCH, mainnetAllowed } from './orders/chains';
import { robinhoodFromEnv } from './routes/v1/index';

// Robinhood Chain on mainnet is off unless three things are all there: the network is asked for
// (`CHAIN_NETWORK_ROBINHOOD=mainnet`), the second switch says so in words (`CHAIN_MAINNET_ROBINHOOD`),
// and the deploy's record is committed. No record of a mainnet is committed, so none of this reads one.

const cash = {
  chain: 'robinhood' as const,
  id: 'robinhood:usdg',
  address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
  symbol: 'USDG',
  decimals: 6,
  cls: 'cash' as const,
  underlying: 'USD',
  issuer: 'issuer not recorded',
  tier: 'C' as const,
  priceKind: 'none' as const,
  priceRef: '',
  session: 'always' as const,
  autoFollowEligible: true,
  maxWeightBps: 0,
  blockedCountries: [],
  sheet: 'unrated',
  provenance: 'live' as const,
};
const inputs = (mainnet: boolean) => ({
  rpc: {} as never,
  assets: [cash],
  pools: {
    quoter: '0x00000000000000000000000000000000000000cd' as const,
    hooks: '0x0000000000000000000000000000000000000000' as const,
    cash: cash.address as `0x${string}`,
    byToken: {},
  },
  limits: { priceBoundBps: 200, maxTradeUsd: {} },
  mainnet,
});
const contracts = {
  robinhood: {
    factory: '0x00000000000000000000000000000000000000f1',
    registry: '0x00000000000000000000000000000000000000f2',
  },
};

describe('Robinhood Chain on mainnet', () => {
  it('is not run by the network variable alone: the second switch is needed, in its exact words', () => {
    expect(MAINNET_SWITCH).toBe('CHAIN_MAINNET_ROBINHOOD');
    expect(mainnetAllowed({})).toBe(false);
    for (const value of ['', '1', 'true', 'yes', 'on', 'mainnet'])
      expect(mainnetAllowed({ CHAIN_MAINNET_ROBINHOOD: value }), value).toBe(false);
    expect(mainnetAllowed({ CHAIN_MAINNET_ROBINHOOD: 'real-money' })).toBe(true);
  });

  it('starts live only with inputs that came from a mainnet record under the switch', () => {
    const env = { CHAIN_MODE_ROBINHOOD: 'live', CHAIN_NETWORK_ROBINHOOD: 'mainnet' };
    const start = (mainnet: boolean) =>
      createChainRegistry(parseFlags(env), parseChainConfigs(env, contracts), {
        seed: 'a',
        robinhood: inputs(mainnet),
      }).get('robinhood');
    expect(() => start(false)).toThrow(
      'CHAIN_MODE_ROBINHOOD is live on mainnet, which this API does not run yet',
    );
    const entry = start(true);
    expect([entry.mode, entry.provenance, entry.mock]).toEqual(['live', 'live', undefined]);
    expect(entry.config.evmChainId).toBe(4663);
    expect(entry.source).not.toMatch(/https?:/);
  });

  it('never for Solana or Base: only Robinhood Chain has the switch', () => {
    const env = { CHAIN_MODE_SOLANA: 'live', CHAIN_NETWORK_SOLANA: 'mainnet' };
    expect(() =>
      createChainRegistry(parseFlags(env), parseChainConfigs(env, {}), {
        seed: 'a',
        robinhood: inputs(true),
      }),
    ).toThrow('CHAIN_MODE_SOLANA is live on mainnet, which this API does not run yet');
  });

  it('runs beside Solana on its test network, each labelled as what it is', () => {
    const env = {
      CHAIN_MODE_ROBINHOOD: 'live',
      CHAIN_NETWORK_ROBINHOOD: 'mainnet',
      CHAIN_MODE_SOLANA: 'mock',
      CHAIN_NETWORK_SOLANA: 'testnet',
    };
    const registry = createChainRegistry(parseFlags(env), parseChainConfigs(env, contracts), {
      seed: 'a',
      robinhood: inputs(true),
    });
    expect(registry.get('robinhood').provenance).toBe('live');
    expect(registry.get('solana').provenance).not.toBe('live');
    expect(registry.get('solana').config.network).toBe('testnet');
  });

  it('a mainnet record does not start without the switch, whatever else is set, and asks no node first', async () => {
    const record = { network: 'robinhood-mainnet', provenance: 'live' } as never;
    const db = {} as never;
    let connected = 0;
    const connect = () => {
      connected += 1;
      return {} as never;
    };
    for (const env of [
      { ROBINHOOD_RPC_URL: 'https://node.example' },
      { ROBINHOOD_RPC_URL: 'https://node.example', CHAIN_MAINNET_ROBINHOOD: 'true' },
    ])
      await expect(robinhoodFromEnv(env, 'live', db, record, connect)).rejects.toThrow(
        'set CHAIN_MAINNET_ROBINHOOD to real-money to run on mainnet with real money',
      );
    expect(connected).toBe(0);
  });

  it('offers no test funds on mainnet: the faucet is a test network’s', () => {
    const env = { CHAIN_MODE_ROBINHOOD: 'live', CHAIN_NETWORK_ROBINHOOD: 'mainnet' };
    const entry = createChainRegistry(parseFlags(env), parseChainConfigs(env, contracts), {
      seed: 'a',
      robinhood: inputs(true),
    }).get('robinhood');
    expect(onTestNetwork(entry)).toBe(false);
    // Even with a faucet key set for the chain, none is kept for a chain that is not a test network.
    expect(
      faucetKeysFrom({ [FAUCET_KEY_ENV.robinhood ?? 'x']: '0xabc' }, {
        active: () => [entry],
      } as never),
    ).toBeNull();
  });

  it('looks for the mainnet record under its own name, and finds none committed', () => {
    const dir = join(import.meta.dirname, '..', '..', '..', 'deployments');
    expect(evmRecordFile('robinhood', 'mainnet', dir)).toBe(join(dir, 'robinhood-mainnet.json'));
    expect(evmRecordFile('robinhood', 'testnet', dir)).toBe(join(dir, 'robinhood-testnet.json'));
    const found = evmDeployment(
      'robinhood',
      { CHAIN_NETWORK_ROBINHOOD: 'mainnet' },
      undefined,
      dir,
    );
    expect(found.record).toBeNull();
  });

  it('has an explorer for a mainnet transaction, so a step is never logged without its link', () => {
    const env = { CHAIN_NETWORK_ROBINHOOD: 'mainnet' };
    expect(parseChainConfigs(env, contracts).robinhood.explorerTx).toBe(
      'https://robinhoodchain.blockscout.com/tx/{txId}',
    );
  });
});
