import type { ConstraintSheet } from '@colosseum/schemas';

const ym = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
export const currentMonth = () => ym(new Date());

/** Months between two YYYY-MM strings (b - a). */
export function monthsBetween(a: string, b: string): number {
  const [ay, am] = a.split('-').map(Number) as [number, number];
  const [by, bm] = b.split('-').map(Number) as [number, number];
  return (by - ay) * 12 + (bm - am);
}

/** BRL withdrawals per month index (0 = this month) over `months` months, from the constraint sheet. */
export function obligationsBrl(
  sheet: ConstraintSheet,
  months: number,
  nowMonth = currentMonth(),
): number[] {
  const out = new Array<number>(months).fill(0);
  const t = sheet.target;
  if (t.kind === 'monthly_cashflow') {
    const start = Math.max(0, monthsBetween(nowMonth, t.startMonth));
    const end = t.endMonth ? monthsBetween(nowMonth, t.endMonth) : months - 1;
    for (let i = start; i <= Math.min(end, months - 1); i++) out[i] = t.amountBrl;
  } else {
    const at = monthsBetween(nowMonth, t.byMonth);
    if (at >= 0 && at < months) out[at] = t.amountBrl;
  }
  return out;
}

export const sumUsd = (brl: number[], fxUsdBrl: number) =>
  brl.reduce((s, x) => s + x, 0) / fxUsdBrl;
