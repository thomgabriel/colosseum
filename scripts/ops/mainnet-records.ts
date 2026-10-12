import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EvmDeploymentRecord } from '@colosseum/chain-evm/vault';
import { readDeploymentFile } from '@colosseum/sdk';
import { parseRecord } from './authority';

// After a person has deployed the vault contracts on Robinhood Chain mainnet: writes the two files the
// app runs on from what the deploy itself left behind, so that nobody copies an address by hand.
//
//   pnpm ops:mainnet-records            fills both files, validates them, regenerates the guard's tables
//   pnpm ops:mainnet-records --check    the same without writing: prints what it would write
//
// It reads forge's own record of the transactions it sent
// (contracts/broadcast/Deploy.s.sol/4663/run-latest.json), the deploy file they were made from
// (contracts/script/config/4663.json) and the guard's file as committed (for each token's id and pool).
// It sends nothing, holds no key and asks no node. The last step, the authority check, does read the
// chain: it is printed as a command for whoever has the node's address.
//
// It refuses rather than guess: a deploy file that still holds a value nobody confirmed, a broadcast of
// another chain, a contract the deploy did not create exactly once, a token the guard's file does not
// list or lists with another address, decimals or pool.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ZERO = `0x${'0'.repeat(40)}`;
const CHAIN_ID = 4663;

type Json = Record<string, unknown>;
type Broadcast = {
  chain: number;
  transactions: {
    transactionType: string;
    contractName: string | null;
    contractAddress: string | null;
    hash?: string | null;
  }[];
  receipts: { blockNumber: string; status?: string }[];
};

/** What the tool knows of a token beyond what the deploy file says: how a person reads it. */
const KINDS: Record<string, { name: string; kind: 'stock' | 'etf' | 'gold' | 'dollar_yield' }> = {
  NVDA: { name: 'NVIDIA', kind: 'stock' },
  AAPL: { name: 'Apple', kind: 'stock' },
  MSFT: { name: 'Microsoft', kind: 'stock' },
  GOOGL: { name: 'Alphabet Class A', kind: 'stock' },
  AMZN: { name: 'Amazon', kind: 'stock' },
  META: { name: 'Meta Platforms', kind: 'stock' },
  TSLA: { name: 'Tesla', kind: 'stock' },
  SPY: { name: 'SPDR S&P 500 ETF Trust', kind: 'etf' },
  QQQ: { name: 'Invesco QQQ', kind: 'etf' },
  GLD: { name: 'SPDR Gold Trust', kind: 'gold' },
  SGOV: { name: 'iShares 0-3 Month Treasury Bond', kind: 'dollar_yield' },
};

const lower = (address: string) => address.toLowerCase();
const fail = (message: string): never => {
  throw new Error(message);
};

/** The one contract of that name the deploy created, in order of creation when there are several. */
function created(broadcast: Broadcast, name: string): string[] {
  return broadcast.transactions
    .filter((t) => t.transactionType === 'CREATE' && t.contractName === name)
    .map((t) => lower(t.contractAddress ?? fail(`a ${name} was created with no address recorded`)));
}

export type Built = {
  record: Json;
  guard: Json;
  /** What a person should look at: a name or a kind the tool had to assume. */
  notes: string[];
};

/**
 * Pure: the deploy record and the guard's file, from the three inputs as text. Throws with what is
 * wrong; never fills a gap with a guess.
 */
export function buildRecords(input: { broadcast: string; config: string; guard: string }): Built {
  if (/TODO/.test(input.config))
    fail('the deploy file still holds a TODO: a deploy from it would have been refused');
  const broadcast = JSON.parse(input.broadcast) as Broadcast;
  const config = JSON.parse(input.config) as Json & {
    chainId: number;
    timelock: { owner: string; delay: number };
    guardian: string;
    keeper: string;
    keeperEnabled?: boolean;
    sequencerFeed: string;
    publishDelay: number;
    cashToken: string;
    routers: { router: string; pull: number }[];
    assets: (Json & {
      token: string;
      feed: string;
      tokenDecimals: number;
      feedDecimals: number;
      maxAge: number;
      session: number;
      maxWeightBps: number;
      flags: number;
      averageFeed: string;
      minPrice: number | string;
      maxPrice: number | string;
      pool?: { fee: number; tickSpacing: number };
      maxTradeUsd?: number | null;
      average?: { pool: string; minLiquidity: string; usable: boolean } | null;
    })[];
  };
  const guard = JSON.parse(input.guard) as Json & {
    chains: {
      robinhood: Json & {
        evmChainId: number;
        cash: string;
        assets: Record<
          string,
          { address: string; decimals: number; pool?: { fee: number; tickSpacing: number } }
        >;
      };
    };
  };
  if (broadcast.chain !== CHAIN_ID || config.chainId !== CHAIN_ID)
    fail(
      `the broadcast is of chain ${broadcast.chain} and the deploy file of ${config.chainId}: both must be ${CHAIN_ID}`,
    );
  if (guard.chains.robinhood.evmChainId !== CHAIN_ID)
    fail(`the guard's file is for chain ${guard.chains.robinhood.evmChainId}`);
  const failed = broadcast.receipts.filter(
    (r) => r.status !== undefined && BigInt(r.status) !== 1n,
  );
  if (failed.length) fail(`${failed.length} of the deploy's transactions did not succeed`);
  if (broadcast.receipts.length !== broadcast.transactions.length || !broadcast.receipts.length)
    fail('the broadcast does not hold a receipt for every transaction: the deploy did not finish');

  const one = (name: string): string => {
    const made = created(broadcast, name);
    return made.length === 1
      ? (made[0] as string)
      : fail(`the deploy created ${made.length} ${name}, not one`);
  };
  // The factory's proxy is created before the registry's: the registry is initialised with the factory.
  const proxies = created(broadcast, 'ERC1967Proxy');
  if (proxies.length !== 2) fail(`the deploy created ${proxies.length} proxies, not two`);
  const contracts = {
    factory: proxies[0] as string,
    registry: proxies[1] as string,
    beacon: one('VaultBeacon'),
    vaultLogic: one('BasketVault'),
    factoryLogic: one('VaultFactory'),
    registryLogic: one('IndexRegistry'),
  };
  const timelock = one('TimelockController');
  const deployBlock = Number(
    broadcast.receipts.map((r) => BigInt(r.blockNumber)).reduce((a, b) => (a < b ? a : b)),
  );

  const safe = lower(config.timelock.owner);
  const byAddress = new Map(
    Object.entries(guard.chains.robinhood.assets).map(([id, a]) => [
      lower(a.address),
      { id, ...a },
    ]),
  );
  const notes: string[] = [];
  const cashRow = byAddress.get(lower(config.cashToken));
  if (!cashRow || cashRow.id !== guard.chains.robinhood.cash)
    fail("the guard's file does not name the deploy file's cash token as its cash");
  const cashConfig = config.assets.find((a) => lower(a.token) === lower(config.cashToken));
  if (!cashConfig) fail('the deploy file does not list its cash token among its assets');

  const assets = config.assets
    .filter((a) => lower(a.token) !== lower(config.cashToken))
    .map((a) => {
      const row =
        byAddress.get(lower(a.token)) ?? fail(`the guard's file lists no token at ${a.token}`);
      const symbol = row.id.replace(/^robinhood:/, '').toUpperCase();
      if (row.decimals !== a.tokenDecimals)
        fail(
          `${symbol}: the guard's file says ${row.decimals} decimals and the deploy file ${a.tokenDecimals}`,
        );
      if (!a.pool) fail(`${symbol}: the deploy file states no pool`);
      if (!row.pool || row.pool.fee !== a.pool?.fee || row.pool.tickSpacing !== a.pool?.tickSpacing)
        fail(`${symbol}: the guard's file and the deploy file name different pools`);
      const known = KINDS[symbol];
      if (!known)
        notes.push(
          `${symbol}: no name or kind is known to this tool; written as a stock named ${symbol}`,
        );
      const ranged = BigInt(a.minPrice) !== 0n || BigInt(a.maxPrice) !== 0n;
      return {
        id: row.id,
        symbol,
        name: known?.name ?? symbol,
        address: lower(a.token),
        decimals: a.tokenDecimals,
        modelOf: symbol,
        kind: known?.kind ?? 'stock',
        feed: lower(a.feed),
        feedDecimals: a.feedDecimals,
        averageFeed: lower(a.averageFeed),
        maxAge: a.maxAge,
        session: a.session,
        maxWeightBps: a.maxWeightBps,
        keeperOn: (a.flags & 1) === 1,
        range: ranged ? { minPrice: String(a.minPrice), maxPrice: String(a.maxPrice) } : null,
        pool: { fee: a.pool?.fee, tickSpacing: a.pool?.tickSpacing },
        maxTradeUsd: a.maxTradeUsd ?? null,
        average: a.average
          ? {
              pool: lower(a.average.pool),
              minLiquidity: String(a.average.minLiquidity),
              usable: a.average.usable,
            }
          : null,
      };
    });
  const listed = new Set([lower(config.cashToken), ...assets.map((a) => a.address)]);
  const extra = [...byAddress.keys()].filter((address) => !listed.has(address));
  if (extra.length) fail(`the guard's file lists a token the deploy did not: ${extra.join(', ')}`);

  const record: Json = {
    network: 'robinhood-mainnet',
    chain: 'robinhood',
    provenance: 'live',
    evmChainId: CHAIN_ID,
    deployBlock,
    contracts,
    roles: {
      admin: timelock,
      guardian: lower(config.guardian),
      keeper: lower(config.keeper),
      priceWriter: null,
      tokenIssuer: null,
    },
    sequencerFeed: lower(config.sequencerFeed) === ZERO ? null : lower(config.sequencerFeed),
    priceBoundBps: config.priceBoundBps ?? null,
    staleRailBps: config.staleRailBps ?? null,
    sessionPriceAge: config.sessionPriceAge ?? null,
    maxTradeUsdNotLive: config.maxTradeUsdNotLive ?? null,
    staleRailMaxAge: config.staleRailMaxAge ?? null,
    routers: config.routers.map((r) => ({ address: lower(r.router), pull: r.pull })),
    cash: {
      id: cashRow?.id,
      symbol: 'USDG',
      name: 'Global Dollar',
      address: lower(config.cashToken),
      decimals: cashConfig?.tokenDecimals,
    },
    assets,
    retired: [],
    timelock: {
      address: timelock,
      minDelay: config.timelock.delay,
      proposers: [safe],
      cancellers: [safe],
      executors: [safe],
    },
    expected: {
      launched: false,
      publishDelay: config.publishDelay,
      keeperEnabled: config.keeperEnabled === true,
    },
  };

  const { placeholder: _placeholder, todo: _todo, ...kept } = guard;
  const filled: Json = {
    ...kept,
    chains: {
      ...guard.chains,
      robinhood: {
        ...guard.chains.robinhood,
        factory: contracts.factory,
        beacon: contracts.beacon,
        registry: contracts.registry,
      },
    },
  };
  return { record, guard: filled, notes };
}

/** Holds what was built to the three readers that will read it. Throws with the first that refuses. */
export function validate(built: Built): void {
  EvmDeploymentRecord.parse(built.record);
  parseRecord(JSON.stringify(built.record));
  const read = readDeploymentFile(built.guard);
  if (read.robinhood?.family !== 'evm') fail("the guard's file has no Robinhood Chain entry");
}

const DEFAULTS = {
  broadcast: join(
    ROOT,
    'contracts',
    'broadcast',
    'Deploy.s.sol',
    String(CHAIN_ID),
    'run-latest.json',
  ),
  config: join(ROOT, 'contracts', 'script', 'config', `${CHAIN_ID}.json`),
  guard: join(ROOT, 'packages', 'sdk', 'deployments', 'mainnet.json'),
  record: join(ROOT, 'deployments', 'robinhood-mainnet.json'),
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const value = (name: string, fallback: string) => {
    const at = args.indexOf(name);
    return at === -1 ? fallback : (args[at + 1] ?? fallback);
  };
  const paths = {
    broadcast: value('--broadcast', DEFAULTS.broadcast),
    config: value('--config', DEFAULTS.config),
    guard: value('--guard', DEFAULTS.guard),
    record: value('--record', DEFAULTS.record),
  };
  try {
    if (!existsSync(paths.broadcast))
      fail(`there is no broadcast at ${paths.broadcast}: nothing was deployed from this checkout`);
    const built = buildRecords({
      broadcast: readFileSync(paths.broadcast, 'utf8'),
      config: readFileSync(paths.config, 'utf8'),
      guard: readFileSync(paths.guard, 'utf8'),
    });
    validate(built);
    for (const note of built.notes) console.log(`LOOK\t${note}`);
    if (args.includes('--check')) {
      console.log(JSON.stringify(built.record, null, 2));
      console.log('checked: nothing written');
    } else {
      writeFileSync(paths.record, `${JSON.stringify(built.record, null, 2)}\n`);
      writeFileSync(paths.guard, `${JSON.stringify(built.guard, null, 2)}\n`);
      console.log(`wrote ${paths.record}`);
      console.log(`wrote ${paths.guard}`);
      execFileSync('pnpm', ['--filter', '@colosseum/sdk', 'tables'], {
        cwd: ROOT,
        stdio: 'inherit',
      });
      execFileSync('pnpm', ['biome', 'format', '--write', paths.record, paths.guard], {
        cwd: ROOT,
        stdio: 'inherit',
      });
      console.log('next, read-only, with the node in ROBINHOOD_RPC_URL:');
      console.log(
        '  pnpm ops:authority-check --record deployments/robinhood-mainnet.json --rpc-env ROBINHOOD_RPC_URL',
      );
    }
  } catch (e) {
    console.error(`refused: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
