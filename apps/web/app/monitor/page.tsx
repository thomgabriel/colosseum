'use client';
import { useWallet } from '@solana/wallet-adapter-react';
import { useEffect, useState } from 'react';
import { apiGet, type WalletView } from '@/lib/api';

/** Monitoring: positions, executions and rebalances for the connected wallet. Drift vs bands and schedules land in D7-AM. */
export default function MonitorPage() {
  const { publicKey } = useWallet();
  const [data, setData] = useState<WalletView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const wallet = publicKey?.toBase58();
  useEffect(() => {
    if (!wallet) return;
    apiGet<WalletView>(`/wallets/${wallet}/positions`)
      .then(setData)
      .catch((e) => setErr(String(e)));
  }, [wallet]);
  if (!wallet)
    return (
      <p className="text-gray-600">
        Connect a wallet to see its positions, executions and rebalances.
      </p>
    );
  if (err) return <p className="text-red-700">{err}</p>;
  if (!data) return <p className="text-gray-500">Loading…</p>;
  return (
    <div className="space-y-6">
      <section>
        <h1 className="text-xl font-semibold">
          Monitor · {wallet.slice(0, 6)}…{wallet.slice(-4)}
        </h1>
        <h2 className="mt-4 font-semibold">Positions (last observed)</h2>
        <table className="mt-1 w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500">
              <th>Asset</th>
              <th>Amount</th>
              <th>USD</th>
              <th>Observed</th>
            </tr>
          </thead>
          <tbody>
            {data.positions.map((p) => (
              <tr key={p.assetId} className="border-t border-gray-100">
                <td>{p.assetId}</td>
                <td>{Number(p.amount).toFixed(4)}</td>
                <td>{p.valueUsd ? Number(p.valueUsd).toFixed(2) : '—'}</td>
                <td className="text-xs text-gray-500">
                  {new Date(p.observedAt).toLocaleString()} · {p.source}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section>
        <h2 className="font-semibold">Policies</h2>
        {data.policies.map((p) => (
          <p key={p.id} className="text-sm">
            {p.allowedAssets.join(', ')} · trigger {p.trigger.driftPct}% · {p.mechanism}
          </p>
        ))}
      </section>
      <section>
        <h2 className="font-semibold">Rebalances</h2>
        {data.rebalances.length === 0 ? (
          <p className="text-sm text-gray-500">None yet.</p>
        ) : (
          <ul className="text-sm">
            {data.rebalances.map((r) => (
              <li key={r.id}>
                {new Date(r.createdAt).toLocaleString()} · {r.mechanism} · {r.triggerReason}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h2 className="font-semibold">Executions</h2>
        <ul className="space-y-1 text-sm">
          {data.executions
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
                {e.error && <span className="text-xs text-red-700"> {e.error.slice(0, 80)}</span>}
              </li>
            ))}
        </ul>
      </section>
    </div>
  );
}
