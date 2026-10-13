import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createEvmRpc, type EvmRpc, READ_METHODS } from '@colosseum/chain-evm/vault';
import type { VaultNodeRpc } from '@colosseum/chain-solana/vault';
import { ChainError, ChainId, type EnvLike, envKey, KNOWN_ENV_KEYS } from '@colosseum/schemas';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ALSO_KNOWN,
  EVM_NODE,
  labelOfEvm,
  mainnetRefusal,
  NO_CHAIN,
  rulesOfConfig,
  rulesOfPlatform,
  type SourceOptions,
  SWITCH_REFUSAL,
  sandboxOnly,
  sourcesFromEnv,
} from './chains';
import { sampleVault } from './mock-world';

// Which chains the worker reads and how each is wired, from the environment alone. No test here
// opens a connection: the node's client and the node check are handed in, and a refusal comes
// before either. Two tests hand in no check, so the worker's default one runs, on a stand-in client
// that answers as a mainnet node would.

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const SOLANA_URL = 'https://Solana.example.invalid/?api-key=SolKey123';
const ROBINHOOD_URL = 'https://rh.example.invalid/v2/RhKey456';
const T0 = new Date('2026-10-06T15:00:00.000Z');

/** Stand-ins for the two nodes, and a record of what was asked of whom. */
function seam(over: Partial<SourceOptions> = {}) {
  const connected: string[] = [];
  const checked: string[] = [];
  const solanaRpc = { getSlot: () => ({ send: async () => 1234n }) } as unknown as VaultNodeRpc;
  const evmRpc = { getBlockNumber: async () => 99n } as unknown as EvmRpc;
  const options: SourceOptions = {
    now: () => T0,
    connectSolana: (url) => {
      connected.push(url);
      return solanaRpc;
    },
    connectEvm: (url) => {
      connected.push(url);
      return evmRpc;
    },
    checkSolana: async (_rpc, record) => {
      checked.push(record.network);
    },
    checkEvm: async (_rpc, record) => {
      checked.push(record.network);
    },
    warn: () => {},
    ...over,
  };
  return { options, connected, checked };
}

const SOLANA: EnvLike = { CHAIN_MODE_SOLANA: 'readonly', SOLANA_RPC_URL: SOLANA_URL };
const ROBINHOOD: EnvLike = { CHAIN_MODE_ROBINHOOD: 'readonly', ROBINHOOD_RPC_URL: ROBINHOOD_URL };
// Gate SNAPSHOT-WORKER as amended on Oct 13: Robinhood Chain is read on mainnet too, from its own
// record, under the switch the API needs, labelled `live`. Solana and Base stay off mainnet.
const MAINNET: EnvLike = {
  CHAIN_MODE_ROBINHOOD: 'live',
  CHAIN_NETWORK_ROBINHOOD: 'mainnet',
  CHAIN_MAINNET_ROBINHOOD: 'real-money',
  ROBINHOOD_RPC_URL: ROBINHOOD_URL,
};

const READS = ['getPrices', 'getVault', 'getVaults', 'height', 'listAssets', 'rules'];
const LABELS = ['chain', 'name', 'provenance', 'source'];

afterEach(() => {
  vi.useRealTimers();
});

describe('the worker and mainnet', () => {
  it('stops on a chain set to mainnet, whichever chain and whatever its mode, naming the variable', async () => {
    for (const chain of ChainId.options) {
      const key = envKey('CHAIN_NETWORK', chain);
      for (const mode of ['live', 'readonly', 'mock', 'off', undefined]) {
        const s = seam();
        const env = {
          ...SOLANA,
          ...ROBINHOOD,
          [envKey('CHAIN_MODE', chain)]: mode,
          [key]: 'mainnet',
        };
        // Robinhood Chain is the one mainnet the worker reads, and not without its switch.
        await expect(sourcesFromEnv(env, s.options), `${chain} ${mode}`).rejects.toThrow(
          chain === 'robinhood'
            ? SWITCH_REFUSAL
            : `${key} is mainnet, and the snapshot worker reads the test networks only until a person says otherwise`,
        );
        expect(s.connected, `${chain} ${mode}`).toEqual([]);
        expect(s.checked).toEqual([]);
      }
    }
    expect(mainnetRefusal('CHAIN_NETWORK_SOLANA')).toContain('CHAIN_NETWORK_SOLANA is mainnet');
    expect(SWITCH_REFUSAL).toContain('CHAIN_NETWORK_ROBINHOOD is mainnet');
  });

  it('stops on Solana or Base set to mainnet even with Robinhood Chain’s switch set', async () => {
    for (const chain of ['solana', 'base'] as const) {
      const s = seam();
      const key = envKey('CHAIN_NETWORK', chain);
      await expect(
        sourcesFromEnv({ ...SOLANA, ...MAINNET, [key]: 'mainnet' }, s.options),
        chain,
      ).rejects.toThrow(mainnetRefusal(key));
      expect(s.connected).toEqual([]);
    }
  });

  it('reads the setting as the chain configs do, and says it before anything else that is wrong', async () => {
    const s = seam();
    await expect(
      sourcesFromEnv({ CHAIN_NETWORK_ROBINHOOD: '  MainNet ' }, s.options),
    ).rejects.toThrow(SWITCH_REFUSAL);
    await expect(sourcesFromEnv({ CHAIN_NETWORK_SOLANA: '  MainNet ' }, s.options)).rejects.toThrow(
      mainnetRefusal('CHAIN_NETWORK_SOLANA'),
    );
    // A chain it would not read, a name the flags do not know and a list that names nothing.
    await expect(
      sourcesFromEnv(
        { CHAIN_NETWORK_BASE: 'mainnet', KEEPER_TYPO: 'x', SNAPSHOT_CHAINS: 'nowhere' },
        s.options,
      ),
    ).rejects.toThrow(mainnetRefusal('CHAIN_NETWORK_BASE'));
  });

  it('labels a real chain sandbox, and refuses a network whose figures would be labelled live', () => {
    expect(sandboxOnly('solana', 'testnet')).toBe('sandbox');
    expect(sandboxOnly('robinhood', 'local')).toBe('sandbox');
    expect(() => sandboxOnly('solana', 'mainnet')).toThrow(
      'CHAIN_NETWORK_SOLANA is mainnet, whose figures would be labelled live',
    );
    // `live` is Robinhood Chain's mainnet alone, and only under the switch.
    expect(labelOfEvm('robinhood', 'testnet', {})).toBe('sandbox');
    expect(labelOfEvm('robinhood', 'local', MAINNET)).toBe('sandbox');
    expect(labelOfEvm('robinhood', 'mainnet', MAINNET)).toBe('live');
    expect(() => labelOfEvm('robinhood', 'mainnet', {})).toThrow(SWITCH_REFUSAL);
  });
});

describe('which chains the worker reads', () => {
  it('refuses to start with no chain to read, and says both ways to name one', async () => {
    const s = seam();
    await expect(sourcesFromEnv({}, s.options)).rejects.toThrow(NO_CHAIN);
    expect(NO_CHAIN).toContain('CHAIN_MODE_<CHAIN>');
    expect(NO_CHAIN).toContain('SNAPSHOT_CHAINS');
    // A list that names nothing is no list.
    await expect(sourcesFromEnv({ SNAPSHOT_CHAINS: ' , ' }, s.options)).rejects.toThrow(NO_CHAIN);
    await expect(sourcesFromEnv({ SNAPSHOT_CHAINS: '  ' }, s.options)).rejects.toThrow(NO_CHAIN);
  });

  it('reads a chain on the mock only when SNAPSHOT_CHAINS names it', async () => {
    const s = seam();
    // The default modes are mock, mock and off: nothing is read by omission.
    await expect(sourcesFromEnv({ CHAIN_MODE_SOLANA: 'mock' }, s.options)).rejects.toThrow(
      NO_CHAIN,
    );
    const named = await sourcesFromEnv({ SNAPSHOT_CHAINS: 'solana' }, s.options);
    expect(named.map((x) => [x.chain, x.provenance])).toEqual([['solana', 'mock']]);
    // Beside a real chain, the mock one is still left out unless named.
    const real = await sourcesFromEnv({ ...SOLANA, CHAIN_MODE_ROBINHOOD: 'mock' }, s.options);
    expect(real.map((x) => [x.chain, x.provenance])).toEqual([['solana', 'sandbox']]);
    const both = await sourcesFromEnv(
      { ...SOLANA, SNAPSHOT_CHAINS: 'Robinhood, solana ,solana' },
      s.options,
    );
    expect(both.map((x) => [x.chain, x.provenance])).toEqual([
      ['solana', 'sandbox'],
      ['robinhood', 'mock'],
    ]);
  });

  it('reads every chain that is live or readonly when no list is given, and only the list when one is', async () => {
    const s = seam();
    const all = await sourcesFromEnv(
      { ...SOLANA, ...ROBINHOOD, CHAIN_MODE_ROBINHOOD: 'live' },
      s.options,
    );
    expect(all.map((x) => x.chain)).toEqual(['solana', 'robinhood']);
    const one = await sourcesFromEnv(
      { ...SOLANA, ...ROBINHOOD, SNAPSHOT_CHAINS: 'robinhood' },
      seam().options,
    );
    expect(one.map((x) => x.chain)).toEqual(['robinhood']);
  });

  it('refuses a chain it does not know, without repeating what was typed', async () => {
    const s = seam();
    const typed = 'solana,something-pasted-by-mistake';
    const refusal = await sourcesFromEnv({ SNAPSHOT_CHAINS: typed }, s.options).catch(
      (e: Error) => e.message,
    );
    expect(refusal).toBe(
      'SNAPSHOT_CHAINS: expected chain ids separated by commas, from solana, base, robinhood',
    );
    expect(refusal).not.toContain('pasted');
  });

  it('refuses a named chain that is off, and Base on a real network, by name', async () => {
    const s = seam();
    await expect(sourcesFromEnv({ SNAPSHOT_CHAINS: 'base' }, s.options)).rejects.toThrow(
      'SNAPSHOT_CHAINS names base, and CHAIN_MODE_BASE is off',
    );
    await expect(
      sourcesFromEnv({ SNAPSHOT_CHAINS: 'solana', CHAIN_MODE_SOLANA: 'off' }, s.options),
    ).rejects.toThrow('SNAPSHOT_CHAINS names solana, and CHAIN_MODE_SOLANA is off');
    for (const mode of ['live', 'readonly'])
      for (const list of [undefined, 'base'])
        await expect(
          sourcesFromEnv({ CHAIN_MODE_BASE: mode, SNAPSHOT_CHAINS: list }, s.options),
          `${mode} ${list}`,
        ).rejects.toThrow(
          `CHAIN_MODE_BASE is ${mode}, and the snapshot worker has no reader for Base on a real network yet`,
        );
    // On the mock, Base is a chain like the others.
    const mock = await sourcesFromEnv(
      { CHAIN_MODE_BASE: 'mock', SNAPSHOT_CHAINS: 'base' },
      s.options,
    );
    expect(mock.map((x) => x.name)).toEqual(['Base (mock)']);
    expect(s.connected).toEqual([]);
  });

  it('does not stop on the names the keeper reads, and still stops on a name nobody reads', async () => {
    const s = seam();
    const shared = Object.fromEntries(ALSO_KNOWN.map((name) => [name, '/some/where']));
    await expect(
      sourcesFromEnv({ ...shared, KEEPER_ENABLED: 'on', SNAPSHOT_CHAINS: 'solana' }, s.options),
    ).resolves.toHaveLength(1);
    await expect(
      sourcesFromEnv({ KEEPER_SOLANA_KEYPIAR: '/x', SNAPSHOT_CHAINS: 'solana' }, s.options),
    ).rejects.toThrow('unknown variable: KEEPER_SOLANA_KEYPIAR');
    await expect(
      sourcesFromEnv({ CHAIN_MODE_SOLANA: 'reads', SNAPSHOT_CHAINS: 'solana' }, s.options),
    ).rejects.toThrow('CHAIN_MODE_SOLANA: expected live, readonly, mock, off');
  });

  it('knows every KEEPER_ name the keeper and its run script mention', () => {
    const keeper = `${REPO}apps/keeper/src/`;
    const texts = [
      ...readdirSync(keeper)
        .filter((name) => name.endsWith('.ts'))
        .map((name) => readFileSync(`${keeper}${name}`, 'utf8')),
      readFileSync(`${REPO}scripts/keeper/run.sh`, 'utf8'),
    ];
    const names = new Set(texts.flatMap((text) => text.match(/\bKEEPER_[A-Z][A-Z0-9_]*\b/g) ?? []));
    expect(names.size).toBeGreaterThan(5);
    const known = new Set([...KNOWN_ENV_KEYS, ...ALSO_KNOWN]);
    expect([...names].filter((name) => !known.has(name))).toEqual([]);
  });
});

describe('a chain on the mock', () => {
  it('is labelled mock, has a band and no other rule, and its height is its clock', async () => {
    const [source] = await sourcesFromEnv(
      { SNAPSHOT_CHAINS: 'robinhood', CHAIN_MODE_ROBINHOOD: 'mock' },
      seam().options,
    );
    if (!source) throw new Error('no source');
    expect(source.name).toBe('Robinhood Chain (mock)');
    expect(source.provenance).toBe('mock');
    expect(source.source).toBe('chain-mock');
    expect(await source.rules()).toEqual({ paused: null, lossCapBps: null, bandBps: 50 });
    expect(await source.height()).toBe(BigInt(Math.floor(T0.getTime() / 1000)));
    const assets = await source.listAssets();
    expect(assets.every((a) => a.provenance === 'mock')).toBe(true);
    const prices = await source.getPrices(assets.map((a) => a.id));
    expect(prices.every((p) => p.provenance === 'mock' && p.source === 'chain-mock')).toBe(true);
  });

  it('carries the reads and the sample world, and nothing that builds or lands a transaction', async () => {
    const [source] = await sourcesFromEnv({ SNAPSHOT_CHAINS: 'solana' }, seam().options);
    if (!source) throw new Error('no source');
    expect(Object.keys(source).sort()).toEqual([...LABELS, ...READS, 'prepare'].sort());
    // The sample world behind `prepare`: with nothing named, the height follows the pass.
    const at = new Date(T0.getTime() + 600_000);
    // It answers the sample vault's address, which the database does not name: the pass reads it.
    const made = await source.prepare?.([], at);
    expect(made).toEqual([sampleVault('solana')]);
    expect(await source.getVault(sampleVault('solana'))).not.toBeNull();
    expect(await source.height()).toBe(BigInt(Math.floor(at.getTime() / 1000)));
  });
});

describe('Solana on its test network', () => {
  it('is its reader on the record of devnet, labelled sandbox, behind the node check', async () => {
    for (const mode of ['readonly', 'live']) {
      const s = seam();
      const [source] = await sourcesFromEnv({ ...SOLANA, CHAIN_MODE_SOLANA: mode }, s.options);
      if (!source) throw new Error('no source');
      expect(source.chain).toBe('solana');
      expect(source.name).toBe('Solana devnet');
      expect(source.provenance).toBe('sandbox');
      expect(source.source).toBe('Solana devnet, read over RPC by the vault reader');
      expect(Object.keys(source).sort()).toEqual([...LABELS, ...READS].sort());
      // The URL as written: a key in it is case-sensitive.
      expect(s.connected).toEqual([SOLANA_URL]);
      expect(s.checked).toEqual(['solana-devnet']);
      const assets = await source.listAssets();
      expect(assets.filter((a) => a.cls === 'cash').map((a) => a.id)).toEqual(['solana:usdc']);
      expect(assets.length).toBeGreaterThan(5);
      expect(assets.every((a) => a.provenance === 'sandbox')).toBe(true);
      expect(await source.height()).toBe(1234n);
    }
  });

  it('says a missing node by its variable, before any node is asked', async () => {
    const s = seam();
    await expect(sourcesFromEnv({ CHAIN_MODE_SOLANA: 'readonly' }, s.options)).rejects.toThrow(
      'CHAIN_MODE_SOLANA is readonly, and SOLANA_RPC_URL is not set',
    );
    await expect(
      sourcesFromEnv({ CHAIN_MODE_SOLANA: 'live', SOLANA_RPC_URL: '  ' }, s.options),
    ).rejects.toThrow('CHAIN_MODE_SOLANA is live, and SOLANA_RPC_URL is not set');
    // Solana is fine and Robinhood Chain is not: Solana's node is not asked either.
    await expect(
      sourcesFromEnv({ ...SOLANA, CHAIN_MODE_ROBINHOOD: 'readonly' }, s.options),
    ).rejects.toThrow('CHAIN_MODE_ROBINHOOD is readonly, and ROBINHOOD_RPC_URL is not set');
    expect(s.checked).toEqual([]);
  });

  it('does not start on a node that is not the record’s network', async () => {
    const s = seam({
      checkSolana: async () => {
        throw new Error(
          'the Solana RPC is a mainnet node, and this server runs a test network only',
        );
      },
    });
    await expect(sourcesFromEnv(SOLANA, s.options)).rejects.toThrow('is a mainnet node');
  });

  it('asks the node itself when no check is handed in, and refuses one that answers mainnet’s genesis', async () => {
    // Every other test here hands in a check of its own. This one hands in none, so what runs is
    // the worker's default: with the variable unset (testnet) and a mainnet node behind the URL, it
    // is the one thing that keeps mainnet's state from being stored as a test network's.
    const s = seam({
      checkSolana: undefined,
      connectSolana: () =>
        ({
          // Solana mainnet-beta's genesis, written out: the answer of the real network.
          getGenesisHash: () => ({
            send: async () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
          }),
          getSlot: () => ({ send: async () => 1n }),
        }) as unknown as VaultNodeRpc,
    });
    await expect(sourcesFromEnv(SOLANA, s.options)).rejects.toThrow('is a mainnet node');
    expect(s.checked).toEqual([]);
  });

  it('reads the record of the network, and refuses one that is missing, unreadable or another’s', async () => {
    const devnet = readFileSync(`${REPO}deployments/solana-devnet.json`, 'utf8');
    const asked: string[] = [];
    const reading = (text: string | null) =>
      seam({
        dir: '/records',
        read: (file) => {
          asked.push(file);
          return text;
        },
      });
    const local = { ...SOLANA, CHAIN_NETWORK_SOLANA: 'local' };
    await expect(sourcesFromEnv(local, reading(null).options)).rejects.toThrow(
      'there is no deploy record deployments/solana-local.json for CHAIN_NETWORK_SOLANA',
    );
    expect(asked).toEqual(['/records/solana-local.json']);
    await expect(sourcesFromEnv(SOLANA, reading('{"network":1}').options)).rejects.toThrow(
      'deployments/solana-devnet.json is not a Solana deployment record this worker reads',
    );
    await expect(sourcesFromEnv(SOLANA, reading('not json').options)).rejects.toThrow(
      'is not a Solana deployment record',
    );
    // A devnet record under the local name is not run as a local validator.
    await expect(sourcesFromEnv(local, reading(devnet).options)).rejects.toThrow(
      'deployments/solana-local.json is the record of solana-devnet',
    );
    const s = reading(devnet);
    await expect(sourcesFromEnv(SOLANA, s.options)).resolves.toHaveLength(1);
    expect(s.connected).toEqual([SOLANA_URL]);
  });

  it('lets the environment repeat the record’s addresses and never replace one', async () => {
    const record = JSON.parse(readFileSync(`${REPO}deployments/solana-devnet.json`, 'utf8'));
    const same = {
      ...SOLANA,
      CHAIN_ROUTER_SOLANA: record.programs.mockRouter,
      CHAIN_PRICE_SOURCE_SOLANA: record.accounts.priceAccount,
    };
    await expect(sourcesFromEnv(same, seam().options)).resolves.toHaveLength(1);
    const s = seam();
    await expect(
      sourcesFromEnv({ ...same, CHAIN_PRICE_SOURCE_SOLANA: record.accounts.config }, s.options),
    ).rejects.toThrow(
      'CHAIN_PRICE_SOURCE_SOLANA names another address than deployments/solana-devnet.json',
    );
    await expect(
      sourcesFromEnv({ ...same, CHAIN_ROUTER_SOLANA: record.accounts.config }, s.options),
    ).rejects.toThrow('CHAIN_ROUTER_SOLANA names another address than');
    expect(s.checked).toEqual([]);
  });

  it('gives no height, and no failed pass, when the node cannot say its slot', async () => {
    const without = seam({ connectSolana: () => ({}) as unknown as VaultNodeRpc });
    const [none] = await sourcesFromEnv(SOLANA, without.options);
    expect(await none?.height()).toBeNull();
    const failing = seam({
      connectSolana: () =>
        ({
          getSlot: () => ({
            send: async () => {
              throw new Error(`fetch failed on ${SOLANA_URL}`);
            },
          }),
        }) as unknown as VaultNodeRpc,
    });
    const [failed] = await sourcesFromEnv(SOLANA, failing.options);
    expect(await failed?.height()).toBeNull();
    // A node that never answers: the pass goes on without a height after ten seconds.
    vi.useFakeTimers();
    const hung = seam({
      connectSolana: () =>
        ({ getSlot: () => ({ send: () => new Promise(() => {}) }) }) as unknown as VaultNodeRpc,
    });
    const [silent] = await sourcesFromEnv(SOLANA, hung.options);
    const height = silent?.height();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await height).toBeNull();
  });

  it('reads the pause, the loss budget and the band from the program’s Config', () => {
    expect(rulesOfConfig({ keeperPaused: true, lossCapBps: 100, bandBps: 50 })).toEqual({
      paused: true,
      lossCapBps: 100,
      bandBps: 50,
    });
  });
});

describe('Robinhood Chain on its test network', () => {
  it('is the EVM reader on the record of the test network, labelled sandbox', async () => {
    const s = seam();
    const [source] = await sourcesFromEnv(ROBINHOOD, s.options);
    if (!source) throw new Error('no source');
    expect(source.chain).toBe('robinhood');
    expect(source.name).toBe('Robinhood Chain testnet');
    expect(source.provenance).toBe('sandbox');
    expect(source.source).toBe(
      'Robinhood Chain testnet, read over JSON-RPC by the EVM vault reader',
    );
    expect(Object.keys(source).sort()).toEqual([...LABELS, ...READS].sort());
    expect(s.connected).toEqual([ROBINHOOD_URL]);
    expect(s.checked).toEqual(['robinhood-testnet']);
    const assets = await source.listAssets();
    expect(assets.filter((a) => a.cls === 'cash').map((a) => a.id)).toEqual(['robinhood:tusdg']);
    expect(assets.every((a) => a.provenance === 'sandbox')).toBe(true);
    expect(await source.height()).toBe(99n);
  });

  it('asks the node itself when no check is handed in, and refuses one that answers a mainnet’s chain id', async () => {
    // The worker's default check, as for Solana: no check is handed in.
    const s = seam({
      checkEvm: undefined,
      connectEvm: () =>
        ({
          // Robinhood Chain's own id; its test network is 46630.
          getChainId: async () => 4663,
          getCode: async () => '0x60',
          getBlockNumber: async () => 1n,
        }) as unknown as EvmRpc,
    });
    await expect(sourcesFromEnv(ROBINHOOD, s.options)).rejects.toThrow("a mainnet's");
    expect(s.checked).toEqual([]);
  });

  it('gives no height when the node cannot say its block', async () => {
    const s = seam({
      connectEvm: () =>
        ({
          getBlockNumber: async () => {
            throw new Error(`HTTP request failed.\n\nURL: ${ROBINHOOD_URL}`);
          },
        }) as unknown as EvmRpc,
    });
    const [source] = await sourcesFromEnv(ROBINHOOD, s.options);
    expect(await source?.height()).toBeNull();
  });

  it('refuses a missing record, a missing node and a router that is not the record’s', async () => {
    const s = seam();
    await expect(
      sourcesFromEnv({ ...ROBINHOOD, CHAIN_NETWORK_ROBINHOOD: 'local' }, s.options),
    ).rejects.toThrow(
      'there is no deploy record deployments/robinhood-local.json for CHAIN_NETWORK_ROBINHOOD',
    );
    await expect(sourcesFromEnv({ CHAIN_MODE_ROBINHOOD: 'live' }, s.options)).rejects.toThrow(
      'CHAIN_MODE_ROBINHOOD is live, and ROBINHOOD_RPC_URL is not set',
    );
    const record = JSON.parse(readFileSync(`${REPO}deployments/robinhood-testnet.json`, 'utf8'));
    const router: string = record.routers[0].address;
    await expect(
      sourcesFromEnv({ ...ROBINHOOD, CHAIN_ROUTER_ROBINHOOD: record.contracts.factory }, s.options),
    ).rejects.toThrow(
      'CHAIN_ROUTER_ROBINHOOD names another address than deployments/robinhood-testnet.json',
    );
    expect(s.checked).toEqual([]);
    // The same router in another case is the same address.
    await expect(
      sourcesFromEnv(
        { ...ROBINHOOD, CHAIN_ROUTER_ROBINHOOD: router.toUpperCase().replace('0X', '0x') },
        s.options,
      ),
    ).resolves.toHaveLength(1);
  });

  it('reads the pause, the loss budget and the band from the factory', () => {
    expect(
      rulesOfPlatform({ keeperPaused: false, params: { lossCapBps: 200, bandBps: 75 } }),
    ).toEqual({ paused: false, lossCapBps: 200, bandBps: 75 });
  });
});

describe('Robinhood Chain on mainnet', () => {
  it('is read beside Solana on devnet, as the hosted API is set: live from the mainnet record, sandbox from devnet', async () => {
    const s = seam();
    const sources = await sourcesFromEnv({ ...SOLANA, ...MAINNET }, s.options);
    expect(sources.map((x) => [x.chain, x.name, x.provenance])).toEqual([
      ['solana', 'Solana devnet', 'sandbox'],
      ['robinhood', 'Robinhood Chain mainnet', 'live'],
    ]);
    expect(s.checked).toEqual(['solana-devnet', 'robinhood-mainnet']);
    const robinhood = sources[1];
    if (!robinhood) throw new Error('no source');
    expect(robinhood.source).toBe(
      'Robinhood Chain mainnet, read over JSON-RPC by the EVM vault reader',
    );
    // The reads and the labels, and nothing else: no builder, no probe, no signer on the source.
    expect(Object.keys(robinhood).sort()).toEqual([...LABELS, ...READS].sort());
    const assets = await robinhood.listAssets();
    expect(assets.filter((a) => a.cls === 'cash').map((a) => a.id)).toEqual(['robinhood:usdg']);
    expect(assets.every((a) => a.provenance === 'live')).toBe(true);
  });

  it('needs the second switch in its exact words, and says so before a node is asked', async () => {
    for (const value of [undefined, '', '1', 'true', 'mainnet', 'Real-Money ']) {
      const s = seam();
      await expect(
        sourcesFromEnv({ ...SOLANA, ...MAINNET, CHAIN_MAINNET_ROBINHOOD: value }, s.options),
        String(value),
      ).rejects.toThrow(
        'CHAIN_NETWORK_ROBINHOOD is mainnet: set CHAIN_MAINNET_ROBINHOOD to real-money for the snapshot worker to read it',
      );
      expect(s.connected).toEqual([]);
      expect(s.checked).toEqual([]);
    }
  });

  it('is read whatever the mode says, and is not read when the chain is on the mock or off', async () => {
    for (const mode of ['live', 'readonly']) {
      const [source] = await sourcesFromEnv(
        { ...MAINNET, CHAIN_MODE_ROBINHOOD: mode },
        seam().options,
      );
      expect(source?.provenance, mode).toBe('live');
    }
    // On the mock the rows are sample rows, whatever the network says.
    const [mock] = await sourcesFromEnv(
      { ...MAINNET, CHAIN_MODE_ROBINHOOD: 'mock', SNAPSHOT_CHAINS: 'robinhood' },
      seam().options,
    );
    expect(mock?.provenance).toBe('mock');
    await expect(
      sourcesFromEnv({ ...MAINNET, CHAIN_MODE_ROBINHOOD: 'off' }, seam().options),
    ).rejects.toThrow(NO_CHAIN);
  });

  it('holds the node to the mainnet record: a test network node under the mainnet setting does not start', async () => {
    // The worker's default check, with no check handed in.
    const node = (chainId: number) =>
      seam({
        checkEvm: undefined,
        connectEvm: () =>
          ({
            getChainId: async () => chainId,
            getCode: async () => '0x60',
            getBlockNumber: async () => 1n,
          }) as unknown as EvmRpc,
      });
    await expect(sourcesFromEnv(MAINNET, node(46630).options)).rejects.toThrow(
      'the EVM RPC answers chain id 46630, and the record robinhood-mainnet is for 4663',
    );
    await expect(sourcesFromEnv(MAINNET, node(4663).options)).resolves.toHaveLength(1);
  });

  it('never under a test network record: a record that is not a mainnet’s is not labelled live', async () => {
    const testnet = readFileSync(`${REPO}deployments/robinhood-testnet.json`, 'utf8');
    const s = seam({ dir: '/records', read: () => testnet });
    await expect(sourcesFromEnv(MAINNET, s.options)).rejects.toThrow(
      'deployments/robinhood-mainnet.json is the record of robinhood-testnet',
    );
    expect(s.connected).toEqual([]);
  });

  it('asks the node in small batches, a few at a time, through a client that only reads', () => {
    // robinhood.drpc.org refuses a batch of more than three; a public node answers a burst with 403.
    expect(EVM_NODE).toEqual({ readOnly: true, batchSize: 3, maxInFlight: 2 });
  });

  it('asks a mainnet node for nothing but reads, three a batch and two batches at a time', async () => {
    // The worker's own client (EVM_NODE) on a stand-in for the node's HTTP side, so every request the
    // mainnet path makes is seen as it would go out: the node check, the height, the rules, an owner's
    // vaults, a vault by its address and the prices. The stand-in answers every call with words of
    // zero, which is no vault and no price; what is asked is what is held here.
    const batches: { method: string }[][] = [];
    let inFlight = 0;
    let most = 0;
    const answer = (call: { id: number; method: string }) => {
      const result =
        call.method === 'eth_chainId'
          ? '0x1237'
          : call.method === 'eth_blockNumber'
            ? '0x52d9d3b'
            : call.method === 'eth_getCode'
              ? '0x60'
              : call.method === 'eth_getBlockByNumber'
                ? { number: '0x52d9d3b', timestamp: '0x68ed0000', transactions: [] }
                : `0x${'0'.repeat(64 * 64)}`;
      return { jsonrpc: '2.0', id: call.id, result };
    };
    const fetchFn = (async (_input: unknown, init?: { body?: unknown }) => {
      inFlight++;
      most = Math.max(most, inFlight);
      const body = JSON.parse(String(init?.body));
      const calls = Array.isArray(body) ? body : [body];
      batches.push(calls);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight--;
      const answers = calls.map(answer);
      return new Response(JSON.stringify(Array.isArray(body) ? answers : answers[0]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const s = seam({
      checkEvm: undefined,
      connectEvm: (url) => createEvmRpc(url, { ...EVM_NODE, fetchFn }),
    });
    const [source] = await sourcesFromEnv(MAINNET, s.options);
    if (!source) throw new Error('no source');
    const owner = '0x00000000000000000000000000000000000000a1';
    const vault = '0x00000000000000000000000000000000000000b2';
    const assets = await source.listAssets();
    const tried = await Promise.allSettled([
      source.height(),
      source.rules(),
      source.getVaults(owner),
      source.getVault(vault),
      source.getPrices(assets.filter((a) => a.cls !== 'cash').map((a) => a.id)),
    ]);
    expect(tried[0]).toEqual({ status: 'fulfilled', value: 0x52d9d3bn });
    const methods = new Set(batches.flat().map((call) => call.method));
    expect([...methods].filter((method) => !READ_METHODS.has(method))).toEqual([]);
    expect(methods.has('eth_call')).toBe(true);
    expect(batches.flat().length).toBeGreaterThan(10);
    expect(Math.max(...batches.map((b) => b.length))).toBeLessThanOrEqual(3);
    expect(most).toBeLessThanOrEqual(2);
  });
});

describe('a node that does not answer at start', () => {
  const down = () => new ChainError('Unavailable', 'the EVM RPC did not answer eth_chainId');

  it('does not keep the other chain from starting: its own reads wait for the check, and nothing is read before it', async () => {
    let answers = false;
    let asked = 0;
    const warned: string[] = [];
    const s = seam({
      checkEvm: async () => {
        asked++;
        if (!answers) throw down();
      },
      warn: (line) => warned.push(line),
    });
    const sources = await sourcesFromEnv({ ...SOLANA, ...MAINNET }, s.options);
    expect(sources.map((x) => x.chain)).toEqual(['solana', 'robinhood']);
    expect(s.checked).toEqual(['solana-devnet']);
    expect(warned).toEqual([
      'Robinhood Chain mainnet did not say which network it is at start (Unavailable: the EVM RPC did not answer eth_chainId): each pass asks again, and nothing is read from it until it has',
    ]);
    expect(warned.join()).not.toContain('RhKey456');
    const [solana, robinhood] = sources;
    if (!solana || !robinhood) throw new Error('no source');
    // Solana is read as ever.
    expect(await solana.height()).toBe(1234n);
    // Robinhood Chain's pass fails as a chain that does not answer, and its height is none.
    await expect(robinhood.rules()).rejects.toThrow('the EVM RPC did not answer eth_chainId');
    await expect(robinhood.getVaults('0x00000000000000000000000000000000000000a1')).rejects.toThrow(
      ChainError,
    );
    await expect(robinhood.getVault('0x00000000000000000000000000000000000000a1')).rejects.toThrow(
      ChainError,
    );
    await expect(robinhood.getPrices(['robinhood:nvda'])).rejects.toThrow(ChainError);
    expect(await robinhood.height()).toBeNull();
    const before = asked;
    expect(before).toBeGreaterThan(1);
    // Once the node says it is the record's network, the reads go through and it is not asked again.
    answers = true;
    expect(await robinhood.height()).toBe(99n);
    expect(await robinhood.height()).toBe(99n);
    expect(asked).toBe(before + 1);
  });

  it('still stops the worker on a node of another network, at start and later', async () => {
    const wrong = new ChainError(
      'NotSupported',
      "the EVM RPC answers chain id 46630, a test network's",
    );
    const atStart = seam({
      checkEvm: async () => {
        throw wrong;
      },
    });
    await expect(sourcesFromEnv({ ...SOLANA, ...MAINNET }, atStart.options)).rejects.toThrow(
      'answers chain id 46630',
    );
    // A node that was down at start and turns out to be another network's: no read ever goes through.
    let state: 'down' | 'wrong' = 'down';
    const later = seam({
      checkEvm: async () => {
        throw state === 'down' ? down() : wrong;
      },
    });
    const [source] = await sourcesFromEnv(MAINNET, later.options);
    state = 'wrong';
    await expect(source?.rules()).rejects.toThrow('answers chain id 46630');
    await expect(source?.getVaults('0x00000000000000000000000000000000000000a1')).rejects.toThrow(
      'answers chain id 46630',
    );
    expect(await source?.height()).toBeNull();
  });

  it('is the same for Solana', async () => {
    let answers = false;
    const s = seam({
      checkSolana: async () => {
        if (!answers) throw new ChainError('Unavailable', 'the Solana RPC did not say its network');
      },
    });
    const [source] = await sourcesFromEnv(SOLANA, s.options);
    await expect(source?.rules()).rejects.toThrow('the Solana RPC did not say its network');
    expect(await source?.height()).toBeNull();
    answers = true;
    expect(await source?.height()).toBe(1234n);
  });
});
