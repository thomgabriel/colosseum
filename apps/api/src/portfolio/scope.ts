import { type Db, vaultLifetimes } from '@colosseum/db';
import {
  type Address,
  type ChainId,
  type ChainUnavailable,
  normalizeAddress,
  type Principal,
} from '@colosseum/schemas';
import { type AnyColumn, and, eq, inArray, type SQL, sql } from 'drizzle-orm';
import type { ChainEntry, ChainRegistry } from '../orders/chains';
import { chainsHeld } from '../orders/person';

// Whose rows a route of the portfolio section may read (PORT-2). The four routes answer from the
// database alone, so nothing but this file stands between a caller and another person's history: a
// row is the caller's when its owner is one of the wallets of their verified identity token, on a
// chain this server runs, under the label that chain's figures carry here. Every query of those
// routes takes its `where` from `ownedOn`.

/** One chain of the person's that this server runs. */
export type ScopedChain = {
  entry: ChainEntry;
  /** The person's wallets on the chain's family. Never empty. */
  owners: Address[];
};

export type PersonScope = {
  /** In the server's order, as GET /v1/portfolio lists them. */
  chains: ScopedChain[];
  /** The chains the person holds a wallet for that are switched off here. */
  unavailable: ChainUnavailable[];
};

/**
 * The chains a signed-in person's rows are read on, each with the person's wallets there, and the
 * chains of theirs this server does not run. `only` narrows both to one chain.
 */
export function personScope(
  registry: ChainRegistry,
  principal: Principal,
  only?: ChainId,
): PersonScope {
  const held = chainsHeld(principal).filter((chain) => only === undefined || chain === only);
  const active = registry.active();
  const on = new Set(active.map((entry) => entry.chain));
  return {
    chains: active
      .filter((entry) => held.includes(entry.chain))
      .map((entry) => ({
        entry,
        owners: principal.wallets
          .filter((w) => w.family === entry.config.family)
          .map((w) => w.address),
      })),
    unavailable: held
      .filter((chain) => !on.has(chain))
      .map((chain) => ({
        chain,
        name: registry.name(chain),
        code: 'CHAIN_UNAVAILABLE',
        error: `${registry.name(chain)} is switched off on this server`,
        retryable: false,
      })),
  };
}

/**
 * The rows of a table that are the person's on one chain: the chain's, owned by one of their wallets,
 * and read under the label the chain has on this server. A database can hold rows read from the mock
 * beside rows read from a test network, and a mock row is never answered as a test network's.
 * `vaults` and `vault_snapshots` both fit.
 */
export function ownedOn(
  table: { chainId: AnyColumn; owner: AnyColumn; provenance: AnyColumn },
  scoped: ScopedChain,
): SQL {
  const mine = and(
    eq(table.chainId, scoped.entry.chain),
    inArray(table.owner, scoped.owners),
    eq(table.provenance, scoped.entry.provenance),
  );
  if (!mine) throw new Error('no scope');
  return mine;
}

/**
 * `ownedOn`, and only of the person's vaults that are open, in their present life (gate
 * `VAULT-CLOSE-REUSE`): a vault its person closed is in no list, sum or history, and a row read before
 * the vault was last reopened (`at`, a snapshot's time) belongs to the life before. Every query of the
 * portfolio section's lists, sums and histories reads by this; a vault's number (`numbers.ts`) still
 * reads by `ownedOn`, as a closed vault keeps its number.
 */
export function openOn(
  table: { chainId: AnyColumn; owner: AnyColumn; provenance: AnyColumn; address: AnyColumn },
  scoped: ScopedChain,
  at?: AnyColumn,
): SQL {
  const both = and(ownedOn(table, scoped), thisLife(table, at));
  if (!both) throw new Error('no scope');
  return both;
}

/**
 * Whether the database has `vault_lifetimes` (migration 0025, gate VAULT-CLOSE-REUSE). A server that
 * starts before the migration is applied reads every vault as open, in its first life, and answers a
 * close or a reopen 503, rather than fail every read of the portfolio on a table that is not there.
 * Read once the server is ready (`noteLifetimes`); assumed there until then.
 */
let lifetimesHeld = true;
export const lifetimesReady = () => lifetimesHeld;

/** Asks the database whether `vault_lifetimes` is there. A database that does not answer changes nothing. */
export async function noteLifetimes(db: Db): Promise<boolean> {
  try {
    const [row] = await db.execute<{ t: string | null }>(
      sql`select to_regclass('public.vault_lifetimes')::text as t`,
    );
    lifetimesHeld = row?.t != null;
  } catch {
    // no answer: the reads that need it fail on their own, and say so
  }
  return lifetimesHeld;
}

/**
 * A row of a vault that is open, in its present life: not closed, and, where `at` names the row's
 * time, read since the vault was last reopened. Whoever the vault is whose (the platform's counts).
 */
export function thisLife(table: { chainId: AnyColumn; address: AnyColumn }, at?: AnyColumn): SQL {
  // Until migration 0025 is applied the table is not there, and no vault is closed: nothing to cut.
  if (!lifetimesHeld) return sql`true`;
  const l = vaultLifetimes;
  const ended = at
    ? sql`(${l.closedAt} is not null or ${l.reopenedAt} > ${at})`
    : sql`${l.closedAt} is not null`;
  return sql`not exists (select 1 from ${l} where ${l.chainId} = ${table.chainId} and ${l.address} = ${table.address} and ${ended})`;
}

/**
 * The vault address a query named, in the form the chain's rows hold it: an EVM address is taken in
 * any case and lower-cased, as the rest of the API takes one (`sameVaultAddress`). Null when it is not
 * an address of the chain's family at all: the chain then answers nothing, and the text is never
 * handed to the database.
 */
export function addressOn(scoped: ScopedChain, address: string): Address | null {
  try {
    return normalizeAddress(scoped.entry.config.family, address);
  } catch {
    return null;
  }
}

/** What a chain's entry in an answer opens with. */
export const frame = (entry: ChainEntry) => ({
  chain: entry.chain,
  name: entry.config.name,
  provenance: entry.provenance,
});
