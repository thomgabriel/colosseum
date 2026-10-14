import { type Db, users, vaultLifetimes, vaultNumbers, vaults } from '@colosseum/db';
import { type ChainId, type ClosedVault, chainFamily } from '@colosseum/schemas';
import { and, desc, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import { ownedOn, type PersonScope } from './scope';

// A vault's lives (gate VAULT-CLOSE-REUSE): a person closes an empty vault of theirs, and it leaves
// their lists, sums and histories; opened again, it counts from then on. Nothing of this is on chain:
// the vault stays where it is, empty, at its address. A vault is named by its chain and the address
// as the chain's read gives it, as the cache and the snapshots name it.

/** A vault's lives as the server holds them. No row is a vault in its first life, open. */
export type Lifetime = { closedAt: Date | null; reopenedAt: Date | null };

/** The lives of these vaults of one chain, by address. A vault with no row is not in the map. */
export async function lifetimesOf(
  db: Db,
  chain: ChainId,
  addresses: readonly string[],
): Promise<Map<string, Lifetime>> {
  if (addresses.length === 0) return new Map();
  const rows = await db
    .select({
      address: vaultLifetimes.address,
      closedAt: vaultLifetimes.closedAt,
      reopenedAt: vaultLifetimes.reopenedAt,
    })
    .from(vaultLifetimes)
    .where(and(eq(vaultLifetimes.chainId, chain), inArray(vaultLifetimes.address, [...addresses])));
  return new Map(rows.map((r) => [r.address, { closedAt: r.closedAt, reopenedAt: r.reopenedAt }]));
}

/** Whether a vault is closed now. */
export const isClosed = (life: Lifetime | undefined) => life?.closedAt != null;

/** Closes a vault: from now it is in none of its person's lists. Closing a closed one keeps its time. */
export async function closeVault(
  db: Db,
  chain: ChainId,
  address: string,
  by: string | null,
  now: Date,
): Promise<Lifetime> {
  const [row] = await db
    .insert(vaultLifetimes)
    .values({ chainId: chain, address, closedAt: now, closedBy: by, updatedAt: now })
    .onConflictDoUpdate({
      target: [vaultLifetimes.chainId, vaultLifetimes.address],
      set: { closedAt: now, closedBy: by, updatedAt: now },
      // A second close of a closed vault is the first one: its time stands.
      setWhere: isNull(vaultLifetimes.closedAt),
    })
    .returning({ closedAt: vaultLifetimes.closedAt, reopenedAt: vaultLifetimes.reopenedAt });
  if (row) return row;
  const [kept] = await db
    .select({ closedAt: vaultLifetimes.closedAt, reopenedAt: vaultLifetimes.reopenedAt })
    .from(vaultLifetimes)
    .where(and(eq(vaultLifetimes.chainId, chain), eq(vaultLifetimes.address, address)));
  if (!kept) throw new Error('a closed vault has no row');
  return kept;
}

/**
 * Opens a vault again: it is back in its person's lists, and its deposits, withdrawals and snapshots
 * count from now on. Opening one that is open starts nothing new.
 */
export async function reopenVault(
  db: Db,
  chain: ChainId,
  address: string,
  now: Date,
): Promise<Lifetime> {
  const [row] = await db
    .update(vaultLifetimes)
    .set({ closedAt: null, closedBy: null, reopenedAt: now, updatedAt: now })
    .where(
      and(
        eq(vaultLifetimes.chainId, chain),
        eq(vaultLifetimes.address, address),
        isNotNull(vaultLifetimes.closedAt),
      ),
    )
    .returning({ closedAt: vaultLifetimes.closedAt, reopenedAt: vaultLifetimes.reopenedAt });
  if (row) return row;
  return (
    (await lifetimesOf(db, chain, [address])).get(address) ?? { closedAt: null, reopenedAt: null }
  );
}

/**
 * The vaults the person closed, newest close first: those the cache holds as theirs on a chain of
 * their scope (`ownedOn`), with the name they gave each and its number.
 */
export async function closedVaultsOf(
  db: Db,
  scope: PersonScope,
  privyId: string | undefined,
): Promise<ClosedVault[]> {
  if (scope.chains.length === 0) return [];
  const rows = await db
    .select({
      chain: vaults.chainId,
      address: vaults.address,
      name: vaults.name,
      provenance: vaults.provenance,
      closedAt: vaultLifetimes.closedAt,
    })
    .from(vaults)
    .innerJoin(
      vaultLifetimes,
      and(eq(vaultLifetimes.chainId, vaults.chainId), eq(vaultLifetimes.address, vaults.address)),
    )
    .where(
      and(
        isNotNull(vaultLifetimes.closedAt),
        or(...scope.chains.map((scoped) => ownedOn(vaults, scoped))),
      ),
    )
    .orderBy(desc(vaultLifetimes.closedAt));
  const numbers = new Map<string, number>();
  if (privyId && rows.length) {
    const held = await db
      .select({
        chain: vaultNumbers.chainId,
        address: vaultNumbers.address,
        number: vaultNumbers.number,
      })
      .from(vaultNumbers)
      .innerJoin(users, eq(users.id, vaultNumbers.userId))
      .where(eq(users.privyId, privyId));
    for (const row of held) numbers.set(keyOf(row.chain, row.address), row.number);
  }
  const names = new Map(scope.chains.map((s) => [s.entry.chain, s.entry.config.name]));
  return rows.flatMap((row) => {
    if (!row.closedAt) return [];
    const number = numbers.get(keyOf(row.chain, row.address));
    return [
      {
        chain: row.chain,
        chainName: names.get(row.chain) ?? row.chain,
        address: row.address,
        name: row.name,
        ...(number === undefined ? {} : { number }),
        closedAt: row.closedAt.toISOString(),
        provenance: row.provenance,
      },
    ];
  });
}

/** A vault as it is told from every other: an EVM address in any case is one address. */
const keyOf = (chain: ChainId, address: string) =>
  `${chain}:${chainFamily(chain) === 'evm' ? address.toLowerCase() : address}`;
