// @vitest-environment happy-dom

import { act, createElement, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, unmountAll } from '../../components/ui/test/dom';
import { useBearing } from './BearingProvider';
import { R, type Reader, type Res, resOf } from './data';
import type { LendRow } from './lending';
import { onSnapshot } from './test/cases';

// The lending pools read in one answer (`GET /risk/lending`), and each pool on its own where the API
// has no such route or a part of a pool failed: a failure is asked again, as a pool's own read is.

const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/analytics/lending',
  useRouter: () => router,
}));

vi.mock('next/link', async () => {
  const { createElement: h } = await import('react');
  return {
    default: ({ href, children, ...rest }: { href: string; children: unknown }) =>
      h('a', { href, ...rest }, children as never),
  };
});

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, '', '/analytics/lending?chain=solana');
});
afterEach(unmountAll);

const part = (account: string, status = 200) => ({
  status,
  body: status === 200 ? { account, from: 'one answer' } : { error: 'down' },
});
const pool = (account: string, sheetStatus = 200) => ({
  account,
  sheet: part(account, sheetStatus),
  h7: part(account),
  h30: part(account),
});

/** A reader of the lending routes, which says what it was asked. */
function readerOf(all: { status: number; body: unknown }) {
  const read: string[] = [];
  const reader: Reader & { read: string[] } = {
    read,
    probe: async () => true,
    get: async <T>(path: string) => {
      read.push(path);
      if (path === R.lendList())
        return resOf(200, { pools: [{ account: 'P1' }, { account: 'P2' }] }) as Res<T>;
      if (path === R.lendAll()) return resOf(all.status, all.body) as Res<T>;
      if (path.startsWith('/risk/facts/lending/'))
        return resOf(200, { account: path, from: 'its own read' }) as Res<T>;
      return resOf(404, { message: `Route GET:${path} not found` }) as Res<T>;
    },
  };
  return { reader, read };
}

async function rowsOf(reader: Reader & { read: string[] }) {
  let rows: LendRow[] | null = null;
  function Page() {
    const { lending } = useBearing();
    useEffect(() => {
      lending().then((r) => {
        rows = r;
      });
    }, [lending]);
    return null;
  }
  await mount(onSnapshot(createElement(Page), reader));
  for (let i = 0; i < 300 && !rows; i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  if (!rows) throw new Error('the pools never came');
  return rows as LendRow[];
}
const own = (read: string[]) => read.filter((p) => p.startsWith('/risk/facts/lending/'));
const from = (r: Res) => (r.ok ? (r.body as { from: string }).from : null);

describe('the lending pools', () => {
  it('come from one answer, and no pool is read on its own', async () => {
    const { reader, read } = readerOf({
      status: 200,
      body: { pools: [pool('P1'), pool('P2')] },
    });
    const rows = await rowsOf(reader);
    expect(rows.map((r) => from(r.sheet))).toEqual(['one answer', 'one answer']);
    expect(own(read)).toEqual([]);
  });

  it('are each read on their own where the API has no such route', async () => {
    const { reader, read } = readerOf({
      status: 404,
      body: { message: 'Route GET:/risk/lending not found' },
    });
    const rows = await rowsOf(reader);
    expect(rows.map((r) => from(r.sheet))).toEqual(['its own read', 'its own read']);
    expect(own(read)).toHaveLength(6);
  });

  it('a pool with a part that failed is read on its own, the others kept from the answer', async () => {
    const { reader, read } = readerOf({
      status: 207,
      body: { pools: [pool('P1'), pool('P2', 500)] },
    });
    const rows = await rowsOf(reader);
    expect(rows.map((r) => from(r.sheet))).toEqual(['one answer', 'its own read']);
    expect(own(read)).toEqual([R.lend('P2'), R.lendH('P2', 7), R.lendH('P2', 30)]);
  });
});
