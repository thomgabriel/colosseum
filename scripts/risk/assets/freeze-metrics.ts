import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { llamaKey, type MetricAnswers } from '@colosseum/risk';
import { decodeAnswers, encodeAnswers } from './metrics-run';

// PLAN-ASSETS AS.5: a run's answers cut to a few tokens, for the test (tests/risk-assets-metrics.test.ts). Every
// answer kept is as the source gave it; only the tokens not asked are left out.
//   tsx scripts/risk/assets/freeze-metrics.ts <answers.jsonl.gz> <out.jsonl.gz> <address,address,...>

const [src, out, list] = process.argv.slice(2);
if (!src || !out || !list) throw new Error('usage: freeze-metrics.ts <answers> <out> <addresses>');
const A = decodeAnswers(readFileSync(src));
const keep = new Set(list.split(','));
const low = new Set([...keep].map((a) => a.toLowerCase()));
const has = (a: string) => keep.has(a) || low.has(a.toLowerCase());
const pick = <T>(r: Record<string, T> | undefined, f: (k: string) => boolean = has) =>
  r ? Object.fromEntries(Object.entries(r).filter(([k]) => f(k))) : undefined;

const B: MetricAnswers = { ...A };
if (A.mints)
  B.mints = A.mints
    .map((c) => ({
      ...c,
      accounts: pick(c.accounts) as Record<string, { owner: string; data: string } | null>,
    }))
    .filter((c) => Object.keys(c.accounts).length);
B.largest = pick(A.largest);
if (A.riskPools && 'rows' in A.riskPools)
  B.riskPools = {
    ...A.riskPools,
    rows: A.riskPools.rows.filter((p) => has(p.assetMint) || has(p.quoteMint)),
  };
if (A.dex && 'byToken' in A.dex)
  B.dex = {
    ...A.dex,
    withPair: A.dex.withPair.filter(has),
    byToken: pick(A.dex.byToken) as typeof A.dex.byToken,
  };
B.llamaCharts = pick(A.llamaCharts, (k) => has(k.split(':')[1] as string));
B.totalSupply = pick(A.totalSupply);
B.erc4626 = pick(A.erc4626);
if (A.discovery && 'byToken' in A.discovery)
  B.discovery = {
    ...A.discovery,
    byToken: pick(A.discovery.byToken) as typeof A.discovery.byToken,
  };
if (A.registry && 'byAddress' in A.registry)
  B.registry = {
    ...A.registry,
    byAddress: pick(A.registry.byAddress) as typeof A.registry.byAddress,
  };
if (A.series && 'byAddress' in A.series)
  B.series = { ...A.series, byAddress: pick(A.series.byAddress) as typeof A.series.byAddress };
if (A.prices) {
  B.prices = { ...A.prices };
  const dl = A.prices.defillama;
  if (dl && 'coins' in dl)
    B.prices.defillama = {
      ...dl,
      coins: Object.fromEntries(
        Object.entries(dl.coins).filter(([k]) => [...keep].some((a) => llamaKey(A.chain, a) === k)),
      ),
    };
  const jp = A.prices.jupiter;
  if (jp && 'answers' in jp)
    B.prices.jupiter = { ...jp, answers: pick(jp.answers) as typeof jp.answers };
  if (A.prices.job) B.prices.job = { ...A.prices.job, resolved: A.prices.job.resolved.filter(has) };
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, encodeAnswers(B));
console.log(`${out}: ${keep.size} tokens of ${A.chain}, ${readFileSync(out).length} bytes`);
