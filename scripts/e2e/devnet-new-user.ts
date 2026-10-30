import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createDb, seedChains } from '@colosseum/db';
import { type EnvLike, OrderDetail, parseChainConfigs } from '@colosseum/schemas';
import {
  basketIdOfPlan,
  chainReadOf,
  createOrderApi,
  deploymentsOf,
  execute,
  rpcAt,
  type SignedRecord,
} from '@colosseum/sdk';
import {
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  partiallySignTransaction,
} from '@solana/kit';
import { buildApp } from '../../apps/api/src/app';
import { DEPLOYMENTS_DIR } from '../../apps/api/src/deployments';
import { IDENTITY_TOKEN_HEADER } from '../../apps/api/src/plugins/auth';
import { ROOMY, testIssuer } from '../../apps/api/src/testing/harness';

// A brand-new person on Solana devnet, end to end, through the real API built on this machine: a fresh
// wallet nobody has used, the test faucet, a vault of three stocks, every step built by the API, held to
// the guard and signed by that wallet as the web's executor does it, and the vault on the event's
// leaderboard, before and after the snapshot worker reads it. Devnet only: test tokens, `sandbox`.
//
//   pnpm e2e:devnet-new-user
//
// What it needs, none of it in a file of this repository:
//   - the local database (`pnpm db:up`) with the devnet `basket_assets` rows
//     (`pnpm exec tsx scripts/solana/basket-assets.ts deployments/solana-devnet.json`);
//   - the devnet faucet's key file, read here and handed to the app in memory, never printed:
//     E2E_FAUCET_KEY_FILE, else ~/Documents/worlds-fair-hackathon/testnet-keys/solana-devnet-faucet.json;
//   - the devnet price writer running (live-1), or the deposit is refused for a stale price.
// Optional: E2E_AMOUNT_USD (default 5000), E2E_DATABASE_URL (a local one only), DEVNET_RPC_URL,
// E2E_LOG_FILE (where the app's log lines go).
// The sign-in is a throwaway test issuer's (apps/api/src/testing/harness.ts), not Privy: the API under
// test trusts that issuer alone.

const DEVNET = process.env.DEVNET_RPC_URL ?? 'https://api.devnet.solana.com';
const DB_URL =
  process.env.E2E_DATABASE_URL ?? 'postgres://colosseum:colosseum@localhost:5433/colosseum';
const KEY_FILE =
  process.env.E2E_FAUCET_KEY_FILE ??
  join(homedir(), 'Documents/worlds-fair-hackathon/testnet-keys/solana-devnet-faucet.json');
const AMOUNT = Number(process.env.E2E_AMOUNT_USD ?? 5000);
const HOLDINGS = [
  { assetId: 'solana:nvdax', weightBps: 3350 },
  { assetId: 'solana:tslax', weightBps: 3350 },
  { assetId: 'solana:googlx', weightBps: 3300 },
];

if (!DEVNET.toLowerCase().includes('devnet'))
  throw new Error('DEVNET_RPC_URL does not name devnet');
if (!/@(localhost|127\.0\.0\.1):/.test(DB_URL)) throw new Error('E2E_DATABASE_URL must be local');

const started = Date.now();
const results: { step: string; ok: boolean; ms: number; note: string }[] = [];
let stepAt = Date.now();
const explorer = (sig: string) => `https://solscan.io/tx/${sig}?cluster=devnet`;
function record(step: string, ok: boolean, note = '') {
  const ms = Date.now() - stepAt;
  stepAt = Date.now();
  results.push({ step, ok, ms, note });
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${step}  (${(ms / 1000).toFixed(1)} s)${note ? `\n      ${note}` : ''}`,
  );
  if (!ok) throw new Error(`stopped at: ${step}`);
}

const node = rpcAt(DEVNET);
async function balances(owner: string, mint: string) {
  const sol = (await node('getBalance', [owner, { commitment: 'confirmed' }])) as { value: number };
  const tok = (await node('getTokenAccountsByOwner', [
    owner,
    { mint },
    { encoding: 'jsonParsed', commitment: 'confirmed' },
  ])) as {
    value: { account: { data: { parsed: { info: { tokenAmount: { uiAmount: number } } } } } }[];
  };
  const usd = tok.value.reduce((s, a) => s + a.account.data.parsed.info.tokenAmount.uiAmount, 0);
  return { sol: sol.value / 1e9, usd };
}

// The event window starts just before this run: only a vault made now can be on the board.
const since = new Date(started - 60_000).toISOString();
let skewMs = 0;
/** How many answers were 503 for the node's rate limit and asked again. */
let retried = 0;
const env: EnvLike = {
  CHAIN_MODE_SOLANA: 'live',
  CHAIN_NETWORK_SOLANA: 'testnet',
  CHAIN_MODE_ROBINHOOD: 'mock',
  CHAIN_NETWORK_ROBINHOOD: 'testnet',
  CHAIN_MODE_BASE: 'off',
  CHAIN_NETWORK_BASE: 'testnet',
  CHAIN_ROUTER_SOLANA: '',
  CHAIN_PRICE_SOURCE_SOLANA: '',
  SOLANA_RPC_URL: DEVNET,
  KEEPER_ENABLED: 'off',
  LEADERBOARD_SINCE: since,
  TESTNET_FAUCET_SOLANA_KEY: readFileSync(KEY_FILE, 'utf8').trim(),
};

const { db, client } = createDb(DB_URL);
await seedChains(db, parseChainConfigs(env));
const issuer = await testIssuer('e2e-devnet');
const app = await buildApp({
  env,
  deployments: DEPLOYMENTS_DIR,
  // The app's own log lines (no node URL or key is ever in one, apps/api/src/redact.ts): E2E_LOG_FILE.
  logTo: {
    write: (line) =>
      void (process.env.E2E_LOG_FILE && appendFileSync(process.env.E2E_LOG_FILE, line)),
  },
  v1: { auth: issuer.issuer, db, limits: ROOMY, now: () => new Date(Date.now() + skewMs) },
});
const base = await app.listen({ port: 0, host: '127.0.0.1' });

try {
  // 1. A wallet nobody has used, signed in as a wallet made in the app (Privy's embedded one).
  const wallet = await generateKeyPairSigner();
  const owner = wallet.address;
  const sub = `did:privy:e2e-${crypto.randomUUID()}`;
  const linked = JSON.stringify([
    { type: 'wallet', address: owner, chain_type: 'solana', wallet_client_type: 'privy' },
    { type: 'email', address: 'e2e@example.invalid' },
  ]);
  const headers = async () => ({
    authorization: `Bearer ${await issuer.sign(sub, { sid: sub }, '1h')}`,
    [IDENTITY_TOKEN_HEADER]: await issuer.sign(sub, { linked_accounts: linked }, '1h'),
  });
  const apiFetch = async (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), ...(await headers()) },
    });
  // The public devnet node limits how often it is asked (429), which the API answers as a 503 to try
  // again: asked again here as a person would press again, a few seconds apart.
  const json = async (path: string, init?: RequestInit) => {
    for (let tries = 1; ; tries++) {
      const res = await apiFetch(path, init);
      const body = await res.json().catch(() => null);
      if (res.status !== 503 || !body?.details?.retryable || tries >= 8)
        return { status: res.status, body };
      retried += 1;
      await new Promise((r) => setTimeout(r, 4000));
    }
  };
  const post = (path: string, body: unknown) =>
    json(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const config = await json('/v1/config');
  const sol = config.body?.chains?.find((c: { id: string }) => c.id === 'solana');
  record(
    'API on Solana devnet',
    sol?.provenance === 'sandbox' && sol?.network === 'testnet',
    `network ${sol?.networkName ?? sol?.network}, provenance ${sol?.provenance}`,
  );
  const me = await json('/v1/me');
  record('fresh wallet signs in', me.status === 200, `wallet ${owner}`);
  const cashMint: string = JSON.parse(
    readFileSync(join(DEPLOYMENTS_DIR, 'solana-devnet.json'), 'utf8'),
  ).cash.mint;
  const empty = await balances(owner, cashMint);
  record(
    'wallet starts empty',
    empty.sol === 0 && empty.usd === 0,
    `${empty.sol} SOL, $${empty.usd}`,
  );

  // 2. The vault, as the deposit card stores it: reviewed, every warning accepted, then confirmed.
  const ask = {
    version: 1,
    origin: 'model',
    language: 'en',
    allocations: HOLDINGS,
    amountUsd: AMOUNT,
    goal: null,
    risk: null,
  };
  const review = await post('/v1/conversations/solana/goal/accept', { ...ask, confirm: false });
  if (review.status !== 200) record('vault reviewed', false, JSON.stringify(review.body));
  const warnings = (review.body.review.warnings ?? []).map((w: { id: string }) => w.id);
  const stored = await post('/v1/conversations/solana/goal/accept', {
    ...ask,
    confirm: true,
    acceptedWarnings: warnings,
    reviewHash: review.body.review.reviewHash,
  });
  record(
    'vault stored',
    stored.status === 200 && stored.body.status === 'stored',
    `proposal ${stored.body?.proposalId}, ${warnings.length} warning(s) accepted${stored.status === 200 ? '' : `: ${JSON.stringify(stored.body)}`}`,
  );
  const proposalId: string = stored.body.proposalId;
  const lines = stored.body.proposal.lines ?? stored.body.proposal.components;

  // 3. What the wallet is missing, and the faucet that fills it.
  const funding = await json(`/v1/funding?proposalId=${proposalId}&amountUsd=${AMOUNT}`);
  record(
    'funding read offers test funds',
    funding.status === 200 && funding.body.testFunds === true && funding.body.ok === false,
    `testFunds ${funding.body?.testFunds}, ok ${funding.body?.ok}, cash missing ${funding.body?.cash?.missingRaw}, gas missing ${funding.body?.gas?.missingRaw}`,
  );
  const fund = await post('/v1/testnet/fund', { amountUsd: AMOUNT, proposalId });
  record(
    'faucet sends',
    fund.status === 200,
    fund.status === 200
      ? `cash ${JSON.stringify(fund.body.cash)}, gas ${JSON.stringify(fund.body.gas)}, sends left today ${fund.body.left}\n      ${fund.body.txIds.map(explorer).join('\n      ')}`
      : JSON.stringify(fund.body),
  );
  let held = await balances(owner, cashMint);
  for (let i = 0; i < 20 && held.usd < AMOUNT; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    held = await balances(owner, cashMint);
  }
  record(
    'test funds in the wallet',
    held.usd >= AMOUNT && held.sol > 0,
    `${held.sol} SOL, $${held.usd}`,
  );
  const again = await json(`/v1/funding?proposalId=${proposalId}&amountUsd=${AMOUNT}`);
  record('funding read says ready', again.body?.ok === true, `ok ${again.body?.ok}`);

  // 4. The deposit: the order, then every step through the web's executor with this wallet.
  const placed = await post('/v1/orders', {
    type: 'buy',
    owner: { solana: owner },
    amountUsd: AMOUNT,
    proposalId,
  });
  if (placed.status !== 200) record('order placed', false, JSON.stringify(placed.body));
  const order = OrderDetail.parse(placed.body);
  record('order placed', true, `order ${order.id}: ${order.legs.map((l) => l.kind).join(', ')}`);
  const memory = new Map<string, SignedRecord>();
  const deployments = deploymentsOf('testnet');
  const cash = deployments.solana?.cash ?? 'solana:usdc';
  const run = () =>
    execute(order, {
      api: createOrderApi(apiFetch),
      signer: {
        active: (family) => (family === 'solana' ? { address: owner } : null),
        caps: () => ({ signOnly: true }),
        async sign(_chain, txs) {
          return Promise.all(
            txs.map(async (tx) => {
              const decoded = getTransactionDecoder().decode(Buffer.from(tx.payload, 'base64'));
              const signed = await partiallySignTransaction([wallet.keyPair], decoded);
              return getBase64EncodedWireTransaction(signed);
            }),
          );
        },
        send: () => Promise.reject(new Error('this wallet signs only')),
      },
      deployments,
      plan: {
        basketId: order.basketId ?? basketIdOfPlan(proposalId),
        targets: (lines as { assetId: string; weightBps: number }[])
          .filter((l) => l.assetId !== cash && l.weightBps > 0)
          .map((l) => ({ asset: l.assetId, weightBps: l.weightBps })),
        autoFollow: false,
      },
      consents: [],
      signed: { get: (k) => memory.get(k), set: (k, r) => void memory.set(k, r) },
      chainRead: chainReadOf({ solana: node }),
      onEvent: (e) => {
        if (e.phase === 'settled') {
          const leg = e.order.legs.find((l) => l.id === e.legId);
          console.log(`      ${leg?.kind} ${leg?.status} ${leg?.txId ? explorer(leg.txId) : ''}`);
        }
      },
    } as Parameters<typeof execute>[1]);
  // A step the API could not build for the node's rate limit stops the run; the order is run again.
  let result = await run();
  for (let i = 0; i < 8 && result.status === 'error' && result.error.status === 503; i++) {
    retried += 1;
    await new Promise((r) => setTimeout(r, 4000));
    result = await run();
  }
  const done = result.status === 'done';
  record(
    'every step signed and confirmed',
    done,
    done
      ? `${result.order.legs.length} steps`
      : JSON.stringify({
          status: result.status,
          ...('refusal' in result ? { refusal: result.refusal.message } : {}),
          ...('error' in result ? { error: result.error } : {}),
          ...('wallet' in result ? { wallet: result.wallet } : {}),
          legId: 'legId' in result ? result.legId : null,
        }),
  );
  const final = (await json(`/v1/orders/${order.id}`)).body;
  record('order done', final.status === 'done', `status ${final.status}`);
  const after = await balances(owner, cashMint);
  record(
    'wallet paid the deposit and the fees',
    after.usd < held.usd,
    `${after.sol} SOL, $${after.usd} left`,
  );

  // 5. The event's leaderboard, before and after the snapshot worker reads the vault.
  const short = `${owner.slice(0, 4)}…${owner.slice(-4)}`;
  const board = async () => {
    // Past twice the minute an answer is kept: between one and two minutes the kept answer is still
    // served while it is read again (read-cache.ts, `keeper`).
    skewMs += 121_000;
    const res = await json('/v1/leaderboard?chain=solana');
    return { res, row: res.body?.vaults?.find((v: { owner: string }) => v.owner === short) };
  };
  const first = await board();
  record(
    'on the leaderboard at once',
    Boolean(first.row) && first.res.body.since === since,
    first.row
      ? `rank ${first.row.rank}, value ${first.row.value?.usd ?? 'none'}, pnl ${first.row.pnl?.usd ?? 'none'}, noPnl ${first.row.noPnl}`
      : `not listed: since ${first.res.body?.since}, ${first.res.body?.vaults?.length} row(s)`,
  );
  const worker = await new Promise<number>((resolve) => {
    const child = spawn('pnpm', ['exec', 'tsx', 'apps/snapshot/src/main.ts', '--once'], {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        DATABASE_URL: DB_URL,
        SOLANA_RPC_URL: DEVNET,
        SNAPSHOT_CHAINS: 'solana',
        CHAIN_MODE_SOLANA: 'readonly',
        CHAIN_NETWORK_SOLANA: 'testnet',
        CHAIN_MODE_ROBINHOOD: 'off',
        CHAIN_NETWORK_ROBINHOOD: 'testnet',
        CHAIN_MODE_BASE: 'off',
        CHAIN_NETWORK_BASE: 'testnet',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => {
      const mine = out
        .split('\n')
        .filter((l) => l.includes(owner.slice(0, 8)) || /pass|fail/i.test(l));
      if (mine.length)
        console.log(
          mine
            .slice(-6)
            .map((l) => `      ${l.slice(0, 200)}`)
            .join('\n'),
        );
      resolve(code ?? 1);
    });
  });
  record('snapshot worker read the chain', worker === 0, `exit ${worker}`);
  const second = await board();
  record(
    'value and PnL after the snapshot',
    Boolean(second.row?.value && second.row?.pnl),
    second.row
      ? `rank ${second.row.rank}, value $${second.row.value?.usd}, deposits $${second.row.pnl?.depositsUsd}, pnl $${second.row.pnl?.usd} (${((second.row.pnl?.pct ?? 0) * 100).toFixed(2)}%)`
      : 'not listed',
  );
} catch (e) {
  if (!(e instanceof Error && e.message.startsWith('stopped at'))) {
    console.error(`FAIL  unexpected: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  } else process.exitCode = 1;
} finally {
  await app.close();
  await client.end();
  const passed = results.filter((r) => r.ok).length;
  console.log(
    `\n${passed}/${results.length} steps passed in ${((Date.now() - started) / 1000).toFixed(0)} s; ${retried} answer(s) asked again for the node's rate limit`,
  );
}
