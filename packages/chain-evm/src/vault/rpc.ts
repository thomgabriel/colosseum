import { ChainError } from '@colosseum/schemas';
import {
  AbiDecodingZeroDataError,
  BaseError,
  CallExecutionError,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  createPublicClient,
  ExecutionRevertedError,
  http,
  type PublicClient,
  RawContractError,
  type Transport,
} from 'viem';

// The node the reader asks, made by the caller from its own RPC URL. No URL is ever part of a message:
// it can carry a key.

/** What the reader needs of a node: viem's public client, over any transport. */
export type EvmRpc = PublicClient;

/**
 * The JSON-RPC methods a reader makes: each asks the node for what it holds, and none changes
 * anything, signs anything or hands the node bytes to relay. A client made with `readOnly` passes on
 * these and no other.
 */
export const READ_METHODS: ReadonlySet<string> = new Set([
  'eth_blockNumber',
  'eth_call',
  'eth_chainId',
  'eth_gasPrice',
  'eth_getBalance',
  'eth_getBlockByNumber',
  'eth_getCode',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
]);

export type EvmRpcOptions = {
  timeoutMs?: number;
  /**
   * The most requests in one JSON-RPC batch. Left out, the reads of one moment go as one batch,
   * whatever their number. A free node takes fewer: drpc's refuses a batch of more than three.
   */
  batchSize?: number;
  /**
   * The most HTTP requests in flight at once; the rest wait their turn. Left out, there is no limit.
   * A public node answers a burst with 403 or 429. The time a request waits its turn counts toward
   * `timeoutMs`, since viem starts its timer before it calls the fetch: give a queue its time.
   */
  maxInFlight?: number;
  /**
   * True for a client that only ever reads (the snapshot worker's): a method that is not in
   * `READ_METHODS` is refused here, as `NotSupported`, and never reaches the node. So nothing that
   * holds this client can relay a transaction through it, whatever it was handed. Off by default:
   * the adapter simulates (`eth_simulateV1`, `eth_estimateGas`) and relays (`eth_sendRawTransaction`)
   * through the same client, for the API, the keeper and the test worlds.
   */
  readOnly?: boolean;
  /** What makes the HTTP request. A test hands in its own, and no connection is opened. */
  fetchFn?: typeof fetch;
};

/** `fetchFn` with at most `max` calls running; the others start in the order they came. */
function inTurn(fetchFn: typeof fetch, max: number): typeof fetch {
  let running = 0;
  const waiting: (() => void)[] = [];
  return (async (...args: Parameters<typeof fetch>) => {
    if (running >= max) await new Promise<void>((go) => waiting.push(go));
    else running++;
    try {
      return await fetchFn(...args);
    } finally {
      // The turn goes straight to the next in line, so the count stays where it is.
      const next = waiting.shift();
      if (next) next();
      else running--;
    }
  }) as typeof fetch;
}

/** The transport with every method that is not a read refused before the node is asked. */
function readsOnly(transport: Transport): Transport {
  return (config) => {
    const made = transport(config);
    const request = (async (args: { method: string }, ...rest: unknown[]) => {
      if (!READ_METHODS.has(args.method))
        throw new ChainError(
          'NotSupported',
          `this client only reads, and ${args.method} is not a read it makes`,
        );
      return (made.request as (...a: unknown[]) => Promise<unknown>)(args, ...rest);
    }) as typeof made.request;
    return { ...made, request };
  };
}

/**
 * A client on one URL. Requests made together go as one JSON-RPC batch, so the reads of one moment
 * (every call names the same block) cost one round trip; `batchSize` and `maxInFlight` cut that into
 * small batches sent a few at a time, for a node that takes no more.
 */
export function createEvmRpc(url: string, options: EvmRpcOptions = {}): EvmRpc {
  const fetchFn =
    options.maxInFlight !== undefined
      ? inTurn(options.fetchFn ?? fetch, options.maxInFlight)
      : options.fetchFn;
  const transport = http(url, {
    batch: options.batchSize !== undefined ? { batchSize: options.batchSize } : true,
    timeout: options.timeoutMs ?? 30_000,
    retryCount: 2,
    ...(fetchFn ? { fetchFn } : {}),
  });
  return createPublicClient({ transport: options.readOnly ? readsOnly(transport) : transport });
}

/**
 * True when the node answered and the call reverted or returned nothing: the contract said no, or
 * there is no contract. False when the node did not answer at all.
 */
export function isRevert(e: unknown): boolean {
  if (!(e instanceof BaseError)) return false;
  return Boolean(
    e.walk(
      (inner) =>
        inner instanceof ContractFunctionRevertedError ||
        inner instanceof ContractFunctionZeroDataError ||
        inner instanceof ExecutionRevertedError ||
        inner instanceof RawContractError ||
        inner instanceof AbiDecodingZeroDataError,
    ),
  );
}

/**
 * Runs one request of the node. A node that does not answer is `Unavailable`, worth asking again; its
 * own message is not passed on, since it can carry the URL. A revert is left to the caller.
 */
export async function ask<T>(what: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (e instanceof ChainError || isRevert(e)) throw e;
    // A call error that is not a revert is the node's: a timeout, a refused request.
    const kind =
      e instanceof ContractFunctionExecutionError || e instanceof CallExecutionError
        ? 'the call'
        : 'the request';
    const error = new ChainError('Unavailable', `the EVM RPC did not answer ${what} (${kind})`);
    error.cause = e;
    throw error;
  }
}
