// PLAN-ASSETS AS.8, series 2: every Chainlink round of every feed the asset list names on Robinhood Chain (the
// list's own feeds, and those of the tracked stocks in scripts/risk/universe/robinhood.json). A proxy keeps a
// phase per aggregator it has pointed to; a round id is the phase in the high 16 bits over the aggregator's
// round in the low 64 (`(phase << 64) | round`, as scripts/feeds/refresh-models.ts walks SGOV's).
//
//   count   phaseId() and aggregator() of each proxy, phaseAggregators(p) for each phase, latestRound() of each
//           phase's aggregator: the rounds of the feed are the sum, by Multicall3 at the head
//   fetch   one feed: getRoundData of every round of every phase through the proxy, 400 a call, gzip per UTC
//           day of updatedAt under <out>/robinhood/chainlink/<proxy>/<day>.jsonl.gz, with its manifest
//
// Read-only; the live loop's minutes are kept free (`ask` of backfill-logs.ts) and a 403 waits.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { addToManifest, BACKFILL_METHOD_VERSION, type Manifest } from '@colosseum/risk';
import { type Call, decodeAggregate3, encodeAggregate3, word, words } from './abi';
import { ask, type Deps, PAUSE_MS } from './backfill-logs';
import type { ChainConfig } from './config';

export const CL_SEL = {
  phaseId: '58303b10', // phaseId()  EACAggregatorProxy
  phaseAggregators: 'c1597304', // phaseAggregators(uint16)
  latestRound: '668a0f02', // latestRound()
  getRoundData: '9a6fc8f5', // getRoundData(uint80)
  latestRoundData: 'feaf968c', // latestRoundData()
  aggregator: '245a7bfc', // aggregator()
} as const;
export const PHASE_SHIFT = 64n;
export const roundIdOf = (phase: number, round: bigint) => (BigInt(phase) << PHASE_SHIFT) | round;

type Reply = { success: boolean; data: string };

/** Calls through Multicall3 at the head, 400 a request, after the live loop's minutes. */
export async function multicallAsk(deps: Deps, chain: ChainConfig, calls: Call[], chunk = 400) {
  const out: Reply[] = [];
  let requests = 0;
  for (let i = 0; i < calls.length; i += chunk) {
    const part = calls.slice(i, i + chunk);
    const r = await ask(deps, {
      method: 'eth_call',
      params: [{ to: chain.multicall3, data: encodeAggregate3(part) }, 'latest'],
    });
    requests++;
    if (r.error || typeof r.result !== 'string')
      throw new Error(`multicall: ${r.error?.message ?? 'no result'}`);
    const replies = decodeAggregate3(r.result);
    if (replies.length !== part.length)
      throw new Error(`multicall: ${part.length} calls, ${replies.length} answers`);
    out.push(...replies);
    await deps.sleep(PAUSE_MS);
  }
  return { replies: out, requests };
}

const uint = (r: Reply | undefined): bigint | null =>
  r?.success && r.data.length >= 66 ? (words(r.data)[0] as bigint) : null;
const addr = (r: Reply | undefined): string | null => {
  const w = uint(r);
  return w === null ? null : `0x${w.toString(16).padStart(40, '0').slice(-40)}`;
};

export type FeedCount = {
  feed: string;
  symbol: string;
  phase: number | null;
  phases: Array<{
    phase: number;
    aggregator: string | null;
    rounds: number | null;
    /** Where the count came from when the aggregator did not say. */
    from?: string;
  }>;
  rounds: number | null;
  reason: string | null;
};

/** The rounds of every feed: phases, each phase's aggregator and its latest round. */
export async function countRounds(
  deps: Deps,
  chain: ChainConfig,
  feeds: Array<{ feed: string; symbol: string }>,
): Promise<{ feeds: FeedCount[]; requests: number }> {
  let requests = 0;
  const first = await multicallAsk(
    deps,
    chain,
    feeds.map((f) => ({ target: f.feed, callData: `0x${CL_SEL.phaseId}` })),
  );
  requests += first.requests;
  const phaseOf = feeds.map((_, i) => {
    const p = uint(first.replies[i]);
    return p === null ? null : Number(p);
  });
  const phaseCalls: Array<{ i: number; phase: number }> = [];
  phaseOf.forEach((p, i) => {
    for (let k = 1; p !== null && k <= p; k++) phaseCalls.push({ i, phase: k });
  });
  const aggs = await multicallAsk(
    deps,
    chain,
    phaseCalls.map((c) => ({
      target: (feeds[c.i] as { feed: string }).feed,
      callData: `0x${CL_SEL.phaseAggregators}${word(c.phase)}`,
    })),
  );
  requests += aggs.requests;
  const aggOf = phaseCalls.map((_, k) => addr(aggs.replies[k]));
  const latest = await multicallAsk(
    deps,
    chain,
    aggOf.map((a) => ({
      target: a && a !== `0x${'0'.repeat(40)}` ? a : chain.multicall3,
      callData: `0x${CL_SEL.latestRound}`,
    })),
  );
  requests += latest.requests;
  const out: FeedCount[] = feeds.map((f, i) => ({
    feed: f.feed,
    symbol: f.symbol,
    phase: phaseOf[i] ?? null,
    phases: [],
    rounds: null,
    reason: phaseOf[i] === null ? 'phaseId_not_answered' : null,
  }));
  phaseCalls.forEach((c, k) => {
    const a = aggOf[k] ?? null;
    const usable = a !== null && a !== `0x${'0'.repeat(40)}`;
    const r = usable ? uint(latest.replies[k]) : null;
    (out[c.i] as FeedCount).phases.push({
      phase: c.phase,
      aggregator: a,
      rounds: r === null ? null : Number(r & 0xffff_ffff_ffff_ffffn),
    });
  });
  // an aggregator that does not answer latestRound(): the proxy's latestRoundData() names the current phase's
  // newest round in the low 64 bits of its round id
  const gaps = out.filter((f) => f.phases.at(-1)?.rounds === null);
  if (gaps.length) {
    const lr = await multicallAsk(
      deps,
      chain,
      gaps.map((f) => ({ target: f.feed, callData: `0x${CL_SEL.latestRoundData}` })),
    );
    requests += lr.requests;
    gaps.forEach((f, i) => {
      const id = uint(lr.replies[i]);
      const last = f.phases.at(-1);
      if (id !== null && last && Number(id >> PHASE_SHIFT) === last.phase) {
        last.rounds = Number(id & 0xffff_ffff_ffff_ffffn);
        last.from = 'proxy_latestRoundData';
      }
    });
  }
  for (const f of out) {
    if (f.reason) continue;
    const missing = f.phases.filter((p) => p.rounds === null);
    f.rounds = f.phases.reduce((s, p) => s + (p.rounds ?? 0), 0);
    if (missing.length)
      f.reason = `latestRound_not_answered_in_phase_${missing.map((p) => p.phase).join('_')}`;
  }
  return { feeds: out, requests };
}

export type RoundRow = {
  feed: string;
  phase: number;
  round: number;
  roundId: string;
  answer: string | null;
  startedAt: number | null;
  updatedAt: number | null;
  answeredInRound: string | null;
};

/** Every round of one feed, gzip per UTC day of its update, with its manifest. */
export async function fetchRounds(
  deps: Deps,
  chain: ChainConfig,
  feed: FeedCount,
  out: string,
  source: string,
) {
  const t0 = deps.now().getTime();
  const calls: Array<{ phase: number; round: number }> = [];
  for (const p of feed.phases)
    for (let r = 1; p.rounds !== null && r <= p.rounds; r++)
      calls.push({ phase: p.phase, round: r });
  const got = await multicallAsk(
    deps,
    chain,
    calls.map((c) => ({
      target: feed.feed,
      callData: `0x${CL_SEL.getRoundData}${word(roundIdOf(c.phase, BigInt(c.round)))}`,
    })),
  );
  const rows: RoundRow[] = calls.map((c, k) => {
    const r = got.replies[k];
    const w = r?.success && r.data.length === 2 + 5 * 64 ? words(r.data) : null;
    return {
      feed: feed.feed,
      phase: c.phase,
      round: c.round,
      roundId: roundIdOf(c.phase, BigInt(c.round)).toString(),
      answer: w ? BigInt.asIntN(256, w[1] as bigint).toString() : null,
      startedAt: w ? Number(w[2]) : null,
      updatedAt: w ? Number(w[3]) : null,
      answeredInRound: w ? (w[4] as bigint).toString() : null,
    };
  });
  const dir = join(out, feed.feed);
  mkdirSync(dir, { recursive: true });
  const byDay = new Map<string, RoundRow[]>();
  for (const r of rows) {
    const d = r.updatedAt ? new Date(r.updatedAt * 1000).toISOString().slice(0, 10) : 'unanswered';
    byDay.set(d, [...(byDay.get(d) ?? []), r]);
  }
  const days: Record<string, { rows: number; bytes: number }> = {};
  let gzBytes = 0;
  let rowBytes = 0;
  for (const [d, rs] of byDay) {
    const text = `${rs.map((r) => JSON.stringify(r)).join('\n')}\n`;
    const gz = gzipSync(text);
    writeFileSync(join(dir, `${d}.jsonl.gz`), gz);
    days[d] = { rows: rs.length, bytes: gz.length };
    gzBytes += gz.length;
    rowBytes += text.length;
  }
  const answered = rows.filter((r) => r.updatedAt !== null);
  const monotone = answered.every(
    (r, i) =>
      i === 0 || (r.updatedAt as number) >= ((answered[i - 1] as RoundRow).updatedAt as number),
  );
  const positive = answered.every((r) => BigInt(r.answer ?? '0') > 0n);
  const m0: Manifest = {
    series: 'chainlink-rounds',
    chain: 'robinhood',
    subject: feed.feed,
    methodVersion: BACKFILL_METHOD_VERSION,
    source,
    provenance: 'live',
    covered: [],
    days: {},
    rows: 0,
    bytes: 0,
    checks: [],
    updatedAt: deps.now().toISOString(),
  };
  let m = m0;
  for (const p of feed.phases)
    if (p.rounds)
      m = addToManifest(
        m,
        {
          from: Number(roundIdOf(p.phase, 1n) & 0xffff_ffff_ffff_ffffn) + p.phase * 1e9,
          to: p.rounds + p.phase * 1e9,
          unit: 'round',
        },
        {},
        [],
        m.updatedAt,
      );
  m = addToManifest(
    m,
    { from: 0, to: -1, unit: 'round' },
    days,
    [
      {
        name: 'every_round_answered',
        passed: answered.length === rows.length,
        detail: `${answered.length} of ${rows.length} rounds answered getRoundData`,
      },
      {
        name: 'updated_at_never_goes_back',
        passed: monotone,
        detail: 'updatedAt of each answered round at or after the round before it, phase by phase',
      },
      { name: 'answers_positive', passed: positive, detail: 'every answered round above zero' },
    ],
    deps.now().toISOString(),
  );
  m.covered = m.covered.filter((w) => w.to >= w.from);
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(m, null, 1)}\n`);
  const seconds = (deps.now().getTime() - t0) / 1000;
  return {
    feed: feed.feed,
    rounds: rows.length,
    answered: answered.length,
    first: answered[0]?.updatedAt ? new Date(answered[0].updatedAt * 1000).toISOString() : null,
    last: answered.at(-1)?.updatedAt
      ? new Date(((answered.at(-1) as RoundRow).updatedAt as number) * 1000).toISOString()
      : null,
    requests: got.requests,
    gzBytes,
    rowBytes,
    seconds,
    roundsPerSecond: rows.length / Math.max(1, seconds),
    checks: m.checks,
  };
}
