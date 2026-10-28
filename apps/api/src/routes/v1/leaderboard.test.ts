import { randomUUID } from 'node:crypto';
import { mockAddress, mockCashId } from '@colosseum/chain-mock';
import { indexFamilies, legs, orders, users, vaultLifetimes, vaultNumbers } from '@colosseum/db';
import { DISCLAIMER, type IntentRequest, LeaderboardResponse } from '@colosseum/schemas';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LEADERBOARD_PNL_METHOD, LEADERBOARD_RULE, shortOwner } from '../../portfolio/leaderboard';
import { type Person, testApp, testDb } from '../../testing/harness';
import { seedSnapshot, seedVault, vaultAddress } from '../../testing/portfolio-world';
import { LEADERBOARD_KEPT_MS } from './leaderboard';

// GET /v1/leaderboard through HTTP on the mock chains and the real database: every open vault on the
// chain, ranked by what it made, with no sign-in and nothing personal in the answer. The vaults,
// snapshots, deposits and withdrawals are written here as the app and the worker would have. Other
// test files write Solana's mock vaults at the same time, so each check reads this file's own rows,
// and the order is checked between them and against the rule for the whole answer.

vi.setConfig({ testTimeout: 60_000 });

const MINUTE = 60_000;
let clock = new Date();
const ago = (minutes: number) => new Date(clock.getTime() - minutes * MINUTE);

let data: Awaited<ReturnType<typeof testDb>>;
let app: FastifyInstance;
const addresses: string[] = [];

/** A person of this file: their wallet, and the row the server keeps for them. */
async function someone() {
  const id = randomUUID();
  const who = {
    sub: `did:privy:test-${id}`,
    solana: mockAddress('solana', `leaderboard-test:${id}`),
    evm: mockAddress('robinhood', `leaderboard-test:${id}`),
  };
  data.track(who as Person);
  const [user] = await data.db
    .insert(users)
    .values({ privyId: who.sub })
    .returning({ id: users.id });
  if (!user) throw new Error('user insert');
  return { ...who, userId: user.id };
}
type Someone = Awaited<ReturnType<typeof someone>>;

/** A vault of theirs, its plan's number on chain, in the cache unless `cached` is false. */
async function vaultOf(who: Someone, a: { number: string; name?: string; cached?: boolean }) {
  const address = vaultAddress('solana');
  addresses.push(address);
  if (a.cached !== false)
    await seedVault(data.db, {
      chain: 'solana',
      owner: who.solana,
      address,
      onchainBasketId: a.number,
      name: a.name ?? null,
    });
  return address;
}

/** The worker's read of the vault, `minutes` before the clock. */
const snapshot = (
  who: Someone,
  address: string,
  number: string,
  valueUsd: number,
  minutes: number,
  over: { recipeOnchainId?: string } = {},
) =>
  seedSnapshot(data.db, {
    chain: 'solana',
    address,
    owner: who.solana,
    onchainBasketId: number,
    observedAt: ago(minutes),
    valueUsd,
    ...over,
  });

const SAID = { summary: 'a test order', preparedBy: 'app' as const, disclaimer: DISCLAIMER.en };

/** A deposit of `usd` into the vault with this number, confirmed when `at` says. */
async function deposit(who: Someone, number: string, usd: number, at = ago(120)) {
  const [order] = await data.db
    .insert(orders)
    .values({
      ...SAID,
      type: 'buy',
      ownerSolana: who.solana,
      request: { type: 'buy', amountUsd: usd } as unknown as IntentRequest,
      basketId: number,
      status: 'done',
      expiresAt: clock,
    })
    .returning({ id: orders.id });
  if (!order) throw new Error('order insert');
  await data.db.insert(legs).values({
    orderId: order.id,
    chainId: 'solana',
    seq: 0,
    kind: 'create_vault',
    signer: 'owner',
    description: 'a step a test wrote',
    cashRaw: String(Math.round(usd * 1_000_000)),
    trades: [],
    status: 'confirmed',
    trigger: 'manual',
    provenance: 'mock',
    updatedAt: at,
  });
}

/** A confirmed withdrawal from the vault: one token worth `usd` when it was ordered, one unpriced. */
async function withdrawal(who: Someone, address: string, usd: number, unpriced = false) {
  const [order] = await data.db
    .insert(orders)
    .values({
      ...SAID,
      type: 'withdraw',
      ownerSolana: who.solana,
      request: { type: 'withdraw', vaults: [address] } as unknown as IntentRequest,
      status: 'done',
      expiresAt: clock,
    })
    .returning({ id: orders.id });
  if (!order) throw new Error('order insert');
  const valued = {
    usd: usd.toFixed(2),
    source: 'test',
    method: 'test',
    fetchedAt: ago(60).toISOString(),
    provenance: 'mock' as const,
  };
  await data.db.insert(legs).values({
    orderId: order.id,
    chainId: 'solana',
    seq: 0,
    kind: 'withdraw',
    signer: 'owner',
    description: 'a step a test wrote',
    withdrawals: [
      { asset: mockCashId('solana'), amountRaw: null, heldRaw: '0', valued },
      ...(unpriced ? [{ asset: 'solana:gold', amountRaw: null, heldRaw: '1' }] : []),
    ],
    trades: [],
    status: 'confirmed',
    trigger: 'manual',
    provenance: 'mock',
    updatedAt: ago(60),
  });
}

/** The answer, read past the time an answer is kept, so it is read again. */
async function read(fresh = true, on: FastifyInstance = app) {
  if (fresh) clock = new Date(clock.getTime() + 3 * LEADERBOARD_KEPT_MS);
  // No sign-in: anybody may ask.
  const res = await on.inject({ method: 'GET', url: '/v1/leaderboard' });
  expect(res.statusCode, res.body).toBe(200);
  const answer = LeaderboardResponse.parse(res.json());
  expect(res.json()).toEqual(answer);
  return { answer, body: res.body };
}

const rowAt = (answer: LeaderboardResponse, address: string) =>
  answer.vaults.find((row) => row.address === address);

beforeAll(async () => {
  data = await testDb();
  ({ app } = await testApp({ issuer: null, db: data.db, now: () => clock }));
});
afterAll(async () => {
  if (addresses.length)
    await data.db
      .delete(vaultLifetimes)
      .where(and(eq(vaultLifetimes.chainId, 'solana'), inArray(vaultLifetimes.address, addresses)));
  await app.close();
  await data.cleanUp();
});

describe('GET /v1/leaderboard', () => {
  it('ranks every open vault by what it made, with deposits less withdrawals as what went in', async () => {
    // Up: $1,000 in, $200 out, worth $1,100 now: it made $300, 30% of the $1,000 deposited.
    const a = await someone();
    const up = await vaultOf(a, { number: '7' });
    await deposit(a, '7', 1000);
    await withdrawal(a, up, 200);
    const upRead = (await snapshot(a, up, '7', 1100, 10)).observedAt.toISOString();
    await data.db
      .insert(vaultNumbers)
      .values({ userId: a.userId, chainId: 'solana', address: up, number: 3 });

    // Steady: following a shared portfolio, $1,000 in and worth $1,050.
    const b = await someone();
    const { slug } = await data.storeFamily('solana', [
      { kind: 'asset', asset: 'solana:spy', weightBps: 10_000 },
    ]);
    const [family] = await data.db
      .select({ familyId: indexFamilies.familyId, name: indexFamilies.name })
      .from(indexFamilies)
      .where(eq(indexFamilies.slug, slug));
    if (!family) throw new Error('no family');
    const steady = await vaultOf(b, { number: '1', name: 'Steady' });
    await deposit(b, '1', 1000);
    await snapshot(b, steady, '1', 1050, 10, { recipeOnchainId: `test:${family.familyId}` });

    // Outside: found by the worker alone, made outside the app: no deposit the server holds.
    const c = await someone();
    const outside = await vaultOf(c, { number: '1', cached: false });
    await snapshot(c, outside, '1', 999_999, 10);

    // Closed: not listed, whatever it made.
    const d = await someone();
    const closed = await vaultOf(d, { number: '1' });
    await deposit(d, '1', 10);
    await snapshot(d, closed, '1', 1000, 10);
    await data.db
      .insert(vaultLifetimes)
      .values({ chainId: 'solana', address: closed, closedAt: ago(5), updatedAt: ago(5) });

    // Reopened: its last life ($1,000 in, read at $5,000) is not counted; this life is $100 in, $120 now.
    const e = await someone();
    const again = await vaultOf(e, { number: '2' });
    await deposit(e, '2', 1000, ago(300));
    await snapshot(e, again, '2', 5000, 250);
    await data.db
      .insert(vaultLifetimes)
      .values({ chainId: 'solana', address: again, reopenedAt: ago(200), updatedAt: ago(200) });
    await deposit(e, '2', 100, ago(100));
    await snapshot(e, again, '2', 120, 10);

    const { answer } = await read();
    expect(answer).toMatchObject({
      chain: 'solana',
      provenance: 'mock',
      rule: LEADERBOARD_RULE,
      // no window set: every open vault
      since: null,
      disclaimer: DISCLAIMER.en,
    });

    const upRow = rowAt(answer, up);
    expect(upRow).toMatchObject({
      owner: shortOwner(a.solana),
      value: { usd: '1100.00', provenance: 'mock', fetchedAt: upRead },
      pnl: {
        usd: '300.00',
        pct: 0.3,
        netInUsd: '800.00',
        depositsUsd: '1000.00',
        withdrawalsUsd: '200.00',
        unvaluedWithdrawals: 0,
        method: LEADERBOARD_PNL_METHOD,
      },
      noPnl: null,
      follows: null,
    });
    // what it holds, the largest share first, cash as the rest
    expect(upRow?.holdings).toEqual([
      { asset: 'solana:spy', weightBps: 5000 },
      { asset: 'solana:nvda', weightBps: 3000 },
      { asset: 'solana:gold', weightBps: 2000 },
    ]);

    expect(rowAt(answer, steady)).toMatchObject({
      pnl: { usd: '50.00', pct: 0.05 },
      follows: { name: family.name, slug },
    });
    expect(rowAt(answer, again)).toMatchObject({
      value: { usd: '120.00' },
      pnl: { usd: '20.00', pct: 0.2, depositsUsd: '100.00' },
    });
    const outsideRow = rowAt(answer, outside);
    expect(outsideRow).toMatchObject({ pnl: null, noPnl: 'no_deposit_record' });
    expect(rowAt(answer, closed)).toBeUndefined();

    // In order among themselves, and the one with no figure after every row that has one.
    const rank = (address: string) => rowAt(answer, address)?.rank ?? Number.NaN;
    expect(rank(up)).toBeLessThan(rank(again));
    expect(rank(again)).toBeLessThan(rank(steady));
    const lastWithFigure = Math.max(...answer.vaults.filter((r) => r.pnl).map((r) => r.rank));
    expect(rank(outside)).toBeGreaterThan(lastWithFigure);
    // Ranks run from 1 with no gap, and shares never rise down the list.
    expect(answer.vaults.map((r) => r.rank)).toEqual(answer.vaults.map((_, i) => i + 1));
    const shares = answer.vaults.flatMap((r) => (r.pnl?.pct == null ? [] : [r.pnl.pct]));
    expect(shares).toEqual([...shares].sort((x, y) => y - x));
  });

  it('counts a withdrawal token with no price apart, and in no sum', async () => {
    const a = await someone();
    const vault = await vaultOf(a, { number: '4' });
    await deposit(a, '4', 500);
    await withdrawal(a, vault, 100, true);
    await snapshot(a, vault, '4', 450, 10);
    expect(rowAt((await read()).answer, vault)?.pnl).toMatchObject({
      usd: '50.00',
      withdrawalsUsd: '100.00',
      unvaluedWithdrawals: 1,
    });
  });

  it('says nothing about who owns a vault but the short form of the wallet', async () => {
    const a = await someone();
    // A name the owner typed, which is not on chain, and their own count of vaults: neither is public.
    const typed = `Maria Souza college fund ${randomUUID()}`;
    const vault = await vaultOf(a, { number: '5', name: typed });
    await deposit(a, '5', 100);
    await snapshot(a, vault, '5', 100, 10);
    await data.db
      .insert(vaultNumbers)
      .values({ userId: a.userId, chainId: 'solana', address: vault, number: 7 });
    const { answer, body } = await read();
    const mine = rowAt(answer, vault);
    expect(mine?.owner).toBe(shortOwner(a.solana));
    for (const personal of [typed, a.sub, a.userId, a.solana, a.evm, 'privy'])
      expect(body).not.toContain(personal);
    // every row holds these fields and no others: no name, no number, no user
    for (const row of answer.vaults)
      expect(Object.keys(row).sort()).toEqual([
        'address',
        'chain',
        'follows',
        'holdings',
        'noPnl',
        'owner',
        'pnl',
        'rank',
        'value',
      ]);
  });

  it('keeps an answer for a minute', async () => {
    await read();
    const a = await someone();
    const vault = await vaultOf(a, { number: '6' });
    await snapshot(a, vault, '6', 10, 1);
    // within the minute: the answer kept
    expect(rowAt((await read(false)).answer, vault)).toBeUndefined();
    // past it: read again
    expect(rowAt((await read()).answer, vault)).toBeDefined();
  });
});

describe('GET /v1/leaderboard with an event window (LEADERBOARD_SINCE)', () => {
  let windowed: FastifyInstance;
  let since: Date;
  beforeAll(async () => {
    since = new Date(Math.floor(clock.getTime() / 1000) * 1000 - 60 * MINUTE);
    ({ app: windowed } = await testApp({
      issuer: null,
      db: data.db,
      now: () => clock,
      env: { LEADERBOARD_SINCE: since.toISOString() },
    }));
  });
  afterAll(async () => {
    await windowed.close();
  });

  it('lists only vaults whose first deposit made in the app is at or after the window, and says it', async () => {
    const at = (minutes: number) => new Date(since.getTime() + minutes * MINUTE);
    const opened = async (number: string, first: Date | null) => {
      const who = await someone();
      const address = await vaultOf(who, { number });
      if (first) await deposit(who, number, 100, first);
      await snapshot(who, address, number, 110, 1);
      return { who, address };
    };
    const inside = await opened('11', at(30));
    const boundary = await opened('12', since);
    const before = await opened('13', at(-1));
    const none = await opened('14', null);
    // a later deposit does not bring an older vault into the window
    await deposit(before.who, '13', 50, at(10));

    const { answer } = await read(true, windowed);
    expect(answer.since).toBe(since.toISOString());
    expect(rowAt(answer, inside.address)).toBeDefined();
    expect(rowAt(answer, boundary.address)).toBeDefined();
    expect(rowAt(answer, before.address)).toBeUndefined();
    expect(rowAt(answer, none.address)).toBeUndefined();
    // every row listed made its first deposit in the window, so every row has a figure
    expect(answer.vaults.every((row) => row.pnl !== null)).toBe(true);
    expect(answer.vaults.map((r) => r.rank)).toEqual(answer.vaults.map((_, i) => i + 1));

    // the same vaults without a window: all four, as before
    const all = (await read()).answer;
    for (const v of [inside, boundary, before, none]) expect(rowAt(all, v.address)).toBeDefined();
  });

  it('refuses to start on a value it cannot read, naming the variable and not the value', async () => {
    for (const bad of ['yesterday', '2026-10-29', '2026-10-29T12:00:00', '2026-13-40T99:00:00Z']) {
      const started = testApp({
        issuer: null,
        db: data.db,
        now: () => clock,
        env: { LEADERBOARD_SINCE: bad },
      });
      await expect(started).rejects.toThrow(/^LEADERBOARD_SINCE: /);
      await started.catch((err: Error) => expect(err.message).not.toContain(bad));
    }
  });
});
