import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createEvmRpc, safeBatchFile } from '@colosseum/chain-evm/vault';

// After a person has run the Robinhood Chain redeploy (gate ROBINHOOD-REDEPLOY): the Safe's one batch
// that takes the keys the deploy proposed to it, and where the hand-over stands. Read-only: it writes a
// file and asks a node; it sends nothing, holds no key and proposes nothing to the Safe's service.
//
//   pnpm ops:redeploy --safe-file <dir>           writes the Transaction Builder file of the Safe's batch:
//                                                 factory.acceptAdmin() and beacon.acceptOwnership()
//   pnpm ops:redeploy --status --rpc-env NAME     says who holds the factory's admin and the beacon, and
//                                                 who is proposed for each
//   pnpm ops:redeploy --proposed                  the deploy file's tokens whose values are still Proposed,
//                                                 one row each, for a person to confirm before a send
//   pnpm ops:redeploy --confirm <who> --on <date> after that person confirmed them in chat: each Proposed
//                                                 note becomes "Confirmed by <who>, <date>", nothing else
//
// `--broadcast` names forge's record of the deploy (default contracts/broadcast/Deploy.s.sol/4663/
// run-latest.json); `--config` the deploy file (default contracts/script/config/4663.json), which
// names the Safe. `--rpc-env` names the environment variable that holds the node's URL, never printed.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHAIN_ID = 4663;
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
};
type Hex = `0x${string}`;
/** The two calls of the Safe's batch, by selector: neither takes an argument. */
const ACCEPT_ADMIN: Hex = '0x0e18b681'; // acceptAdmin()
const ACCEPT_OWNERSHIP: Hex = '0x79ba5097'; // acceptOwnership()
const view = (name: string) =>
  ({
    type: 'function',
    name,
    inputs: [],
    outputs: [{ type: 'address', name: '' }],
    stateMutability: 'view',
  }) as const;
const ABI = [view('admin'), view('pendingAdmin'), view('owner'), view('pendingOwner')] as const;
const address = (s: string): string => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) fail(`${s} is not an address`);
  return s.toLowerCase();
};

type Broadcast = {
  chain: number;
  transactions: {
    transactionType: string;
    contractName: string | null;
    contractAddress: string | null;
    arguments?: string[] | null;
  }[];
};

const fail = (message: string): never => {
  throw new Error(message);
};

/** The factory proxy and the beacon the deploy created, from forge's record of it. */
export function deployedOf(broadcast: Broadcast): { factory: string; beacon: string } {
  if (broadcast.chain !== CHAIN_ID)
    fail(`the broadcast is of chain ${broadcast.chain}, not ${CHAIN_ID}`);
  const created = (name: string) =>
    broadcast.transactions.filter((t) => t.transactionType === 'CREATE' && t.contractName === name);
  const [factoryLogic, ...more] = created('VaultFactory');
  const [beacon, ...beacons] = created('VaultBeacon');
  if (!factoryLogic?.contractAddress || more.length)
    fail('the deploy did not create one factory logic');
  if (!beacon?.contractAddress || beacons.length) fail('the deploy did not create one beacon');
  const proxies = created('ERC1967Proxy').filter(
    (t) => t.arguments?.[0]?.toLowerCase() === factoryLogic?.contractAddress?.toLowerCase(),
  );
  if (proxies.length !== 1 || !proxies[0]?.contractAddress)
    fail('the deploy did not create one factory proxy');
  return {
    factory: address(proxies[0]?.contractAddress as string),
    beacon: address(beacon?.contractAddress as string),
  };
}

type Json = Record<string, unknown>;
const NOTE = /Note$/;
const isProposed = (v: unknown) => typeof v === 'string' && v.startsWith('Proposed');

/**
 * The deploy file's tokens with a value still Proposed (a note that begins with the word): what each
 * would be listed with. `Deploy.s.sol` refuses a send of such a file; a dry run shows it.
 */
export function proposedRows(config: { assets: Json[] }): string[][] {
  const pct = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
  const hidden = (a: Json) =>
    (a.v3Pool ? 'not shown: v3 route' : '') ||
    (typeof a.heldBack === 'string' || a.heldBack === true ? 'not shown: held back' : '') ||
    'shown';
  return config.assets
    .filter((a) => Object.entries(a).some(([k, v]) => NOTE.test(k) && isProposed(v)))
    .map((a) => {
      const pool = a.v3Pool as Json | null | undefined;
      const v4 = a.pool as Json | null | undefined;
      const average = a.average as Json | undefined;
      return [
        String(a.symbol),
        pct(Number(a.maxWeightBps)),
        `$${Number(a.maxTradeUsd).toLocaleString('en-US')}`,
        `${a.feed} (${a.feedDescription})`,
        pool
          ? `v3 ${pool.pool} fee ${pool.fee}`
          : v4
            ? `v4 fee ${v4.fee} spacing ${v4.tickSpacing}`
            : 'none',
        average ? `${average.pool}${average.usable ? '' : ' (not usable)'}` : 'none',
        hidden(a),
      ];
    });
}

/** The same file with every Proposed note confirmed by `who` on `on`: the note's words after the date kept. */
export function confirmed<T extends Json>(config: T, who: string, on: string): T {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(on)) fail(`${on} is not a date (yyyy-mm-dd)`);
  if (!who.trim()) fail('name the person who confirmed');
  const walk = (v: unknown, key = ''): unknown =>
    Array.isArray(v)
      ? v.map((x) => walk(x))
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v as Json).map(([k, x]) => [k, walk(x, k)]))
        : NOTE.test(key) && isProposed(v)
          ? (v as string).replace(
              /^Proposed( \d{4}-\d{2}-\d{2})?/,
              (_, was) => `Confirmed by ${who}, ${on}${was ? `, as proposed${was}` : ''}`,
            )
          : v;
  return walk(config) as T;
}

/** The Transaction Builder file of the Safe's batch: the two accepts, in one transaction of the Safe. */
export function acceptanceFile(input: {
  safe: string;
  factory: string;
  beacon: string;
  createdAt: number;
}) {
  const calls: { to: string; data: Hex }[] = [
    { to: input.factory, data: ACCEPT_ADMIN },
    { to: input.beacon, data: ACCEPT_OWNERSHIP },
  ];
  return safeBatchFile({
    chainId: CHAIN_ID,
    safe: input.safe,
    calls,
    createdAt: input.createdAt,
    name: 'Tenonfi redeploy: the Safe takes the keys',
    description: `factory ${input.factory}: acceptAdmin(); beacon ${input.beacon}: acceptOwnership(). Signed once, the Safe is the admin and the beacon's owner, at once, with no timelock (gate ROBINHOOD-REDEPLOY).`,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const value = (name: string, fallback?: string) => {
    const at = args.indexOf(name);
    return at === -1 ? fallback : args[at + 1];
  };
  try {
    const configPath = value('--config', DEFAULTS.config) as string;
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    if (args.includes('--proposed')) {
      const rows = proposedRows(config);
      if (!rows.length) console.log('every value of the deploy file is confirmed');
      else {
        const head = ['token', 'ceiling', 'largest trade', 'feed', 'pool', 'average pool', 'app'];
        const table = [head, ...rows];
        const width = head.map((_, i) => Math.max(...table.map((r) => (r[i] ?? '').length)));
        for (const r of table) console.log(r.map((c, i) => c.padEnd(width[i] ?? 0)).join('  '));
        console.log(
          `\n${rows.length} tokens with Proposed values: a send is refused until a person confirms them (--confirm).`,
        );
      }
      process.exit(0);
    }
    const who = value('--confirm');
    if (who !== undefined) {
      const on = value('--on') ?? fail('--confirm needs --on <yyyy-mm-dd>');
      const before = proposedRows(config).length;
      writeFileSync(configPath, `${JSON.stringify(confirmed(config, who, on), null, 2)}\n`);
      console.log(`confirmed the values of ${before} tokens in ${configPath}, by ${who} on ${on}`);
      process.exit(0);
    }
    const broadcast = JSON.parse(
      readFileSync(value('--broadcast', DEFAULTS.broadcast) as string, 'utf8'),
    );
    const safe: string = config.safe?.address ?? fail('the deploy file names no safe');
    const { factory, beacon } = deployedOf(broadcast);
    const dir = value('--safe-file');
    if (dir) {
      mkdirSync(dir, { recursive: true });
      const file = acceptanceFile({ safe, factory, beacon, createdAt: Date.now() });
      const path = join(dir, 'ROBINHOOD-REDEPLOY.safe-accept.json');
      writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
      console.log(`wrote ${path}`);
      for (const t of file.transactions) console.log(`  ${t.to}  ${t.data}`);
    }
    if (args.includes('--status')) {
      const env = value('--rpc-env') ?? fail('--status needs --rpc-env NAME');
      const url = process.env[env] ?? fail(`${env} is not set`);
      const rpc = createEvmRpc(url);
      const read = (
        address: string,
        functionName: 'admin' | 'pendingAdmin' | 'owner' | 'pendingOwner',
      ) => rpc.readContract({ address: address as Hex, abi: ABI, functionName }) as Promise<string>;
      const [admin, pendingAdmin, owner, pendingOwner] = await Promise.all([
        read(factory, 'admin'),
        read(factory, 'pendingAdmin'),
        read(beacon, 'owner'),
        read(beacon, 'pendingOwner'),
      ]);
      const zero = /^0x0{40}$/i;
      // Held: the Safe has both, and nobody else is proposed for either.
      const held =
        admin.toLowerCase() === safe.toLowerCase() &&
        owner.toLowerCase() === safe.toLowerCase() &&
        zero.test(pendingAdmin) &&
        zero.test(pendingOwner);
      console.log(`factory ${factory}: admin ${admin}, proposed ${pendingAdmin}`);
      console.log(`beacon  ${beacon}: owner ${owner}, proposed ${pendingOwner}`);
      console.log(
        held
          ? `state: the Safe ${safe} holds both`
          : `state: not yet: the Safe ${safe} has to sign its batch, and nothing else may stay proposed`,
      );
    }
  } catch (e) {
    console.error(`refused: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
