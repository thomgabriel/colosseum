import { IDLE_TIMEOUT_S, idleOptions, POOL_MAX_LIMIT, poolOptions } from '@colosseum/db';
import { describe, expect, it } from 'vitest';

// How the database client is opened (packages/db/src/pool.ts): the pool's size and whether statements
// are prepared, set from the environment so a hosted pooler's mode needs no change of code.

describe('the database pool, from the environment', () => {
  it('passes the driver nothing when neither is set, so the address and the driver decide as before', () => {
    expect(poolOptions({})).toEqual({});
    expect(poolOptions({ DB_POOL_MAX: ' ', DB_PGBOUNCER: '' })).toEqual({});
    // no key at all: `{ max: undefined }` would still override `?max=` in the address
    expect(Object.keys(poolOptions({}))).toEqual([]);
  });

  it('passes only what is set', () => {
    expect(poolOptions({ DB_POOL_MAX: '4' })).toEqual({ max: 4 });
    expect(poolOptions({ DB_POOL_MAX: String(POOL_MAX_LIMIT) })).toEqual({ max: POOL_MAX_LIMIT });
    expect(poolOptions({ DB_PGBOUNCER: 'transaction' })).toEqual({ prepare: false });
    expect(poolOptions({ DB_PGBOUNCER: 'Transaction ' })).toEqual({ prepare: false });
    // said outright, session mode is passed too: it is what the person asked for
    expect(poolOptions({ DB_PGBOUNCER: 'session' })).toEqual({ prepare: true });
    expect(poolOptions({ DB_POOL_MAX: '3', DB_PGBOUNCER: 'transaction' })).toEqual({
      max: 3,
      prepare: false,
    });
  });

  it('stops on a value it cannot read, naming the variable and never guessing', () => {
    for (const value of ['0', '-1', '2.5', 'ten', String(POOL_MAX_LIMIT + 1)])
      expect(() => poolOptions({ DB_POOL_MAX: value }), value).toThrow(/DB_POOL_MAX/);
    for (const value of ['true', '1', 'statement', 'yes'])
      expect(() => poolOptions({ DB_PGBOUNCER: value }), value).toThrow(/DB_PGBOUNCER/);
  });

  it('closes a connection left idle a minute, unless the address or the driver variable says otherwise', () => {
    const url = 'postgres://u:p@localhost:5432/db';
    expect(IDLE_TIMEOUT_S).toBe(60);
    expect(idleOptions(url, {})).toEqual({ idle_timeout: 60 });
    expect(idleOptions(`${url}?max=2&search_path=x`, {})).toEqual({ idle_timeout: 60 });
    // the address or PGIDLE_TIMEOUT decide: no key at all, so the driver reads them
    expect(Object.keys(idleOptions(`${url}?idle_timeout=5`, {}))).toEqual([]);
    expect(Object.keys(idleOptions(url, { PGIDLE_TIMEOUT: '300' }))).toEqual([]);
    expect(idleOptions(url, { PGIDLE_TIMEOUT: ' ' })).toEqual({ idle_timeout: 60 });
  });
});
