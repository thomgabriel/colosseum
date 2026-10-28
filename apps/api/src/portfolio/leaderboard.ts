import { type Db, legs, orders, users, vaultNumbers, vaultSnapshots, vaults } from '@colosseum/db';
import {
  type Address,
  chainFamily,
  type LeaderboardHolding,
  type LeaderboardPnl,
  type LeaderboardRow,
} from '@colosseum/schemas';
import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import type { ChainEntry } from '../orders/chains';
import { lifetimesOf } from './lifetimes';
import { familiesOf, type NumberedVault, putInOf } from './plans';
import { thisLife } from './scope';
import { SNAPSHOT_LOOKBACK_DAYS } from './snapshots';

// The leaderboard (GET /v1/leaderboard): every open vault the server knows on one chain, ranked by
// what it made or lost. Read from the database alone, as the portfolio's routes are, but for every
// owner at once, so nothing personal leaves it: a row names its owner by the short form of the wallet
// alone.
//
// What a vault made is the portfolio overview's "all time" figure (apps/web/features/portfolio-
// section/overview-series.ts, `flowsOf`, and OverviewPage's `VaultRow`), worked out here on the server
// from the same records: its newest snapshot's value, less what went in. What went in is the confirmed
// deposits of `putInOf` (plans.ts), the one definition GET /v1/portfolio/plans answers, less the
// confirmed withdrawal steps, each token at the value it had when the withdrawal was ordered; a token
// that had no price then is in no sum and is counted apart. A vault opened again counts from then
// (gate VAULT-CLOSE-REUSE), and a closed one is not listed.

/** How a row's `pnl` is made: its `method`. */
export const LEADERBOARD_PNL_METHOD =
  'value at the newest snapshot less what went in: the cash of each confirmed deposit made in this app, less each confirmed withdrawal at its value when it was ordered; a vault opened again counts from then';

/** How the rows are ordered: the answer's `rule`. */
export const LEADERBOARD_RULE =
  'by what the vault made as a share of what went in, highest first, then by what it made in dollars; a vault that made a figure but has nothing left in it follows, by dollars; a vault with no figure comes last, by value';

const MICRO = 1_000_000n;

/** A decimal string as millionths of a dollar, exactly; digits past the sixth place are dropped. */
export function microOf(decimal: string): bigint {
  const negative = decimal.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? decimal.slice(1) : decimal).split('.');
  const micro = BigInt(whole || '0') * MICRO + BigInt(`${fraction}000000`.slice(0, 6));
  return negative ? -micro : micro;
}

/** Millionths of a dollar as a decimal string: every digit it has, and at least the cents. */
export function decimalOf(micro: bigint): string {
  const negative = micro < 0n;
  const size = negative ? -micro : micro;
  const fraction = (size % MICRO).toString().padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
  return `${negative ? '-' : ''}${size / MICRO}.${fraction}`;
}

/** The short form of a wallet: its first four characters and its last four. */
export const shortOwner = (address: string) =>
  address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;

/** What a vault made: value less (deposits less withdrawals), and that as a share of what went in. */
export function pnlOf(a: { valueUsd: string; depositsUsd: string; withdrawalsUsd: string }): {
  usd: string;
  pct: number | null;
  netInUsd: string;
} {
  const net = microOf(a.depositsUsd) - microOf(a.withdrawalsUsd);
  const made = microOf(a.valueUsd) - net;
  return {
    usd: decimalOf(made),
    // Nothing left in, or more taken out than put in: a share of that is no figure.
    pct: net > 0n ? Number(made) / Number(net) : null,
    netInUsd: decimalOf(net),
  };
}

type Unranked = Omit<LeaderboardRow, 'rank'>;

/**
 * The rows in their order (`LEADERBOARD_RULE`), each with its rank from 1. Ties that the rule leaves
 * are put in order by address, so the same rows are always answered in the same order.
 */
export function ranked(rows: readonly Unranked[]): LeaderboardRow[] {
  const group = (row: Unranked) => (row.pnl === null ? 2 : row.pnl.pct === null ? 1 : 0);
  const value = (row: Unranked) => (row.value ? microOf(row.value.usd) : -1n);
  const made = (row: Unranked) => (row.pnl ? microOf(row.pnl.usd) : 0n);
  const sign = (n: bigint) => (n > 0n ? 1 : n < 0n ? -1 : 0);
  const order = [...rows].sort((a, b) => {
    const by = group(a) - group(b);
    if (by !== 0) return by;
    if (group(a) === 0) {
      const pa = a.pnl?.pct ?? 0;
      const pb = b.pnl?.pct ?? 0;
      if (pa !== pb) return pb - pa;
    }
    const dollars = group(a) === 2 ? sign(value(b) - value(a)) : sign(made(b) - made(a));
    if (dollars !== 0) return dollars;
    return a.address < b.address ? -1 : a.address > b.address ? 1 : 0;
  });
  return order.map((row, i) => ({ ...row, rank: i + 1 }));
}

/** What a vault holds at a snapshot, the largest share first, cash as the rest of the value. */
export function holdingsOf(snapshot: {
  valueUsd: string;
  cash: { asset: string };
  positions: readonly { asset: string; weightBps: number }[];
}): LeaderboardHolding[] {
  if (microOf(snapshot.valueUsd) <= 0n) return [];
  const held = snapshot.positions
    .filter((p) => p.weightBps > 0)
    .map((p) => ({ asset: p.asset, weightBps: Math.round(p.weightBps) }));
  const invested = held.reduce((sum, p) => sum + p.weightBps, 0);
  const cash = Math.max(0, 10_000 - invested);
  return [...held, ...(cash > 0 ? [{ asset: snapshot.cash.asset, weightBps: cash }] : [])].sort(
    (a, b) => b.weightBps - a.weightBps || (a.asset < b.asset ? -1 : 1),
  );
}

/** What was taken out of each vault, by address: the dollars of its valued tokens and the unvalued. */
async function takenOutOf(
  db: Db,
  entry: ChainEntry,
  vaultsOf: ReadonlyMap<string, string>,
  countsFrom: ReadonlyMap<string, Date>,
): Promise<Map<string, { micro: bigint; unvalued: number }>> {
  const owners = [...new Set(vaultsOf.values())];
  if (owners.length === 0) return new Map();
  const evm = chainFamily(entry.chain) === 'evm';
  const owner = evm ? orders.ownerEvm : orders.ownerSolana;
  const steps = await db
    .select({ owner, request: orders.request, at: legs.updatedAt, out: legs.withdrawals })
    .from(orders)
    .innerJoin(legs, eq(legs.orderId, orders.id))
    .where(
      and(
        eq(orders.type, 'withdraw'),
        inArray(owner, owners),
        eq(legs.chainId, entry.chain),
        eq(legs.kind, 'withdraw'),
        eq(legs.status, 'confirmed'),
        eq(legs.provenance, entry.provenance),
      ),
    );
  const same = (a: string, b: string) => (evm ? a.toLowerCase() === b.toLowerCase() : a === b);
  const taken = new Map<string, { micro: bigint; unvalued: number }>();
  for (const step of steps) {
    const named = step.request.type === 'withdraw' ? step.request.vaults[0] : undefined;
    const address =
      named && (vaultsOf.has(named) ? named : [...vaultsOf.keys()].find((a) => same(a, named)));
    // A withdrawal counts for the vault it names, and only when its owner is the vault's.
    if (!address || step.owner === null || !same(vaultsOf.get(address) ?? '', step.owner)) continue;
    const from = countsFrom.get(address);
    if (from && step.at < from) continue;
    const sofar = taken.get(address) ?? { micro: 0n, unvalued: 0 };
    for (const token of step.out ?? []) {
      if (token.valued) sofar.micro += microOf(token.valued.usd);
      else sofar.unvalued += 1;
    }
    taken.set(address, sofar);
  }
  return taken;
}

/**
 * Every open vault the server knows on the chain, each with what it made, ranked. A vault is known as
 * the platform's numbers count one (GET /v1/stats): named by the vault cache, or read by the snapshot
 * worker in the last week; and under the label the chain's figures carry here.
 */
export async function leaderboardOf(db: Db, entry: ChainEntry, now: Date) {
  const { chain, provenance } = entry;
  const since = new Date(now.getTime() - SNAPSHOT_LOOKBACK_DAYS * 86_400_000);
  const vs = vaultSnapshots;
  const [cached, seen] = await Promise.all([
    db
      .select({
        address: vaults.address,
        owner: vaults.owner,
        basketId: vaults.onchainBasketId,
      })
      .from(vaults)
      .where(and(eq(vaults.chainId, chain), eq(vaults.provenance, provenance), thisLife(vaults))),
    db
      .selectDistinct({ address: vs.address })
      .from(vs)
      .where(
        and(
          eq(vs.chainId, chain),
          eq(vs.provenance, provenance),
          gt(vs.observedAt, since),
          thisLife(vs),
        ),
      ),
  ]);
  const addresses = [...new Set([...cached.map((v) => v.address), ...seen.map((s) => s.address)])];
  if (addresses.length === 0) return [];

  const [newest, lives, numbered] = await Promise.all([
    // The newest snapshot of each vault in its present life.
    db
      .selectDistinctOn([vs.address], {
        address: vs.address,
        owner: vs.owner,
        basketId: vs.onchainBasketId,
        observedAt: vs.observedAt,
        valueUsd: vs.valueUsd,
        cash: vs.cash,
        positions: vs.positions,
        recipeOnchainId: vs.recipeOnchainId,
        source: vs.source,
        method: vs.method,
      })
      .from(vs)
      .where(
        and(
          eq(vs.chainId, chain),
          eq(vs.provenance, provenance),
          inArray(vs.address, addresses),
          thisLife(vs, vs.observedAt),
        ),
      )
      .orderBy(vs.address, desc(vs.observedAt)),
    lifetimesOf(db, chain, addresses),
    db
      .select({
        address: vaultNumbers.address,
        privyId: users.privyId,
      })
      .from(vaultNumbers)
      .innerJoin(users, eq(users.id, vaultNumbers.userId))
      .where(and(eq(vaultNumbers.chainId, chain), inArray(vaultNumbers.address, addresses))),
  ]);
  const snapshotOf = new Map(newest.map((row) => [row.address, row]));
  const cacheOf = new Map(cached.map((row) => [row.address, row]));
  const countsFrom = new Map(
    [...lives].flatMap(([address, life]) =>
      life.reopenedAt ? [[address, life.reopenedAt] as const] : [],
    ),
  );
  // The person behind each vault, where the server holds exactly one (`vault_numbers`): read to count
  // their deposits as their portfolio does, never answered. Nor is the vault's number, which only its
  // owner is answered (gate VAULT-NUMBER), nor the name its owner typed, which is not on chain.
  const numbersAt = new Map<string, { privyId: string }[]>();
  for (const row of numbered)
    numbersAt.set(row.address, [...(numbersAt.get(row.address) ?? []), row]);
  const onlyOne = (address: string) => {
    const rows = numbersAt.get(address) ?? [];
    return rows.length === 1 ? rows[0] : undefined;
  };

  // What each vault is (its owner and its plan's number on chain): its newest snapshot says, else its
  // cache row, as GET /v1/portfolio/plans reads it.
  const known: NumberedVault[] = addresses.flatMap((address) => {
    const said = snapshotOf.get(address) ?? cacheOf.get(address);
    return said ? [{ address, owner: said.owner, basketId: said.basketId }] : [];
  });

  // Deposits are counted by each owner's orders, as each owner's portfolio counts them. The person
  // behind an owner (read here, never answered) works out the number of an order kept without one.
  const byOwner = new Map<string, NumberedVault[]>();
  for (const vault of known) byOwner.set(vault.owner, [...(byOwner.get(vault.owner) ?? []), vault]);
  const putIns = await Promise.all(
    [...byOwner].map(([owner, theirs]) => {
      const people = new Set(theirs.flatMap((v) => onlyOne(v.address)?.privyId ?? []));
      const privyId = people.size === 1 ? [...people][0] : undefined;
      return putInOf(db, { entry, owners: [owner as Address] }, theirs, privyId, countsFrom);
    }),
  );
  const putIn = new Map(putIns.flatMap((m) => [...m]));
  const [taken, families] = await Promise.all([
    takenOutOf(db, entry, new Map(known.map((v) => [v.address, v.owner])), countsFrom),
    familiesOf(
      db,
      chain,
      newest.flatMap((s) => (s.recipeOnchainId ? [s.recipeOnchainId] : [])),
    ),
  ]);

  const rows = known.map((vault): Omit<LeaderboardRow, 'rank'> => {
    const snapshot = snapshotOf.get(vault.address);
    const value = snapshot
      ? {
          usd: snapshot.valueUsd,
          source: snapshot.source,
          method: snapshot.method,
          fetchedAt: snapshot.observedAt.toISOString(),
          provenance,
        }
      : null;
    const deposits = putIn.get(vault.address);
    const out = taken.get(vault.address) ?? { micro: 0n, unvalued: 0 };
    let pnl: LeaderboardPnl | null = null;
    if (value && deposits) {
      const withdrawalsUsd = decimalOf(out.micro);
      pnl = {
        ...pnlOf({ valueUsd: value.usd, depositsUsd: deposits.usd, withdrawalsUsd }),
        depositsUsd: deposits.usd,
        withdrawalsUsd,
        unvaluedWithdrawals: out.unvalued,
        source: `${deposits.source}; ${value.source}`,
        method: LEADERBOARD_PNL_METHOD,
        // As old as the older of its two reads.
        fetchedAt: deposits.fetchedAt < value.fetchedAt ? deposits.fetchedAt : value.fetchedAt,
        provenance,
      };
    }
    const family = snapshot?.recipeOnchainId ? families.get(snapshot.recipeOnchainId) : undefined;
    return {
      chain,
      address: vault.address,
      owner: shortOwner(vault.owner),
      holdings: snapshot ? holdingsOf(snapshot) : [],
      value,
      pnl,
      noPnl: pnl ? null : value ? 'no_deposit_record' : 'never_read',
      follows: family ? { name: family.name, slug: family.slug } : null,
    };
  });
  return ranked(rows);
}
