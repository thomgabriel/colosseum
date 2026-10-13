import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertNode as assertEvmNode,
  createEvmRpc,
  createEvmVaultReader,
  EvmDeploymentRecord,
  type EvmRpc,
  deploymentAddresses as evmAddresses,
  deploymentAssets as evmAssets,
  type PlatformState,
} from '@colosseum/chain-evm/vault';
import { createMockAdapter } from '@colosseum/chain-mock';
import {
  assertNode as assertSolanaNode,
  type ConfigAccount,
  createSolanaVaultReader,
  createVaultRpc,
  deploymentAddresses,
  deploymentAssets,
  SolanaDeploymentRecord,
  type VaultNodeRpc,
} from '@colosseum/chain-solana/vault';
import {
  type ChainConfig,
  ChainError,
  ChainId,
  type ChainMode,
  chainProvenance,
  type EnvLike,
  envKey,
  type Flags,
  MAINNET_SWITCH,
  MAINNET_SWITCH_VALUE,
  mainnetAllowed,
  type Network,
  parseChainConfigs,
  parseFlags,
  readEnv,
} from '@colosseum/schemas';
import type { GetSlotApi, Rpc } from '@solana/kit';
import { createMockWorld } from './mock-world';
import type { ChainRules, ChainSource } from './source';

// One ChainSource per chain the worker reads, from the environment, or an error before any node is
// asked anything. A real chain is its READER (packages/chain-solana/src/vault/reader.ts,
// packages/chain-evm/src/vault/reader.ts) on a test network or a local copy, from the record its deploy
// committed; Robinhood Chain alone is also read on its mainnet (gate SNAPSHOT-WORKER as amended on
// Oct 13), from its mainnet record and under the switch the API needs, labelled `live`. A chain on the
// mock is packages/chain-mock with the sample world of mock-world.ts. Nothing here makes an adapter of a
// real chain, a builder, a probe or a signer, and nothing loads a key:
// tests/snapshot/reads-only.test.ts holds the folder to that, and the EVM node's client passes on
// nothing but reads (`EVM_NODE`).

/**
 * Names under the prefixes the flags own (CHAIN_, AUTO_FOLLOW_, KEEPER_) that the keeper and its run
 * script read and the flags do not know (apps/keeper/src/main.ts and alerts.ts, scripts/keeper/run.sh).
 * The API reads none beyond the flags' own. Listed so that an environment shared with the keeper does
 * not stop the worker as a typo would. The worker reads the value of none of them.
 */
export const ALSO_KNOWN: readonly string[] = [
  'KEEPER_CHAIN',
  'KEEPER_STATE_DIR',
  'KEEPER_SOLANA_KEYPAIR',
  'KEEPER_ROBINHOOD_KEY',
  'KEEPER_LOW_GAS',
  'KEEPER_DISCORD_WEBHOOK',
  'KEEPER_HEALTHCHECK_URL',
  'KEEPER_INTERVAL',
  'KEEPER_POOL_FEEDS',
];

/** Where a real chain's node comes from. A URL can carry a key: it is read as written, never printed. */
const RPC_URL = { solana: 'SOLANA_RPC_URL', robinhood: 'ROBINHOOD_RPC_URL' } as const;

/**
 * How the worker asks an EVM node, whatever the network: nothing but reads passed on (`readOnly`),
 * three requests a batch and two batches in flight. A free node refuses a larger batch and a public
 * one answers a burst with 403; a paid node takes the same small batches. The lanes of a pass
 * (pass.ts, READS_AT_ONCE) share the one client, so this bounds the whole chain's reads.
 *
 * `timeoutMs` is two minutes, not the client's 30 s: viem's timer starts before the request waits its
 * turn in `maxInFlight`'s queue, so a batch's time in the queue counts against it. Four lanes reading
 * a vault each (about 14 batches a vault) can stand some 28 turns deep; at 3 s a turn on a slow node
 * that is 84 s of waiting before the last batch is even sent. Two minutes covers that, and a node that
 * does not answer at all still fails the pass within a few minutes, with viem's two retries.
 */
export const EVM_NODE = {
  readOnly: true,
  batchSize: 3,
  maxInFlight: 2,
  timeoutMs: 120_000,
} as const;

const DEPLOYMENTS = fileURLToPath(new URL('../../../deployments/', import.meta.url));

/** How long a chain may take to say its height before the pass goes on without it. */
const HEIGHT_TIMEOUT_MS = 10_000;

export type SourceOptions = {
  /** A deploy record's text, or null when there is no such file. Default: the file system. */
  read?: (file: string) => string | null;
  /** Where the deploy records are. Default: deployments/ at the repo root. */
  dir?: string;
  /** The clock a mock chain starts on. Default: the wall clock. */
  now?: () => Date;
  /** Makes the client of a node from its URL. A test hands in its own, and no connection is opened. */
  connectSolana?: (url: string) => VaultNodeRpc;
  connectEvm?: (url: string) => EvmRpc;
  /** Asks the node which network it is and holds it to the record. Default: each package's `assertNode`. */
  checkSolana?: (rpc: VaultNodeRpc, record: SolanaDeploymentRecord) => Promise<void>;
  checkEvm?: (rpc: EvmRpc, record: EvmDeploymentRecord) => Promise<void>;
  /** Where the mock's sample world says what it could not make. Default: stderr. */
  warn?: (line: string) => void;
};

/**
 * Why the worker stops on a mainnet setting of a chain it reads on a test network only (Solana, Base).
 * The variable is named; nothing else of the environment is.
 */
export function mainnetRefusal(key: string): string {
  return `${key} is mainnet, and the snapshot worker reads the test networks only until a person says otherwise: set it to testnet or local`;
}

/** The one chain the worker reads on its mainnet (gate SNAPSHOT-WORKER, amended Oct 13). */
export const MAINNET_CHAIN = 'robinhood';

/** Why the worker stops on Robinhood Chain's mainnet without the second switch. */
export const SWITCH_REFUSAL = `${envKey('CHAIN_NETWORK', MAINNET_CHAIN)} is mainnet: set ${MAINNET_SWITCH} to ${MAINNET_SWITCH_VALUE} for the snapshot worker to read it, as the API needs it to run there`;

/** Said when the environment names no chain to read: both ways to name one. */
export const NO_CHAIN =
  'no chain to read: set CHAIN_MODE_<CHAIN> to readonly for a chain on its test network, or name the chains in SNAPSHOT_CHAINS (a chain on the mock is read only when it is named there)';

/**
 * The label on every row read from a chain the worker reads on a test network only, which is always
 * `sandbox`. A network whose figures would carry another label is refused. `live` is Robinhood Chain's
 * mainnet alone (`labelOfEvm`).
 */
export function sandboxOnly(chain: ChainId, network: Network): 'sandbox' {
  const provenance = chainProvenance(network, 'readonly');
  if (provenance !== 'sandbox')
    throw new Error(
      `${envKey('CHAIN_NETWORK', chain)} is ${network}, whose figures would be labelled ${provenance}: the snapshot worker stores test-network figures only`,
    );
  return provenance;
}

/**
 * The label on every row read from Robinhood Chain: `live` on its mainnet, which needs the switch, and
 * `sandbox` on its test network or a local copy. A mainnet reading is never stored as a test
 * network's, nor the other way: the record and the node are held to the same network below.
 */
export function labelOfEvm(
  chain: typeof MAINNET_CHAIN,
  network: Network,
  env: EnvLike,
): 'live' | 'sandbox' {
  if (network !== 'mainnet') return sandboxOnly(chain, network);
  if (!mainnetAllowed(env)) throw new Error(SWITCH_REFUSAL);
  return 'live';
}

/** The chain's settings as the Solana program's Config account holds them. */
export function rulesOfConfig(
  config: Pick<ConfigAccount, 'keeperPaused' | 'lossCapBps' | 'bandBps'>,
): ChainRules {
  return { paused: config.keeperPaused, lossCapBps: config.lossCapBps, bandBps: config.bandBps };
}

/** The chain's settings as the EVM factory holds them. */
export function rulesOfPlatform(platform: {
  keeperPaused: PlatformState['keeperPaused'];
  params: Pick<PlatformState['params'], 'lossCapBps' | 'bandBps'>;
}): ChainRules {
  return {
    paused: platform.keeperPaused,
    lossCapBps: platform.params.lossCapBps,
    bandBps: platform.params.bandBps,
  };
}

/**
 * The sources of the chains this environment names, in the order of `ChainId`. Everything that can be
 * wrong with the environment or a record is said before any node is asked: only then is each node asked
 * which network it is.
 */
export async function sourcesFromEnv(
  env: EnvLike,
  options: SourceOptions = {},
): Promise<ChainSource[]> {
  // First, and for every chain whatever its mode: a chain set to mainnet stops the worker, read or not.
  // Robinhood Chain is the exception, and only with the second switch in its exact words.
  for (const chain of ChainId.options) {
    const key = envKey('CHAIN_NETWORK', chain);
    if (readEnv(env, key) !== 'mainnet') continue;
    if (chain !== MAINNET_CHAIN) throw new Error(mainnetRefusal(key));
    if (!mainnetAllowed(env)) throw new Error(SWITCH_REFUSAL);
  }
  // The flags, read once (DESIGN-VAULT section 2, rule 6). A name it does not know is refused as a typo.
  const flags = parseFlags(env, ALSO_KNOWN);
  const configs = parseChainConfigs(env);
  const pending = chosen(env, flags).map((chain) => {
    const mode = flags.chainMode[chain];
    if (mode === 'mock') return async () => mockSource(chain, configs[chain], options);
    if (chain === 'solana') return solana(env, mode, configs.solana.network, options);
    if (chain === 'robinhood') return evm(chain, env, mode, configs[chain].network, options);
    throw new Error(
      `${envKey('CHAIN_MODE', chain)} is ${mode}, and the snapshot worker has no reader for ${configs[chain].name} on a real network yet: set it to mock or off`,
    );
  });
  const sources: ChainSource[] = [];
  for (const connect of pending) sources.push(await connect());
  return sources;
}

/**
 * Which chains are read. SNAPSHOT_CHAINS names them, a comma list of chain ids. Unset, it is every chain
 * whose mode is `live` or `readonly`: a chain on the mock is read only when named, so that nothing fills
 * the tables with sample rows by omission.
 */
function chosen(env: EnvLike, flags: Flags): ChainId[] {
  const named = readEnv(env, 'SNAPSHOT_CHAINS');
  if (named === undefined) {
    const real = ChainId.options.filter((chain) => {
      const mode = flags.chainMode[chain];
      return mode === 'live' || mode === 'readonly';
    });
    if (real.length === 0) throw new Error(NO_CHAIN);
    return real;
  }
  const ids = named
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
  // The value is not repeated: a secret pasted into the wrong variable must not reach a log.
  if (ids.some((id) => !ChainId.safeParse(id).success))
    throw new Error(
      `SNAPSHOT_CHAINS: expected chain ids separated by commas, from ${ChainId.options.join(', ')}`,
    );
  if (ids.length === 0) throw new Error(NO_CHAIN);
  for (const chain of ChainId.options) {
    if (ids.includes(chain) && flags.chainMode[chain] === 'off')
      throw new Error(
        `SNAPSHOT_CHAINS names ${chain}, and ${envKey('CHAIN_MODE', chain)} is off: set it to readonly, or to mock for the sample world`,
      );
  }
  return ChainId.options.filter((chain) => ids.includes(chain));
}

/**
 * "Solana devnet", "Robinhood Chain testnet", "Robinhood Chain mainnet": some networks' own names
 * already say the chain, and a mainnet's own name is the chain's, which would not say which network.
 */
function nameOf(config: ChainConfig): string {
  if (config.network === 'mainnet') return `${config.name} mainnet`;
  return config.networkName.startsWith(config.name)
    ? config.networkName
    : `${config.name} ${config.networkName}`;
}

/** A height labels a row; the pass does not stand on it. A chain that cannot say it in time gives null. */
function heightOrNull(read: () => Promise<bigint | number>): Promise<bigint | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), HEIGHT_TIMEOUT_MS);
  });
  // Never rejects, so a read that fails after the wait is over is not an unhandled error.
  const answer = Promise.resolve()
    .then(read)
    .then(
      (height) => BigInt(height),
      () => null,
    );
  return Promise.race([answer, late]).finally(() => clearTimeout(timer));
}

/**
 * The node check of one chain, made at start and, where the node did not answer then, before each read
 * until it has. A node that does not answer (`Unavailable`: a timeout, a rate limit, a 403) says nothing
 * of which network it is, so it must not stop the other chains from being read: the worker starts, says
 * so once, and this chain's passes fail and back off alone (loop.ts) until the node answers. A node
 * that answers another network stops the worker at start, and fails every read after it. Nothing is
 * read from a node before it has said it is the record's network.
 */
async function nodeCheck(
  name: string,
  check: () => Promise<void>,
  options: SourceOptions,
): Promise<() => Promise<void>> {
  let passed = false;
  let asking: Promise<void> | null = null;
  const ready = () => {
    if (passed) return Promise.resolve();
    asking ??= check()
      .then(() => {
        passed = true;
      })
      .finally(() => {
        asking = null;
      });
    return asking;
  };
  try {
    await ready();
  } catch (e) {
    if (!(e instanceof ChainError && e.code === 'Unavailable')) throw e;
    // A ChainError's message never carries the node's address, and main.ts hides one all the same.
    (options.warn ?? ((line: string) => console.error(line)))(
      `${name} did not say which network it is at start (${e.code}: ${e.message}): each pass asks again, and nothing is read from it until it has`,
    );
  }
  return ready;
}

/** `read`, once the node has said which network it is. */
const after =
  <A extends unknown[], R>(ready: () => Promise<void>, read: (...args: A) => Promise<R>) =>
  async (...args: A): Promise<R> => {
    await ready();
    return read(...args);
  };

/**
 * The record a deploy committed for a network (`deployments/<name>.json`), parsed and held to its own
 * name. The record is what was deployed: the environment may repeat its addresses and never replace one.
 */
function recordOf<T extends { network: string }>(
  name: string,
  what: string,
  parse: (raw: unknown) => T,
  networkKey: string,
  options: SourceOptions,
): T {
  const read =
    options.read ?? ((file: string) => (existsSync(file) ? readFileSync(file, 'utf8') : null));
  const text = read(join(options.dir ?? DEPLOYMENTS, `${name}.json`));
  if (text === null)
    throw new Error(`there is no deploy record deployments/${name}.json for ${networkKey}`);
  let record: T;
  try {
    record = parse(JSON.parse(text));
  } catch {
    throw new Error(`deployments/${name}.json is not ${what} deployment record this worker reads`);
  }
  if (record.network !== name)
    throw new Error(`deployments/${name}.json is the record of ${record.network}`);
  return record;
}

/** The environment may say an address the record says, in any case on EVM; another one stops the worker. */
function agree(env: EnvLike, key: string, deployed: string, name: string, anyCase: boolean): void {
  const given = anyCase ? env[key]?.trim().toLowerCase() : env[key]?.trim();
  if (given && given !== deployed)
    throw new Error(
      `${key} names another address than deployments/${name}.json: the record is what was deployed`,
    );
}

/** The node's URL as written, or an error that names its variable. */
function nodeUrl(env: EnvLike, chain: keyof typeof RPC_URL, mode: ChainMode): string {
  const url = env[RPC_URL[chain]]?.trim();
  if (!url)
    throw new Error(`${envKey('CHAIN_MODE', chain)} is ${mode}, and ${RPC_URL[chain]} is not set`);
  return url;
}

/**
 * Solana on its test network (devnet) or a local validator. `live` means what `readonly` means here: the
 * worker only ever reads. Everything but the node check happens now; the answer is what asks the node.
 */
function solana(
  env: EnvLike,
  mode: ChainMode,
  network: Network,
  options: SourceOptions,
): () => Promise<ChainSource> {
  const provenance = sandboxOnly('solana', network);
  const name = network === 'local' ? 'solana-local' : 'solana-devnet';
  const record = recordOf(
    name,
    'a Solana',
    (raw) => SolanaDeploymentRecord.parse(raw),
    envKey('CHAIN_NETWORK', 'solana'),
    options,
  );
  const url = nodeUrl(env, 'solana', mode);
  const { program, router, priceAccount } = deploymentAddresses(record);
  agree(env, envKey('CHAIN_ROUTER', 'solana'), router, name, false);
  agree(env, envKey('CHAIN_PRICE_SOURCE', 'solana'), priceAccount, name, false);
  const config = parseChainConfigs(
    {
      [envKey('CHAIN_NETWORK', 'solana')]: network,
      [envKey('CHAIN_ROUTER', 'solana')]: router,
      [envKey('CHAIN_PRICE_SOURCE', 'solana')]: priceAccount,
    },
    { solana: { program } },
  ).solana;
  // Making the client opens no connection, and the reader checks its config and its assets as it is made.
  const rpc = (options.connectSolana ?? createVaultRpc)(url);
  const reader = createSolanaVaultReader({
    config,
    rpc,
    assets: deploymentAssets(record),
    trade: 'readonly',
  });
  // The client answers getSlot though its type does not list it: the vault's reads never needed a slot.
  const slots = rpc as unknown as Rpc<GetSlotApi>;
  return async () => {
    // The node says which network it is: a test label on a mainnet node does not start.
    const ready = await nodeCheck(
      nameOf(config),
      () => (options.checkSolana ?? assertSolanaNode)(rpc, record),
      options,
    );
    return {
      chain: 'solana',
      name: nameOf(config),
      provenance,
      source: `${nameOf(config)}, read over RPC by the vault reader`,
      listAssets: () => reader.listAssets(),
      getPrices: after(ready, async (assets) => reader.getPrices(assets)),
      getVault: after(ready, async (vault) => reader.getVault(vault)),
      getVaults: after(ready, async (owner) => reader.getVaults(owner)),
      rules: after(ready, async () => rulesOfConfig(await reader.getConfig())),
      // The reader's own commitment, so the slot is of the view of the chain the vaults are then read
      // on. One node answers in order; a node behind a balancer can answer a later read a slot behind.
      height: () =>
        heightOrNull(after(ready, async () => slots.getSlot({ commitment: 'confirmed' }).send())),
    };
  };
}

/**
 * Robinhood Chain on its test network (46630) or a local copy, the same way, and on its mainnet (4663)
 * from `deployments/robinhood-mainnet.json`. The label follows the network, the record has to be that
 * network's own, and the node has to answer the record's chain id (`assertNode`): a mainnet node under
 * a test setting does not start, and neither does a test node under the mainnet one.
 */
function evm(
  chain: 'robinhood',
  env: EnvLike,
  mode: ChainMode,
  network: Network,
  options: SourceOptions,
): () => Promise<ChainSource> {
  const provenance = labelOfEvm(chain, network, env);
  const name = `${chain}-${network}`;
  const record = recordOf(
    name,
    'an EVM',
    (raw) => EvmDeploymentRecord.parse(raw),
    envKey('CHAIN_NETWORK', chain),
    options,
  );
  if (record.chain !== chain)
    throw new Error(`deployments/${name}.json is the record of ${record.chain}`);
  // The record says whose figures it holds, and it is the label the rows get.
  if (record.provenance !== provenance)
    throw new Error(
      `deployments/${name}.json says its figures are ${record.provenance}, and ${envKey('CHAIN_NETWORK', chain)} makes them ${provenance}`,
    );
  const url = nodeUrl(env, chain, mode);
  const { factory, registry, router } = evmAddresses(record);
  if (router) agree(env, envKey('CHAIN_ROUTER', chain), router, name, true);
  const config = parseChainConfigs(
    {
      [envKey('CHAIN_NETWORK', chain)]: network,
      ...(router ? { [envKey('CHAIN_ROUTER', chain)]: router } : {}),
    },
    { [chain]: { factory, registry } },
  )[chain];
  const rpc = (options.connectEvm ?? ((node: string) => createEvmRpc(node, EVM_NODE)))(url);
  const reader = createEvmVaultReader({
    config,
    rpc,
    assets: evmAssets(record),
    trade: 'readonly',
  });
  return async () => {
    const ready = await nodeCheck(
      nameOf(config),
      () => (options.checkEvm ?? assertEvmNode)(rpc, record),
      options,
    );
    return {
      chain,
      name: nameOf(config),
      provenance,
      source: `${nameOf(config)}, read over JSON-RPC by the EVM vault reader`,
      listAssets: () => reader.listAssets(),
      getPrices: after(ready, async (assets) => reader.getPrices(assets)),
      getVault: after(ready, async (vault) => reader.getVault(vault)),
      getVaults: after(ready, async (owner) => reader.getVaults(owner)),
      rules: after(ready, async () => rulesOfPlatform(await reader.getPlatform())),
      height: () => heightOrNull(after(ready, async () => rpc.getBlockNumber())),
    };
  };
}

/**
 * A chain in memory, with the sample world on it. Each process has its own, so this is not the chain the
 * API's mock holds: `prepare` makes, on this one, the vaults the database names. Only the adapter's reads
 * are put on the source; what builds and lands a transaction stays inside mock-world.ts.
 */
function mockSource(chain: ChainId, config: ChainConfig, options: SourceOptions): ChainSource {
  const adapter = createMockAdapter({
    chain,
    now: (options.now ?? (() => new Date()))().toISOString(),
  });
  const world = createMockWorld(adapter, {
    warn: options.warn ?? ((line: string) => console.error(line)),
  });
  return {
    chain,
    name: `${config.name} (mock)`,
    provenance: 'mock',
    source: 'chain-mock',
    listAssets: () => adapter.listAssets(),
    getPrices: (assets) => adapter.getPrices(assets),
    getVault: (vault) => adapter.getVault(vault),
    getVaults: (owner) => adapter.getVaults(owner),
    // The mock has a band and nothing else: no pause, no loss budget.
    rules: async () => ({ paused: null, lossCapBps: null, bandBps: adapter.mock.bandBps }),
    // The mock mints a block a second, so its height is its clock.
    height: async () => BigInt(adapter.mock.now()),
    // The world answers the address of its sample vault when the database names none: the pass reads it.
    prepare: (known, now) => world.prepare(known, now),
  };
}
