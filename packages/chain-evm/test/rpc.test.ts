import { ChainError } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { createEvmRpc, READ_METHODS } from '../src/vault/rpc';

// The client a reader is given, as the snapshot worker makes it for a mainnet: small JSON-RPC batches
// (a free node takes three a batch), few HTTP requests at once (a public node answers a burst with
// 403), and nothing but reads passed on. No connection is opened: the fetch is a stand-in that
// answers every request and keeps what it was asked.

const URL = 'https://node.example.invalid/v2/NodeKey789';

type Call = { id: number; method: string };

function node(wait = 5) {
  const batches: Call[][] = [];
  let inFlight = 0;
  let most = 0;
  const fetchFn = (async (_input: unknown, init?: { body?: unknown }) => {
    inFlight++;
    most = Math.max(most, inFlight);
    const body = JSON.parse(String(init?.body)) as Call | Call[];
    const calls = Array.isArray(body) ? body : [body];
    batches.push(calls);
    await new Promise((resolve) => setTimeout(resolve, wait));
    inFlight--;
    const answers = calls.map((call) => ({ jsonrpc: '2.0', id: call.id, result: '0x10' }));
    return new Response(JSON.stringify(Array.isArray(body) ? answers : answers[0]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchFn, batches, most: () => most };
}

const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as const;

describe('the EVM client of a reader', () => {
  it('sends no batch larger than it was told, and no more requests at once than it was told', async () => {
    const n = node();
    const rpc = createEvmRpc(URL, { batchSize: 3, maxInFlight: 2, fetchFn: n.fetchFn });
    const balances = await Promise.all(
      Array.from({ length: 20 }, (_, i) => rpc.getBalance({ address: address(i + 1) })),
    );
    expect(balances).toEqual(Array.from({ length: 20 }, () => 16n));
    expect(n.batches.flat()).toHaveLength(20);
    expect(Math.max(...n.batches.map((b) => b.length))).toBe(3);
    expect(n.batches.length).toBeGreaterThanOrEqual(7);
    expect(n.most()).toBe(2);
  });

  it('leaves a client made with no limit as it was: one batch for the reads of one moment', async () => {
    const n = node();
    const rpc = createEvmRpc(URL, { fetchFn: n.fetchFn });
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => rpc.getBalance({ address: address(i + 1) })),
    );
    expect(n.batches.map((b) => b.length)).toEqual([20]);
  });

  it('passes on what reads, and refuses everything else before the node is asked', async () => {
    const n = node(0);
    const rpc = createEvmRpc(URL, { readOnly: true, batchSize: 3, fetchFn: n.fetchFn });
    await rpc.getBlockNumber();
    await rpc.getChainId();
    await rpc.call({ to: address(1), data: '0x' });
    expect(n.batches.flat().map((c) => c.method)).toEqual([
      'eth_blockNumber',
      'eth_chainId',
      'eth_call',
    ]);
    const asked = n.batches.length;
    const request = rpc.request as (args: { method: string; params?: unknown }) => Promise<unknown>;
    for (const method of [
      'eth_sendRawTransaction',
      'eth_sendTransaction',
      'eth_sign',
      'eth_signTypedData_v4',
      'personal_sign',
      'wallet_sendCalls',
      'eth_simulateV1',
      'anvil_setBalance',
      'eth_somethingNew',
    ]) {
      const refusal = await request({ method, params: ['0x00'] }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(refusal, method).toBeInstanceOf(ChainError);
      expect((refusal as ChainError).code, method).toBe('NotSupported');
      expect((refusal as ChainError).message, method).toBe(
        `this client only reads, and ${method} is not a read it makes`,
      );
      expect((refusal as ChainError).message).not.toContain('NodeKey789');
    }
    // Nothing reached the node, and nothing was tried again.
    expect(n.batches).toHaveLength(asked);
    // Without the option a client is the one the adapter builds and relays through.
    const open = createEvmRpc(URL, { fetchFn: n.fetchFn });
    await (open.request as typeof request)({ method: 'eth_sendRawTransaction', params: ['0x00'] });
    expect(n.batches.flat().at(-1)?.method).toBe('eth_sendRawTransaction');
  });

  it('names as reads only methods that change nothing and sign nothing', () => {
    expect([...READ_METHODS].sort()).toEqual([
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
  });
});
