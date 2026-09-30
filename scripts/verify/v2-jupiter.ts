import { JUPITER_API_BASE, jupQuote, MINTS, nowIso, print, sleep } from '../lib.js';

// V2: endpoint + key. Quote for every demo pair at a small size; report rate-limit headers.
const pairs: Array<[string, string]> = [
  ['USDC', 'USDY'],
  ['USDC', 'syrupUSDC'],
  ['USDC', 'SPYx'],
  ['USDC', 'QQQx'],
  ['USDT', 'USDC'],
  ['USDC', 'BRS'],
];
const results: Record<string, unknown> = {};
for (const [a, b] of pairs) {
  const q = await jupQuote(
    MINTS[a as keyof typeof MINTS],
    MINTS[b as keyof typeof MINTS],
    5_000_000n,
  );
  results[`${a}->${b}`] = {
    status: q.status,
    routable: q.status === 200,
    priceImpactPct: q.body.priceImpactPct,
    error: q.body.error,
    rateRemaining: q.rateRemaining,
  };
  await sleep(1200);
}
const allOk = Object.values(results).every((r) => (r as { routable: boolean }).routable);
print({
  id: 'V2',
  item: 'Jupiter endpoint, key and routability',
  status: allOk ? 'pass' : 'partial',
  how: `${JUPITER_API_BASE}/quote (key: ${process.env.JUPITER_API_KEY ? 'set' : 'NOT SET, keyless tier'})`,
  value: results,
  fetchedAt: nowIso(),
  note: 'BRS is expected non-routable: it has no DEX market; primary mint only (gate G-Nora).',
});
