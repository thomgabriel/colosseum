import { ChainError, normalizeAddress } from '@colosseum/schemas';
import {
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  type Hex,
  keccak256,
  parseAbi,
  toBytes,
} from 'viem';
import { z } from 'zod';
import { VAULT_FACTORY_ABI } from './generated/abi';
import type { EvmRpc } from './rpc';

// More tokens for a deployed mainnet factory. One file names the tokens; from it come the calls the Safe
// sends, as files the Safe app's Transaction Builder imports, and the entries the deploy record keeps under
// `pending` until the chain lists them. Where the file names a timelock (the factory of 2026-10-12), the
// Safe sends one `scheduleBatch` and, after the delay, one `executeBatch` (`contracts/script/AddAssets.s.sol`
// is the same batch in Solidity); where it names none (the redeploy's, gate ROBINHOOD-REDEPLOY, whose admin
// is the Safe itself), the Safe sends the `setAsset` calls to the factory itself, as one batch it signs once.
// Nothing here sends, signs or holds a key.

const Address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'expected a 0x address')
  .transform((v) => v.toLowerCase() as Hex);
const Selector = z.string().regex(/^0x[0-9a-fA-F]{8}$/);
const Raw = z.string().regex(/^\d+$/);
const ZERO = `0x${'0'.repeat(40)}` as Hex;

/** One token the file adds: the deploy file's entry (`contracts/script/config/4663.json`), and how a person reads it. */
const AddedAsset = z
  .looseObject({
    symbol: z.string().regex(/^[A-Za-z0-9.]+$/),
    name: z.string().min(1),
    kind: z.enum(['stock', 'etf', 'gold', 'commodity', 'dollar_yield', 'crypto']),
    token: Address,
    feed: Address,
    feedDescription: z.string().min(1),
    tokenDecimals: z.number().int().min(0).max(18),
    feedDecimals: z.number().int().min(0).max(18),
    maxAge: z.number().int().positive(),
    session: z.union([z.literal(0), z.literal(1)]),
    source: z.literal(1),
    maxWeightBps: z.number().int().min(0).max(5_000),
    pauseProbe: Address,
    pauseSelector: Selector,
    scheduleSelector: Selector,
    // The keeper is off on this mainnet: no switch, no average feed, no range.
    flags: z.literal(0),
    averageFeed: Address.refine((a) => a === ZERO, 'no average feed while the keeper is off'),
    minPrice: z.literal(0),
    maxPrice: z.literal(0),
    /** The hookless Uniswap v4 pool against the cash its trades go through: the route the app builds today. */
    pool: z
      .strictObject({
        fee: z.number().int().min(0).max(1_000_000),
        tickSpacing: z.number().int().min(1).max(32_767),
      })
      .optional(),
    /**
     * Instead, the Uniswap v3 pool against the cash its trades will go through, for a token whose v4 pools
     * do not fill $1,000: listed on chain now, traded once the app builds a v3 route. One of the two.
     */
    v3Pool: z
      .strictObject({ pool: Address, fee: z.number().int().min(1).max(1_000_000) })
      .optional(),
    maxTradeUsd: z.number().int().min(1_000),
    average: z
      .strictObject({
        pool: Address,
        fee: z.number().int(),
        minLiquidity: Raw,
        usable: z.boolean(),
      })
      .nullable(),
  })
  .refine((a) => (a.pool === undefined) !== (a.v3Pool === undefined), {
    message: 'a token states one route: a v4 `pool` or a `v3Pool`',
  });

export const AddAssetsFile = z
  .looseObject({
    chainId: z.number().int().positive(),
    factory: Address,
    /** The factory's admin when it is a timelock; absent where the Safe is the admin itself. */
    timelock: Address.optional(),
    safe: Address,
    cashToken: Address,
    /** Hashed (keccak256 of its UTF-8 bytes) into the batch's salt, so the operation's id is the file's. */
    salt: z.string().min(1),
    /** The timelock's delay, which `AddAssets.s.sol` holds to `getMinDelay()`. With a timelock only. */
    delay: z.number().int().min(172_800).optional(),
    priceBoundBps: z.number().int().min(1).max(1_000),
    /** When the figures in the notes were read: each block and its time. */
    measured: z
      .array(z.strictObject({ block: z.number().int().positive(), at: z.string().datetime() }))
      .min(1),
    assets: z.array(AddedAsset).min(1),
    /** Calls after the listings, in the same batch: the registry's upgrade. Each to its own target. */
    calls: z
      .array(
        z.looseObject({
          target: Address,
          data: z.string().regex(/^0x([0-9a-fA-F]{2})*$/),
        }),
      )
      .optional(),
    /** A contract one of the calls needs, deployed first by Arachnid's CREATE2 deployer (`AddAssets.s.sol`). */
    create2: z
      .looseObject({
        address: Address,
        salt: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
        artifact: z.string(),
      })
      .optional(),
  })
  .refine((f) => (f.timelock === undefined) === (f.delay === undefined), {
    message: 'a timelock and its delay, or neither: the Safe is then the admin itself',
  })
  .refine((f) => f.timelock !== undefined || (f.calls === undefined && f.create2 === undefined), {
    message: 'with no timelock the file lists tokens only',
  });
export type AddAssetsFile = z.infer<typeof AddAssetsFile>;

export const TIMELOCK_BATCH_ABI = parseAbi([
  'function scheduleBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt, uint256 delay)',
  'function executeBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt)',
  'function isOperationDone(bytes32 id) view returns (bool)',
]);
const PREDECESSOR = `0x${'0'.repeat(64)}` as Hex;

/** The `AssetConfig` the factory stores for a token of the file, in the struct's field order. */
export function assetConfigOf(a: AddAssetsFile['assets'][number]) {
  return {
    feed: a.feed,
    tokenDecimals: a.tokenDecimals,
    feedDecimals: a.feedDecimals,
    maxAge: a.maxAge,
    session: a.session,
    source: a.source,
    maxWeightBps: a.maxWeightBps,
    pauseProbe: a.pauseProbe,
    pauseSelector: a.pauseSelector as Hex,
    scheduleSelector: a.scheduleSelector as Hex,
    haltUntil: 0n,
    flags: a.flags,
    averageFeed: a.averageFeed,
    minPrice: 0n,
    maxPrice: 0n,
  };
}

export type AssetBatch = {
  targets: Hex[];
  values: bigint[];
  payloads: Hex[];
  salt: Hex;
  /** `hashOperationBatch` of the timelock: what `isOperationDone` is asked about. */
  operationId: Hex;
  /**
   * The call data of the Safe's two transactions, both to the timelock, and keccak256 of each, for a
   * person to compare with what the Safe app shows. Null where the file names no timelock: the Safe
   * then sends `payloads` to `targets` itself (`safeCalls`).
   */
  schedule: Hex | null;
  execute: Hex | null;
  scheduleHash: Hex | null;
  executeHash: Hex | null;
};

/**
 * One `setAsset` on the factory per token, in the file's order, then the file's calls, as one timelock
 * operation. `operationId` is `hashOperationBatch` of those calls: with no timelock it names the batch
 * only, for the record's `pending` entries.
 */
export function assetBatch(file: AddAssetsFile): AssetBatch {
  const calls = file.calls ?? [];
  const targets = [...file.assets.map(() => file.factory), ...calls.map((c) => c.target)];
  const values = targets.map(() => 0n);
  const payloads = [
    ...file.assets.map((a) =>
      encodeFunctionData({
        abi: VAULT_FACTORY_ABI,
        functionName: 'setAsset',
        args: [a.token, assetConfigOf(a)],
      }),
    ),
    ...calls.map((c) => c.data.toLowerCase() as Hex),
  ];
  const salt = keccak256(toBytes(file.salt));
  const operationId = keccak256(
    encodeAbiParameters(
      [
        { type: 'address[]' },
        { type: 'uint256[]' },
        { type: 'bytes[]' },
        { type: 'bytes32' },
        { type: 'bytes32' },
      ],
      [targets, values, payloads, PREDECESSOR, salt],
    ),
  );
  if (file.timelock === undefined || file.delay === undefined)
    return {
      targets,
      values,
      payloads,
      salt,
      operationId,
      schedule: null,
      execute: null,
      scheduleHash: null,
      executeHash: null,
    };
  const schedule = encodeFunctionData({
    abi: TIMELOCK_BATCH_ABI,
    functionName: 'scheduleBatch',
    args: [targets, values, payloads, PREDECESSOR, salt, BigInt(file.delay)],
  });
  const execute = encodeFunctionData({
    abi: TIMELOCK_BATCH_ABI,
    functionName: 'executeBatch',
    args: [targets, values, payloads, PREDECESSOR, salt],
  });
  return {
    targets,
    values,
    payloads,
    salt,
    operationId,
    schedule,
    execute,
    scheduleHash: keccak256(schedule),
    executeHash: keccak256(execute),
  };
}

/** Where the Safe is the factory's admin itself: the calls it sends, one `setAsset` per token, in order. */
export function safeCalls(file: AddAssetsFile): { to: Hex; data: Hex }[] {
  if (file.timelock !== undefined)
    throw new ChainError(
      'NotSupported',
      'the file names a timelock: the Safe schedules through it',
    );
  const { targets, payloads } = assetBatch(file);
  return targets.map((to, i) => ({ to, data: payloads[i] as Hex }));
}

// ---- the Safe app's Transaction Builder

/**
 * The Transaction Builder's own checksum: keccak256 of the batch serialised with its keys sorted, the
 * batch's name blanked and its checksum left out. A file whose checksum does not match is shown with a
 * warning that it was changed after it was saved.
 */
export function safeChecksum(batch: SafeBatchFile): Hex {
  const { checksum: _, ...meta } = batch.meta;
  return keccak256(toBytes(serialize({ ...batch, meta: { ...meta, name: null } })));
}

function serialize(json: unknown): string {
  if (Array.isArray(json)) return `[${json.map(serialize).join(',')}]`;
  if (typeof json === 'object' && json !== null) {
    const keys = Object.keys(json).sort();
    let out = `{${JSON.stringify(keys)}`;
    for (const key of keys) out += `${serialize((json as Record<string, unknown>)[key] ?? null)},`;
    return `${out}}`;
  }
  return JSON.stringify(json ?? null);
}

export type SafeBatchFile = {
  version: '1.0';
  chainId: string;
  createdAt: number;
  meta: {
    name: string;
    description: string;
    txBuilderVersion: string;
    createdFromSafeAddress: string;
    createdFromOwnerAddress: string;
    checksum?: Hex;
  };
  transactions: {
    to: string;
    value: string;
    data: Hex;
    contractMethod: null;
    contractInputsValues: null;
  }[];
};

/**
 * A file the Transaction Builder imports, with its checksum: one call from the Safe (`to`, `data`), or
 * several the Safe signs as one batch (`calls`). Addresses as the Safe app writes them, checksummed.
 */
export function safeBatchFile(
  input: {
    chainId: number;
    safe: string;
    name: string;
    description: string;
    createdAt: number;
  } & ({ to: string; data: Hex } | { calls: readonly { to: string; data: Hex }[] }),
): SafeBatchFile {
  const calls = 'calls' in input ? input.calls : [{ to: input.to, data: input.data }];
  const batch: SafeBatchFile = {
    version: '1.0',
    chainId: String(input.chainId),
    createdAt: input.createdAt,
    meta: {
      name: input.name,
      description: input.description,
      txBuilderVersion: '1.18.0',
      createdFromSafeAddress: getAddress(input.safe),
      createdFromOwnerAddress: '',
    },
    transactions: calls.map((c) => ({
      to: getAddress(c.to),
      value: '0',
      data: c.data,
      contractMethod: null,
      contractInputsValues: null,
    })),
  };
  return { ...batch, meta: { ...batch.meta, checksum: safeChecksum(batch) } };
}

// ---- the deploy record

/** The entry the deploy record keeps for a token of the file: under `pending` until the chain lists it. */
export function recordEntryOf(a: AddAssetsFile['assets'][number], operationId: Hex) {
  return {
    id: `robinhood:${a.symbol.toLowerCase()}`,
    symbol: a.symbol,
    name: a.name,
    address: a.token,
    decimals: a.tokenDecimals,
    modelOf: a.symbol,
    kind: a.kind,
    feed: a.feed,
    feedDecimals: a.feedDecimals,
    averageFeed: a.averageFeed,
    maxAge: a.maxAge,
    session: a.session,
    maxWeightBps: a.maxWeightBps,
    keeperOn: false,
    range: null,
    // A token routed through v3 has no v4 pool: it stays pending until the app builds that route.
    pool: a.pool ?? null,
    ...(a.v3Pool ? { v3Pool: a.v3Pool } : {}),
    maxTradeUsd: a.maxTradeUsd,
    average: a.average
      ? { pool: a.average.pool, minLiquidity: a.average.minLiquidity, usable: a.average.usable }
      : null,
    operation: operationId,
  };
}

/** What the chain answers for the file's batch and each of its tokens: read by the caller, compared here. */
export type ListedOnChain = {
  /** The timelock's `isOperationDone`; true where there is no timelock (each token's listing then speaks for itself). */
  operationDone: boolean;
  /** `factory.asset(token)` as raw return data, by token address; `isAsset` false is `null`. */
  configs: Record<string, Hex | null>;
};

/**
 * Which tokens of the file the chain lists with exactly the file's settings. A token listed with other
 * settings is an error: someone listed it another way, and nothing is promoted until a person looks.
 */
export function listedAsFiled(file: AddAssetsFile, onChain: ListedOnChain): Hex[] {
  if (!onChain.operationDone) return [];
  const listed: Hex[] = [];
  for (const a of file.assets) {
    const raw = onChain.configs[a.token];
    if (raw === null || raw === undefined) continue;
    const got = decodeFunctionResult({ abi: VAULT_FACTORY_ABI, functionName: 'asset', data: raw });
    const want = assetConfigOf(a);
    const same =
      normalizeAddress('evm', got.feed) === want.feed &&
      got.tokenDecimals === want.tokenDecimals &&
      got.feedDecimals === want.feedDecimals &&
      got.maxAge === want.maxAge &&
      got.session === want.session &&
      got.source === want.source &&
      got.maxWeightBps === want.maxWeightBps &&
      normalizeAddress('evm', got.pauseProbe) === want.pauseProbe &&
      got.pauseSelector.toLowerCase() === want.pauseSelector.toLowerCase() &&
      got.scheduleSelector.toLowerCase() === want.scheduleSelector.toLowerCase() &&
      got.flags === want.flags &&
      normalizeAddress('evm', got.averageFeed) === want.averageFeed &&
      got.minPrice === 0n &&
      got.maxPrice === 0n;
    if (!same)
      throw new ChainError(
        'NotSupported',
        `${a.symbol} is listed with other settings than the file's: a person compares them before it is shown`,
      );
    listed.push(a.token);
  }
  return listed;
}

/** Reads, one call at a time, whether the file's batch has run and what the factory lists for each token. */
export async function readListed(rpc: EvmRpc, file: AddAssetsFile): Promise<ListedOnChain> {
  if ((await rpc.getChainId()) !== file.chainId)
    throw new ChainError('NotSupported', `the node is not chain ${file.chainId}`);
  const operationDone =
    file.timelock === undefined ||
    (await rpc.readContract({
      address: file.timelock,
      abi: TIMELOCK_BATCH_ABI,
      functionName: 'isOperationDone',
      args: [assetBatch(file).operationId],
    }));
  const configs: Record<string, Hex | null> = {};
  for (const a of file.assets) {
    const listed = await rpc.readContract({
      address: file.factory,
      abi: VAULT_FACTORY_ABI,
      functionName: 'isAsset',
      args: [a.token],
    });
    if (!listed) {
      configs[a.token] = null;
      continue;
    }
    const { data } = await rpc.call({
      to: file.factory,
      data: encodeFunctionData({ abi: VAULT_FACTORY_ABI, functionName: 'asset', args: [a.token] }),
    });
    configs[a.token] = data ?? null;
  }
  return { operationDone, configs };
}
