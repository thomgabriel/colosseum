import 'dotenv/config';
import './backfill-env';
import { BACKFILL_ENDPOINTS } from './backfill-env';

// `pnpm risk:assets-backfill-probe [solana|robinhood|all]`: before a long run, whether the backfill's endpoints
// (SOLANA_BACKFILL_RPC_URL, ROBINHOOD_BACKFILL_RPC_URL, else the scripts' usual ones) serve what it asks, 30 days
// back, and how fast. Read-only, a few hundred requests at most. Prints the variable used, never the URL.
//   Solana: getSlot; getBlock about 30 days back (history kept?); getSignaturesForAddress on a busy pool; then
//           getTransaction over its signatures at rising concurrency (transactions a second, refusals).
//   Robinhood Chain: eth_blockNumber; eth_getLogs over 2,000 blocks about 30 days back.

const which = process.argv[2] ?? 'all';
const SOL = process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com';
const RH = process.env.RISK_EVM_RH_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
/** Raydium's SOL/USDC CPMM-v4 pool: busy enough to fill a page of signatures in seconds. */
const BUSY_POOL = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';

async function call(url: string, method: string, params: unknown[]) {
  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(60_000),
  });
  const ms = Date.now() - t0;
  if (!res.ok) return { ok: false as const, status: res.status, ms, error: `HTTP ${res.status}` };
  const j = (await res.json()) as { result?: unknown; error?: { message?: string } };
  return j.error
    ? { ok: false as const, status: res.status, ms, error: j.error.message ?? 'error' }
    : { ok: true as const, status: res.status, ms, result: j.result };
}

async function solana() {
  const endpoint =
    BACKFILL_ENDPOINTS.solana ?? (process.env.SOLANA_RPC_URL ? 'SOLANA_RPC_URL' : 'public');
  const slot = await call(SOL, 'getSlot', []);
  if (!slot.ok) return { endpoint, error: `getSlot: ${slot.error}` };
  // about 2.5 slots a second: 30 days back, then the first block that exists from there
  const back = (slot.result as number) - Math.round(30 * 86_400 * 2.5);
  let old: Awaited<ReturnType<typeof call>> = { ok: false, status: 0, ms: 0, error: 'not asked' };
  for (let s = back; s < back + 20; s++) {
    old = await call(SOL, 'getBlock', [
      s,
      { transactionDetails: 'none', rewards: false, maxSupportedTransactionVersion: 1 },
    ]);
    if (old.ok) break;
  }
  const blockTime = old.ok ? ((old.result as { blockTime?: number }).blockTime ?? null) : null;
  const sigs = await call(SOL, 'getSignaturesForAddress', [BUSY_POOL, { limit: 1000 }]);
  if (!sigs.ok) return { endpoint, history30d: old.ok, getSignaturesForAddress: sigs.error };
  const list = (sigs.result as Array<{ signature: string }>).map((x) => x.signature);
  const rounds = [];
  let i = 0;
  for (const concurrency of [5, 20, 50]) {
    const batch = list.slice(i, i + concurrency * 4);
    i += batch.length;
    const t0 = Date.now();
    const answers = await Promise.all(
      batch.map((s) =>
        call(SOL, 'getTransaction', [s, { maxSupportedTransactionVersion: 1, encoding: 'json' }]),
      ),
    );
    const ok = answers.filter((a) => a.ok).length;
    const refused = answers.filter((a) => !a.ok).map((a) => (a.ok ? '' : a.error));
    rounds.push({
      concurrency,
      asked: batch.length,
      ok,
      txPerSecond: +((ok * 1000) / Math.max(1, Date.now() - t0)).toFixed(1),
      refusals: [...new Set(refused)].slice(0, 3),
    });
  }
  return {
    endpoint,
    history30d: old.ok,
    blockAbout30DaysBack: blockTime ? new Date(blockTime * 1000).toISOString() : null,
    oldBlockError: old.ok ? null : old.error,
    signaturesPageMs: sigs.ms,
    getTransaction: rounds,
  };
}

async function robinhood() {
  const endpoint =
    BACKFILL_ENDPOINTS.robinhood ??
    (process.env.RISK_EVM_RH_RPC_URL ? 'RISK_EVM_RH_RPC_URL' : 'public');
  const head = await call(RH, 'eth_blockNumber', []);
  if (!head.ok) return { endpoint, error: `eth_blockNumber: ${head.error}` };
  const h = Number.parseInt(head.result as string, 16);
  const from = h - 30 * 86_400 * 4; // about four blocks a second
  const logs = await call(RH, 'eth_getLogs', [
    { fromBlock: `0x${from.toString(16)}`, toBlock: `0x${(from + 2000).toString(16)}` },
  ]);
  return {
    endpoint,
    head: h,
    getLogs2000BlocksAbout30DaysBack: logs.ok
      ? { logs: (logs.result as unknown[]).length, ms: logs.ms }
      : { error: logs.error },
  };
}

const out: Record<string, unknown> = {};
if (which === 'solana' || which === 'all') out.solana = await solana();
if (which === 'robinhood' || which === 'all') out.robinhood = await robinhood();
console.log(JSON.stringify(out, null, 1));
