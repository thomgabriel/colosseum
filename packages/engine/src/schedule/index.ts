import type {
  Asset,
  ConstraintSheet,
  PlanLeg,
  ScheduleRow,
  StressCase,
  YieldObservation,
} from '@colosseum/schemas';
import { currentMonth, monthsBetween, obligationsBrl } from '../solver/obligations';

/** Stress parameters are policy inputs, not forecasts. */
export const STRESS_PARAMS = {
  yieldsFallFraction: 0.5,
  fxMoveFraction: 0.2,
  fxMoveMonths: 12,
  creditGateMonths: 6,
  equityDrawdownFraction: 0.2,
};

export type ScheduleInput = {
  sheet: ConstraintSheet;
  legs: PlanLeg[];
  assets: Map<string, Asset>;
  yields: Map<string, YieldObservation>;
  capitalUsd: number;
  fxUsdBrl: number;
  nowMonth?: string;
  months?: number;
};

export type StressSpec = { id: string; name: string; params: Record<string, number> };

export const STRESSES = (holdsEquity: boolean): StressSpec[] => [
  {
    id: 'yields_fall',
    name: 'Yields fall',
    params: { fraction: STRESS_PARAMS.yieldsFallFraction },
  },
  {
    id: 'brl_appreciates',
    name: 'BRL appreciates vs USD',
    params: { fraction: STRESS_PARAMS.fxMoveFraction, months: STRESS_PARAMS.fxMoveMonths },
  },
  {
    id: 'brl_depreciates',
    name: 'BRL depreciates vs USD',
    params: { fraction: STRESS_PARAMS.fxMoveFraction, months: STRESS_PARAMS.fxMoveMonths },
  },
  {
    id: 'credit_gate',
    name: 'Credit leg gated (redemption frozen)',
    params: { months: STRESS_PARAMS.creditGateMonths },
  },
  ...(holdsEquity
    ? [
        {
          id: 'equity_drawdown',
          name: 'Equity drawdown',
          params: { fraction: STRESS_PARAMS.equityDrawdownFraction },
        },
      ]
    : []),
];

export type ScheduleResult = {
  rows: ScheduleRow[];
  liquidityOk: boolean;
  summary: {
    monthsFunded: number;
    monthsTotal: number;
    shortfallBrl: number;
    terminalBalanceBrl: number;
    targetMet: boolean | null;
  };
};

/**
 * Month-by-month simulation in BRL. Each leg holds USD value (the BRL leg holds BRL). Monthly: yields accrue on
 * haircut rates (stocks and the BRL leg accrue nothing), contributions arrive, the withdrawal is drawn from the
 * BRL leg, then cash, then liquid USD legs pro rata; gated legs cannot be drawn. A month is `liquidityOk` when
 * the withdrawal is fully funded. No price appreciation is assumed for stocks (they pay no income); stresses only cut.
 */
export function buildSchedule(input: ScheduleInput, stress?: StressSpec): ScheduleResult {
  const { sheet, legs, assets, capitalUsd } = input;
  const nowMonth = input.nowMonth ?? currentMonth();
  const months = input.months ?? Math.min(sheet.horizonMonths, 360);
  const withdrawals = obligationsBrl(sheet, months, nowMonth);
  const yieldFactor = stress?.id === 'yields_fall' ? 1 - (stress.params.fraction ?? 0) : 1;
  const gateMonths = stress?.id === 'credit_gate' ? (stress.params.months ?? 0) : 0;
  const fxAt = (m: number) => {
    if (stress?.id === 'brl_appreciates' || stress?.id === 'brl_depreciates') {
      const f = stress.params.fraction ?? 0;
      const n = stress.params.months ?? 1;
      const done = Math.min(1, (m + 1) / n);
      return input.fxUsdBrl * (1 + (stress.id === 'brl_depreciates' ? f : -f) * done);
    }
    return input.fxUsdBrl;
  };

  // State: USD value per non-BRL leg; BRL value of the BRL leg.
  const usd = new Map<string, number>();
  let brlLeg = 0;
  for (const l of legs) {
    const a = assets.get(l.assetId);
    if (!a) continue;
    if (a.kind === 'brl_stable') brlLeg += l.weight * capitalUsd * input.fxUsdBrl;
    else usd.set(l.assetId, (usd.get(l.assetId) ?? 0) + l.weight * capitalUsd);
  }
  if (stress?.id === 'equity_drawdown') {
    for (const [id, v] of usd)
      if (assets.get(id)?.kind === 'equity') usd.set(id, v * (1 - (stress.params.fraction ?? 0)));
  }

  const rows: ScheduleRow[] = [];
  let shortfallBrl = 0;
  let monthsFunded = 0;
  for (let m = 0; m < months; m++) {
    const fx = fxAt(m);
    // accrue
    for (const [id, v] of usd) {
      const a = assets.get(id);
      const gated = gateMonths > 0 && m < gateMonths && a?.metadata.creditLeg;
      const y =
        a?.kind === 'usd_yield' && !gated
          ? (input.yields.get(id)?.haircutYield ?? 0) * yieldFactor
          : 0;
      usd.set(id, v * (1 + y / 12));
    }
    if (sheet.monthlyContributionBrl)
      usd.set('usdc', (usd.get('usdc') ?? 0) + sheet.monthlyContributionBrl / fx);
    // withdraw
    let need = withdrawals[m] ?? 0;
    const w = need;
    const takeBrl = Math.min(brlLeg, need);
    brlLeg -= takeBrl;
    need -= takeBrl;
    if (need > 0) {
      const cash = usd.get('usdc') ?? 0;
      const takeUsd = Math.min(cash, need / fx);
      usd.set('usdc', cash - takeUsd);
      need -= takeUsd * fx;
    }
    if (need > 0) {
      const liquid = [...usd.entries()].filter(([id]) => {
        const a = assets.get(id);
        const gated = gateMonths > 0 && m < gateMonths && a?.metadata.creditLeg;
        return id !== 'usdc' && a?.mintPath !== 'unavailable' && !gated;
      });
      const total = liquid.reduce((s, [, v]) => s + v, 0);
      const takeUsd = Math.min(total, need / fx);
      if (total > 0) for (const [id, v] of liquid) usd.set(id, v - (v / total) * takeUsd);
      need -= takeUsd * fx;
    }
    const funded = need <= 1e-6;
    if (funded) monthsFunded++;
    else shortfallBrl += need;
    const balanceUsd = [...usd.values()].reduce((s, v) => s + v, 0) + brlLeg / fx;
    rows.push({
      month: addMonths(nowMonth, m),
      withdrawalBrl: Math.round(w * 100) / 100,
      balanceUsd: Math.round(balanceUsd * 100) / 100,
      balanceBrl: Math.round(balanceUsd * fx * 100) / 100,
      fxUsdBrl: Math.round(fx * 10_000) / 10_000,
      liquidityOk: funded,
    });
  }
  const last = rows[rows.length - 1];
  const terminalBalanceBrl = last?.balanceBrl ?? 0;
  const t = sheet.target;
  let targetMet: boolean | null = null;
  if (t.kind === 'balance') {
    const at = monthsBetween(nowMonth, t.byMonth);
    const row = rows[Math.min(Math.max(at, 0), rows.length - 1)];
    targetMet = (row?.balanceBrl ?? 0) + (row?.withdrawalBrl ?? 0) >= t.amountBrl;
  }
  return {
    rows,
    liquidityOk: monthsFunded === months,
    summary: {
      monthsFunded,
      monthsTotal: months,
      shortfallBrl: Math.round(shortfallBrl * 100) / 100,
      terminalBalanceBrl,
      targetMet,
    },
  };
}

/** Base case plus every applicable stress. */
export function buildScheduleWithStresses(input: ScheduleInput): {
  base: ScheduleResult;
  stresses: StressCase[];
  stressSummaries: Array<{ id: string; name: string; summary: ScheduleResult['summary'] }>;
} {
  const holdsEquity = input.legs.some((l) => input.assets.get(l.assetId)?.kind === 'equity');
  const base = buildSchedule(input);
  const stresses: StressCase[] = [];
  const stressSummaries = [];
  for (const s of STRESSES(holdsEquity)) {
    const r = buildSchedule(input, s);
    stresses.push({
      id: s.id,
      name: s.name,
      params: s.params,
      rows: r.rows,
      liquidityOk: r.liquidityOk,
    });
    stressSummaries.push({ id: s.id, name: s.name, summary: r.summary });
  }
  return { base, stresses, stressSummaries };
}

export function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

export function scheduleToCsv(rows: ScheduleRow[]): string {
  const head = 'month,withdrawal_brl,balance_usd,balance_brl,fx_usd_brl,liquidity_ok';
  return [
    head,
    ...rows.map((r) =>
      [
        r.month,
        r.withdrawalBrl,
        r.balanceUsd,
        r.balanceBrl,
        r.fxUsdBrl,
        r.liquidityOk ? 1 : 0,
      ].join(','),
    ),
  ].join('\n');
}
