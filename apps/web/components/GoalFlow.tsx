'use client';
import { useWallet } from '@solana/wallet-adapter-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { API } from '@/lib/api';

type Sheet = Record<string, unknown> & { target?: Record<string, unknown> };
type GoalResponse = {
  goalId: string;
  sheet: Sheet | null;
  candidate: Sheet;
  validationErrors: Array<{ path: string; message: string }>;
  parser: { method: string; model?: string };
};

const EXAMPLES = [
  'R$3.000 por mês a partir de 2028, resgate em até 7 dias',
  'R$250 mil em 3 anos, aceito risco de crédito',
  'Grow to R$500k in 5 years, I accept stock market risk and credit risk, I can wait 30 days to withdraw',
];

/** Hero flow: goal text → parsed constraint sheet (editable) → plan. The solver runs only on a sheet the API validated. */
export function GoalFlow() {
  const { publicKey } = useWallet();
  const router = useRouter();
  const [text, setText] = useState(EXAMPLES[0] ?? '');
  const [capital, setCapital] = useState('100000');
  const [goal, setGoal] = useState<GoalResponse | null>(null);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [errors, setErrors] = useState<Array<{ path: string; message: string }>>([]);
  const [busy, setBusy] = useState<string | null>(null);

  async function parse() {
    setBusy('parsing');
    setErrors([]);
    const res = await fetch(`${API}/goals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, wallet: publicKey?.toBase58() }),
    });
    const d = (await res.json()) as GoalResponse;
    setGoal(d);
    setSheet(d.sheet ?? d.candidate);
    setErrors(d.validationErrors);
    setBusy(null);
  }

  async function plan() {
    if (!goal || !sheet) return;
    setBusy('solving');
    setErrors([]);
    const res = await fetch(`${API}/plans`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        goalId: goal.goalId,
        sheet,
        capitalUsd: Number(capital),
        wallet: publicKey?.toBase58(),
      }),
    });
    const d = (await res.json()) as {
      id?: string;
      error?: string;
      details?: unknown;
      message?: string;
    };
    setBusy(null);
    if (!res.ok || !d.id) {
      setErrors([{ path: '', message: d.message ?? d.error ?? `HTTP ${res.status}` }]);
      return;
    }
    router.push(`/plans/${d.id}`);
  }

  const set = (path: string, value: unknown) =>
    setSheet((s) => {
      if (!s) return s;
      if (path.startsWith('target.'))
        return { ...s, target: { ...(s.target ?? {}), [path.slice(7)]: value } };
      return { ...s, [path]: value };
    });

  const field = (
    label: string,
    path: string,
    value: unknown,
    kind: 'text' | 'number' | 'select' = 'text',
    options: string[] = [],
  ) => (
    <label key={path} htmlFor={`f-${path}`} className="block text-sm">
      <span className="text-gray-500">{label}</span>
      {kind === 'select' ? (
        <select
          id={`f-${path}`}
          className="mt-0.5 w-full rounded border border-gray-300 p-1"
          value={String(value ?? '')}
          onChange={(e) => set(path, e.target.value)}
        >
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={`f-${path}`}
          className="mt-0.5 w-full rounded border border-gray-300 p-1"
          type={kind}
          value={String(value ?? '')}
          onChange={(e) => set(path, kind === 'number' ? Number(e.target.value) : e.target.value)}
        />
      )}
    </label>
  );

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium" htmlFor="goal">
          Seu objetivo (PT ou EN)
        </label>
        <textarea
          id="goal"
          className="mt-1 w-full rounded border border-gray-300 p-2"
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="mt-1 flex flex-wrap gap-2 text-xs">
          {EXAMPLES.map((e) => (
            <button
              key={e}
              type="button"
              className="rounded bg-gray-100 px-2 py-0.5 hover:bg-gray-200"
              onClick={() => setText(e)}
            >
              {e}
            </button>
          ))}
        </div>
        <div className="mt-2 flex items-center gap-3">
          <button
            type="button"
            className="rounded bg-black px-3 py-1.5 text-sm text-white disabled:opacity-50"
            disabled={busy !== null}
            onClick={parse}
          >
            {busy === 'parsing' ? 'Interpretando…' : 'Interpretar objetivo'}
          </button>
          {goal && (
            <span className="text-xs text-gray-500">
              parser: {goal.parser.method}
              {goal.parser.model ? ` (${goal.parser.model})` : ''}
            </span>
          )}
        </div>
      </div>

      {sheet && (
        <div className="rounded border border-gray-200 p-3">
          <h2 className="font-semibold">
            Planilha de restrições{' '}
            <span className="text-xs font-normal text-gray-500">
              (edite antes de gerar o plano)
            </span>
          </h2>
          <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {field('target.kind', 'target.kind', sheet.target?.kind, 'select', [
              'monthly_cashflow',
              'balance',
            ])}
            {field('amount (BRL)', 'target.amountBrl', sheet.target?.amountBrl, 'number')}
            {sheet.target?.kind === 'balance'
              ? field('by month (YYYY-MM)', 'target.byMonth', sheet.target?.byMonth)
              : field('start month (YYYY-MM)', 'target.startMonth', sheet.target?.startMonth)}
            {field('profile', 'profile', sheet.profile, 'select', [
              'income',
              'accumulation',
              'high_risk',
            ])}
            {field('horizon (months)', 'horizonMonths', sheet.horizonMonths, 'number')}
            {field(
              'liquidity window (days)',
              'liquidityWindowDays',
              sheet.liquidityWindowDays,
              'number',
            )}
            {field('risk budget', 'riskBudget', sheet.riskBudget, 'select', [
              'low',
              'medium',
              'high',
            ])}
            {field('credit tolerance', 'creditTolerance', sheet.creditTolerance, 'select', [
              'none',
              'limited',
              'accept',
            ])}
            {field('FX stance', 'fxStance', sheet.fxStance, 'select', [
              'hedge_near_term',
              'accept_fx',
            ])}
            {field(
              'monthly contribution (BRL)',
              'monthlyContributionBrl',
              sheet.monthlyContributionBrl,
              'number',
            )}
            {field('language', 'language', sheet.language, 'select', ['pt', 'en'])}
          </div>
          {errors.length > 0 && (
            <ul className="mt-2 text-sm text-red-700">
              {errors.map((e) => (
                <li key={`${e.path}${e.message}`}>
                  {e.path ? `${e.path}: ` : ''}
                  {e.message}
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex items-center gap-3">
            <label className="text-sm">
              Capital (USD, USDC/USDT na carteira){' '}
              <input
                className="ml-1 w-32 rounded border border-gray-300 p-1"
                type="number"
                value={capital}
                onChange={(e) => setCapital(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="rounded bg-black px-3 py-1.5 text-sm text-white disabled:opacity-50"
              disabled={busy !== null}
              onClick={plan}
            >
              {busy === 'solving' ? 'Estruturando…' : 'Gerar plano'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
