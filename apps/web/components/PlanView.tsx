import type { PlanDetail } from '@/lib/api';
import { ProvenanceBadge } from './Provenance';

const pct = (w: string | number) => `${(Number(w) * 100).toFixed(1)}%`;

/** The plan as the user (or a partner frame) sees it: sheet, allocation with reasoning, schedule, stresses, risk sheet, executions. */
export function PlanView({ d, embed = false }: { d: PlanDetail; embed?: boolean }) {
  const sheet = d.sheet?.sheet as Record<string, unknown> | undefined;
  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-xl font-semibold">
          Plan {d.plan.id.slice(0, 8)} · {d.plan.profile}
        </h1>
        {d.goal && <p className="mt-1 text-gray-700">“{d.goal.rawText}”</p>}
        <p className="mt-1 text-xs text-gray-500">
          solver {d.plan.solverVersion} · {new Date(d.plan.createdAt).toLocaleString()}{' '}
          {d.sheet && <ProvenanceBadge value={d.sheet.provenance} />}
        </p>
      </section>

      {sheet && (
        <section>
          <h2 className="font-semibold">Constraint sheet</h2>
          <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
            {Object.entries(sheet).map(([k, v]) => (
              <div key={k}>
                <dt className="text-gray-500">{k}</dt>
                <dd>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <section>
        <h2 className="font-semibold">Allocation</h2>
        <table className="mt-2 w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500">
              <th>Leg</th>
              <th>Weight</th>
              <th>USD</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            {d.legs.map((l) => (
              <tr key={l.id} className="border-t border-gray-100 align-top">
                <td className="py-1 pr-2">
                  {l.symbol}
                  <div className="text-xs text-gray-500">{l.name}</div>
                  {l.label && <div className="text-xs text-amber-800">{l.label}</div>}
                </td>
                <td className="py-1 pr-2">{pct(l.weight)}</td>
                <td className="py-1 pr-2">{Number(l.amountUsd).toFixed(2)}</td>
                <td className="py-1 text-gray-700">{l.reasoning}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {d.plan.bindingConstraints?.length > 0 && (
          <p className="mt-2 text-xs text-gray-500">
            Binding: {d.plan.bindingConstraints.join('; ')}
          </p>
        )}
      </section>

      <section>
        <h2 className="font-semibold">BRL schedule and stresses</h2>
        {d.schedules.length === 0 ? (
          <p className="mt-1 text-sm text-gray-500">Schedule engine lands in D5-PM.</p>
        ) : (
          <p className="mt-1 text-sm">
            {d.schedules.length} cases · base liquidity{' '}
            {d.schedules.find((s) => s.caseId === 'base')?.liquidityOk ? 'holds' : 'breaks'}
          </p>
        )}
        {d.stresses.length > 0 && (
          <ul className="mt-1 text-sm">
            {d.stresses.map((s) => (
              <li key={s.stressId}>
                {s.name}: liquidity {s.liquidityOk ? 'holds' : 'breaks'}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="font-semibold">Risk sheet</h2>
        {d.riskSheet.length === 0 ? (
          <p className="mt-1 text-sm text-gray-500">
            Risk sheet lands in D4-PM. Every yield shown will carry a source and a timestamp.
          </p>
        ) : (
          <pre className="mt-1 overflow-auto text-xs">{JSON.stringify(d.riskSheet, null, 1)}</pre>
        )}
      </section>

      {d.policy && (
        <section>
          <h2 className="font-semibold">Policy</h2>
          <p className="mt-1 text-sm">
            Allowed: {d.policy.allowedAssets.join(', ')} · trigger {d.policy.trigger.driftPct}%
            drift · default {d.policy.mechanism}
            {Object.keys(d.policy.mechanismByAsset ?? {}).length > 0 &&
              ` (user-signed: ${Object.entries(d.policy.mechanismByAsset)
                .filter(([, m]) => m === 'user_signed')
                .map(([k]) => k)
                .join(', ')})`}
          </p>
          <ul className="mt-1 text-xs text-gray-600">
            {d.policy.bands.map((b) => (
              <li key={b.assetId}>
                {b.assetId}: {pct(b.min)} – {pct(b.max)}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2 className="font-semibold">Executions</h2>
        {d.executions.length === 0 ? (
          <p className="mt-1 text-sm text-gray-500">None yet.</p>
        ) : (
          <ul className="mt-1 space-y-1 text-sm">
            {d.executions
              .filter((e) => e.status !== 'built')
              .map((e) => (
                <li key={e.id}>
                  {e.kind} {e.assetId} · {e.status} ·{' '}
                  {e.explorerUrl ? (
                    <a
                      className="text-blue-700 underline"
                      href={e.explorerUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {e.signature?.slice(0, 12)}…
                    </a>
                  ) : (
                    '—'
                  )}
                </li>
              ))}
          </ul>
        )}
      </section>

      {!embed && <p className="text-xs text-gray-500">{d.disclaimer.pt}</p>}
    </div>
  );
}
