import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deploymentAssets, EvmDeploymentRecord, v4Pools } from '@colosseum/chain-evm/vault';
import { ConfigResponse, parseChainConfigs, parseFlags } from '@colosseum/schemas';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';
import { evmDeployment, evmRecordFile } from './deployments';
import { FAUCET_KEY_ENV, faucetKeysFrom, onTestNetwork } from './faucet/test-funds';
import { createChainRegistry, MAINNET_SWITCH, mainnetAllowed } from './orders/chains';
import {
  FILL_SCRIPT,
  holdToEvmRecord,
  missingFromEvmRecord,
  registerV1Routes,
  robinhoodFromEnv,
} from './routes/v1/index';

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
  pools: v4Pools(cash.address, [], '0x00000000000000000000000000000000000000cd'),
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

  it('holds every token row to the record’s own label: a test row on a live chain refuses, and a live row on a test network', () => {
    const dir = join(import.meta.dirname, '..', '..', '..', 'deployments');
    const record = EvmDeploymentRecord.parse(
      JSON.parse(readFileSync(join(dir, 'robinhood-testnet.json'), 'utf8')),
    );
    const rows = deploymentAssets(record);
    expect(holdToEvmRecord(rows, record)).toHaveLength(rows.length);
    const liveRow = rows.map((r, i) => (i === 1 ? { ...r, provenance: 'live' as const } : r));
    expect(() => holdToEvmRecord(liveRow, record)).toThrow(
      /has provenance live, and robinhood-testnet says sandbox/,
    );

    // The same on a live chain: its record's rows are live, and one left as a test network's refuses.
    const mainnet = EvmDeploymentRecord.parse({
      ...JSON.parse(readFileSync(join(dir, 'robinhood-testnet.json'), 'utf8')),
      network: 'robinhood-mainnet',
      provenance: 'live',
      evmChainId: 4663,
      roles: {
        admin: `0x${'71'.padStart(40, '0')}`,
        guardian: `0x${'60'.padStart(40, '0')}`,
        keeper: `0x${'0'.repeat(40)}`,
        priceWriter: null,
        tokenIssuer: null,
      },
      priceBoundBps: 200,
      assets: JSON.parse(readFileSync(join(dir, 'robinhood-testnet.json'), 'utf8')).assets.map(
        (a: Record<string, unknown>) => ({ ...a, maxTradeUsd: 1000 }),
      ),
      timelock: {
        address: `0x${'71'.padStart(40, '0')}`,
        minDelay: 172_800,
        proposers: [`0x${'5afe'.padStart(40, '0')}`],
      },
      expected: { launched: false, publishDelay: 172_800, keeperEnabled: true },
    });
    const live = deploymentAssets(mainnet);
    expect(live.every((r) => r.provenance === 'live')).toBe(true);
    expect(holdToEvmRecord(live, mainnet)).toHaveLength(live.length);
    const testRow = live.map((r, i) => (i === 0 ? { ...r, provenance: 'sandbox' as const } : r));
    expect(() => holdToEvmRecord(testRow, mainnet)).toThrow(
      /has provenance sandbox, and robinhood-mainnet says live/,
    );
  });

  it('starts without a token the record shows and has no row for, and names every one', () => {
    const dir = join(import.meta.dirname, '..', '..', '..', 'deployments');
    const record = EvmDeploymentRecord.parse(
      JSON.parse(readFileSync(join(dir, 'robinhood-mainnet.json'), 'utf8')),
    );
    const rows = deploymentAssets(record);
    // the committed record's shown tokens and its cash: the 20 rows the hosted table holds since
    // Oct 15, the five shown since the v3 route (gate V3-ROUTE, Oct 23), and GME, listed by the
    // Safe's batch of gate LIST-13
    const v3Five = ['AMD', 'INTC', 'MU', 'QQQ', 'SLV'];
    expect(rows.map((r) => r.symbol).sort()).toEqual(
      [
        'USDG',
        ...['AAPL', 'AMZN', 'BABA', 'COIN', 'CRCL', 'GLD', 'GOOGL', 'META', 'MSFT', 'MSTR'],
        ...['NVDA', 'PLTR', 'SPCX', 'SPY', 'TSLA', 'TSM', 'USO', 'WETH', 'cbBTC'],
        ...v3Five,
        'GME',
      ].sort(),
    );
    expect(holdToEvmRecord(rows, record)).toHaveLength(26);
    expect(missingFromEvmRecord(rows, record)).toEqual([]);
    // the table as it stood before the redeploy's rows were written: ten of the twenty-five. The API
    // starts on them (withdrawals and reads go on), and the other fifteen are named, each with its address.
    const ten = ['USDG', 'NVDA', 'SPY', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'TSLA', 'GLD'];
    const before = rows.filter((r) => ten.includes(r.symbol));
    expect(holdToEvmRecord(before, record)).toHaveLength(10);
    expect(missingFromEvmRecord(before, record)).toEqual(
      rows.filter((r) => !ten.includes(r.symbol)).map((r) => ({ id: r.id, address: r.address })),
    );
    // the table as it stands from Oct 15 until the fill script runs again: the five and GME are named
    const later = [...v3Five, 'GME'];
    const sinceOct15 = rows.filter((r) => !later.includes(r.symbol));
    expect(holdToEvmRecord(sinceOct15, record)).toHaveLength(20);
    expect(
      missingFromEvmRecord(sinceOct15, record)
        .map((m) => m.id)
        .sort(),
    ).toEqual(later.map((x) => `robinhood:${x.toLowerCase()}`).sort());
  });

  it('names every row that does not match the record, and the script that writes them', () => {
    const dir = join(import.meta.dirname, '..', '..', '..', 'deployments');
    const record = EvmDeploymentRecord.parse(
      JSON.parse(readFileSync(join(dir, 'robinhood-mainnet.json'), 'utf8')),
    );
    // five rows another network's, and no cash: six problems, every one said
    const wrong = deploymentAssets(record)
      .filter((r) => r.cls !== 'cash')
      .slice(0, 5)
      .map((r) => ({ ...r, provenance: 'sandbox' as const }));
    let message = '';
    try {
      holdToEvmRecord(wrong, record);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('(6 problems)');
    for (const r of wrong) expect(message).toContain(`${r.id} has provenance sandbox`);
    expect(message).toContain("the cash row is not robinhood-mainnet's cash");
    expect(message).toContain(`with ${FILL_SCRIPT.robinhood}, then deploy`);
  });

  it('says the missing tokens at start, as an error, and in GET /v1/config', async () => {
    const lines: Array<Record<string, unknown>> = [];
    const app = Fastify({
      logger: { level: 'error', stream: { write: (line: string) => lines.push(JSON.parse(line)) } },
    });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const missing = [
      { id: 'robinhood:spcx', address: '0x00000000000000000000000000000000000005c1' },
    ];
    await registerV1Routes(
      app,
      { CHAIN_MODE_ROBINHOOD: 'readonly' },
      { contracts, robinhood: { ...inputs(false), missing } },
    );
    const body = ConfigResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/config' })).json(),
    );
    await app.close();
    expect(body.chains.find((c) => c.id === 'robinhood')?.missingAssets).toEqual(missing);
    // a chain on the mock is run from no record, and says nothing of one
    expect(body.chains.find((c) => c.id === 'solana')?.missingAssets).toBeUndefined();
    const said = lines.find((line) => line.code === 'basket_assets_missing');
    expect(said).toMatchObject({ level: 50, chain: 'robinhood', missing });
    expect(String(said?.msg)).toContain(FILL_SCRIPT.robinhood);
  });

  it('looks for the mainnet record under its own name, and finds the one committed', () => {
    const dir = join(import.meta.dirname, '..', '..', '..', 'deployments');
    expect(evmRecordFile('robinhood', 'mainnet', dir)).toBe(join(dir, 'robinhood-mainnet.json'));
    expect(evmRecordFile('robinhood', 'testnet', dir)).toBe(join(dir, 'robinhood-testnet.json'));
    const found = evmDeployment(
      'robinhood',
      { CHAIN_NETWORK_ROBINHOOD: 'mainnet' },
      undefined,
      dir,
    );
    expect(found.record).toMatchObject({
      network: 'robinhood-mainnet',
      provenance: 'live',
      evmChainId: 4663,
    });
  });

  it('has an explorer for a mainnet transaction, so a step is never logged without its link', () => {
    const env = { CHAIN_NETWORK_ROBINHOOD: 'mainnet' };
    expect(parseChainConfigs(env, contracts).robinhood.explorerTx).toBe(
      'https://robin.etherscan.io/tx/{txId}',
    );
  });
});

// The flags are read at every start with the whole environment, and a name under CHAIN_ that nobody
// knows stops the server as a typo. The switch's own name has to be known, or mainnet can never start:
// on Oct 12 2026 the hosted API refused its first mainnet deploy with "unknown variable:
// CHAIN_MAINNET_ROBINHOOD".
describe('the mainnet switch is a name the flags know', () => {
  it('reads the environment of a mainnet deploy without calling the switch a typo', () => {
    const env = {
      CHAIN_MODE_ROBINHOOD: 'live',
      CHAIN_NETWORK_ROBINHOOD: 'mainnet',
      [MAINNET_SWITCH]: 'real-money',
      CHAIN_MODE_SOLANA: 'live',
    };
    expect(() => parseFlags(env)).not.toThrow();
    expect(parseFlags(env).chainMode.robinhood).toBe('live');
    expect(() => parseChainConfigs(env)).not.toThrow();
  });

  it('still stops on a misspelt switch', () => {
    expect(() => parseFlags({ CHAIN_MAINNET_ROBINHOD: 'real-money' })).toThrow(
      'unknown variable: CHAIN_MAINNET_ROBINHOD',
    );
  });
});
