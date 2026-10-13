// What the backfill lacks, from its own records (scripts/risk/assets/backfill-status.ts): a UTC day is held only
// when a covered window holds it whole, so a resumed run asks exactly the days missing.
import { describe, expect, it } from 'vitest';
import { daysCovered } from '../../scripts/risk/assets/backfill-status';

const t = (iso: string) => Date.parse(iso) / 1000;

describe('the days a backfill holds and lacks', () => {
  it('holds a day only when one covered window holds it whole', () => {
    const from = t('2026-10-10T00:00:00Z');
    const to = t('2026-10-12T23:59:59Z');
    const covered = [
      { from: t('2026-10-10T00:00:00Z'), to: t('2026-10-10T23:59:59Z') },
      { from: t('2026-10-11T06:00:00Z'), to: t('2026-10-11T23:59:59Z') },
    ];
    expect(daysCovered(covered, from, to)).toEqual({
      have: ['2026-10-10'],
      missing: ['2026-10-11', '2026-10-12'],
    });
  });

  it('counts the window’s partial first and last days by the part inside it', () => {
    const from = t('2026-10-10T12:00:00Z');
    const to = t('2026-10-11T06:00:00Z');
    const covered = [{ from: t('2026-10-10T12:00:00Z'), to: t('2026-10-11T06:00:00Z') }];
    expect(daysCovered(covered, from, to)).toEqual({
      have: ['2026-10-10', '2026-10-11'],
      missing: [],
    });
  });

  it('lacks every day of a subject with no record', () => {
    expect(daysCovered([], t('2026-10-10T00:00:00Z'), t('2026-10-11T23:59:59Z')).missing).toEqual([
      '2026-10-10',
      '2026-10-11',
    ]);
  });
});
