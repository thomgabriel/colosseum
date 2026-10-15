import { describe, expect, it } from 'vitest';
import {
  ago,
  type DraftRow,
  groupByDay,
  matching,
  mergeRows,
  SEARCH_FROM,
  type VaultRow,
} from './conversation-list';

// What the conversations panel lists, in what order and under which day (Thom, Oct 14).

const at = (iso: string) => Date.parse(iso);
const draft = (id: string, when: string | null, more: Partial<DraftRow> = {}): DraftRow => ({
  kind: 'draft',
  key: `draft:solana:${id}`,
  chain: 'solana',
  base: 'base',
  id,
  title: id,
  at: when === null ? null : at(when),
  current: false,
  planId: null,
  kept: true,
  depositing: false,
  ...more,
});
const vault = (address: string, when: string | null, more: Partial<VaultRow> = {}): VaultRow => ({
  kind: 'vault',
  key: `vault:solana:${address}`,
  chain: 'solana',
  address,
  title: `Vault ${address}`,
  at: when === null ? null : at(when),
  current: false,
  value: null,
  planId: null,
  ...more,
});

describe('mergeRows', () => {
  it('puts the one on screen first, then the rest newest first, and one with no time last', () => {
    const rows = mergeRows(
      [
        draft('old', '2026-10-01T10:00:00Z'),
        draft('none', null),
        draft('here', '2026-09-01T10:00:00Z', { current: true }),
      ],
      [vault('v1', '2026-10-10T10:00:00Z')],
    );
    expect(rows.map((row) => row.key)).toEqual([
      'draft:solana:here',
      'vault:solana:v1',
      'draft:solana:old',
      'draft:solana:none',
    ]);
  });

  it('lists a draft a deposit went from as the vault it opened, at the later of the two times', () => {
    const rows = mergeRows(
      [draft('went', '2026-10-12T09:00:00Z', { planId: 'plan-1' }), draft('other', null)],
      [vault('v1', '2026-10-11T09:00:00Z', { planId: 'plan-1' })],
    );
    expect(rows.map((row) => row.key)).toEqual(['vault:solana:v1', 'draft:solana:other']);
    expect(rows[0]?.at).toBe(at('2026-10-12T09:00:00Z'));
  });

  it('keeps a draft whose plan opened no vault that is listed, and the one on screen whatever it led to', () => {
    const rows = mergeRows(
      [
        draft('waiting', '2026-10-12T09:00:00Z', { planId: 'plan-2' }),
        draft('here', '2026-10-12T10:00:00Z', { planId: 'plan-1', current: true }),
      ],
      [vault('v1', '2026-10-11T09:00:00Z', { planId: 'plan-1' })],
    );
    expect(rows.map((row) => row.key)).toEqual([
      'draft:solana:here',
      'draft:solana:waiting',
      'vault:solana:v1',
    ]);
  });

  it('keeps a draft whose deposit’s ids are still kept beside it, whatever vault its plan opened', () => {
    const rows = mergeRows(
      [draft('mid', '2026-10-12T09:00:00Z', { planId: 'plan-1', depositing: true })],
      [vault('v1', '2026-10-11T09:00:00Z', { planId: 'plan-1' })],
    );
    expect(rows.map((row) => row.key)).toEqual(['draft:solana:mid', 'vault:solana:v1']);
  });

  it('lists a draft named twice once', () => {
    const rows = mergeRows(
      [draft('a', '2026-10-12T09:00:00Z'), draft('a', '2026-10-12T09:00:00Z')],
      [],
    );
    expect(rows).toHaveLength(1);
  });
});

describe('groupByDay', () => {
  // a clock in the middle of a local day, so the test means the same in any time zone
  const now = new Date(2026, 9, 14, 12, 0).getTime();
  const local = (day: number, hour: number) => new Date(2026, 9, day, hour, 30).toISOString();

  it('sorts rows into today, yesterday and earlier by the day of this browser’s clock', () => {
    const groups = groupByDay(
      [
        draft('morning', local(14, 0)),
        draft('late', local(13, 23)),
        draft('early', local(13, 0)),
        draft('before', local(12, 23)),
        draft('none', null),
        draft('here', local(1, 1), { current: true }),
      ],
      now,
    );
    expect(groups.today.map((row) => row.key.split(':').at(-1))).toEqual(['morning', 'here']);
    expect(groups.yesterday.map((row) => row.key.split(':').at(-1))).toEqual(['late', 'early']);
    expect(groups.earlier.map((row) => row.key.split(':').at(-1))).toEqual(['before', 'none']);
  });

  it('counts a time ahead of the clock, from another device, as today', () => {
    expect(groupByDay([draft('ahead', local(15, 9))], now).today).toHaveLength(1);
  });
});

describe('matching', () => {
  const rows = [
    draft('a', null, { title: 'Proteger minhas economias' }),
    draft('b', null, { title: 'Grow $100 in technology stocks' }),
    vault('v', null, { title: 'Grow $2,000 over 36 months.' }),
  ];

  it('keeps every row for an empty search', () => {
    expect(matching(rows, '  ')).toHaveLength(3);
  });

  it('keeps the rows whose name holds every word, in any case, order or accent', () => {
    expect(matching(rows, 'grow').map((row) => row.key)).toEqual([
      'draft:solana:b',
      'vault:solana:v',
    ]);
    expect(matching(rows, 'STOCKS grow').map((row) => row.key)).toEqual(['draft:solana:b']);
    expect(matching(rows, 'economías').map((row) => row.key)).toEqual(['draft:solana:a']);
    expect(matching(rows, 'gold')).toEqual([]);
  });

  it('draws the search from more than eight rows', () => {
    expect(SEARCH_FROM).toBe(9);
  });
});

describe('ago', () => {
  const now = new Date(2026, 9, 14, 12, 0).getTime();
  const minutes = (n: number) => now - n * 60_000;

  it('says how long ago in the person’s language', () => {
    expect(ago(now - 20_000, now, 'en-US')).toBe('now');
    expect(ago(minutes(5), now, 'en-US')).toBe('5 minutes ago');
    expect(ago(minutes(180), now, 'en-US')).toBe('3 hours ago');
    expect(ago(new Date(2026, 9, 13, 9).getTime(), now, 'en-US')).toBe('yesterday');
    expect(ago(new Date(2026, 9, 6, 9).getTime(), now, 'en-US')).toBe('8 days ago');
    expect(ago(new Date(2026, 6, 1, 9).getTime(), now, 'en-US')).toBe('3 months ago');
    expect(ago(minutes(5), now, 'pt-BR')).toBe('há 5 minutos');
  });

  it('says a time ahead of the clock is now', () => {
    expect(ago(now + 3_600_000, now, 'en-US')).toBe('now');
  });
});
