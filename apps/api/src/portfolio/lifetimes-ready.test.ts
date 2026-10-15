import type { Db } from '@colosseum/db';
import { vaults } from '@colosseum/db';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it } from 'vitest';
import { closedVaultsOf, lifetimesOf } from './lifetimes';
import { lifetimesReady, noteLifetimes, thisLife } from './scope';

// A server whose database has no `vault_lifetimes` yet (migration 0025 not applied) reads every vault
// as open, in its first life, instead of failing every read of the portfolio (gate VAULT-CLOSE-REUSE).

const answering = (t: string | null) =>
  ({
    execute: async () => [{ t }],
    select: () => {
      throw new Error('no read');
    },
  }) as unknown as Db;
const sqlOf = (q: ReturnType<typeof thisLife>) => new PgDialect().sqlToQuery(q).sql;

afterEach(async () => {
  await noteLifetimes(answering('vault_lifetimes'));
});

describe('before the table of closed vaults is there', () => {
  it('cuts nothing, reads nothing of it, and says so', async () => {
    expect(await noteLifetimes(answering(null))).toBe(false);
    expect(lifetimesReady()).toBe(false);
    expect(sqlOf(thisLife(vaults))).toBe('true');
    // no query is made of a table that is not there
    expect(await lifetimesOf(answering(null), 'solana', ['a'])).toEqual(new Map());
    expect(
      await closedVaultsOf(answering(null), { chains: [{} as never], unavailable: [] }, 'p'),
    ).toEqual([]);
  });

  it('reads it once it is there, and keeps what it knew when the database does not answer', async () => {
    expect(await noteLifetimes(answering('vault_lifetimes'))).toBe(true);
    expect(sqlOf(thisLife(vaults))).toContain('vault_lifetimes');
    const down = { execute: async () => Promise.reject(new Error('down')) } as unknown as Db;
    expect(await noteLifetimes(down)).toBe(true);
  });
});
