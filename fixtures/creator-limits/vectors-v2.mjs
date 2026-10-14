// Writes vectors-v2.json, the cases of the second author rules (gate SHARED-RULES-V2, Thom, 2026-10-14), or
// checks that the committed file is what this writes:
//
//   node fixtures/creator-limits/vectors-v2.mjs           writes the file
//   node fixtures/creator-limits/vectors-v2.mjs --check   fails when the committed file differs
//
// Each case states its inputs and the reason a person reading the rule table expects; the rules below work
// out every rule it breaks, and the file is written only when the two agree. This is a third statement of
// the rules beside the TypeScript check and the registry, and shares no code with either. The README beside
// this file defines each rule.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('./vectors-v2.json', import.meta.url));
const BIOME = fileURLToPath(new URL('../../node_modules/.bin/biome', import.meta.url));

const LIMITS = {
  minAssets: 1,
  maxAssets: 16,
  minWeightBps: 50,
  maxWeightBps: 10_000,
  stepBps: 50,
  sumBps: 10_000,
  maxTurnoverBps: 2000,
};

const REASONS = [
  ['FeeNotZero', 'maxFeeBps is not zero'],
  ['FlagsNotZero', 'flags is not zero'],
  ['TooFewAssets', 'the list is empty'],
  ['TooManyAssets', 'the list has more than 16 entries'],
  ['AssetNotListed', 'an asset is not on the platform list'],
  ['DuplicateAsset', 'an asset appears more than once'],
  ['WeightBelowMin', 'a weight is under 50 bps'],
  ['WeightOffStep', 'a weight is not a multiple of 50 bps'],
  ['WeightAboveCeiling', 'a weight is over 10,000 bps'],
  ['WeightSum', 'the weights add up to more than 10,000'],
  ['VersionPending', 'a version is published and not yet in effect'],
  ['VersionTooSoon', 'now < lastPublishAt + publishDelay'],
  ['TurnoverTooHigh', 'the absolute changes, cash included, add up to more than 4,000'],
  ['CashNotAllowed', "the chain's cash token is a line of its own"],
];

// Seventeen plain assets (one more than a portfolio may hold), three with a ceiling that no longer binds,
// and the cash token. The ceilings are the factory's, which the second rules do not read.
const PLAIN = 'ABCDEFGHIJKLMNOPQ'.split('');
const PLATFORM = {
  assets: [...PLAIN, 'CAP_150', 'CAP_0', 'CAP_2500', 'CASH'],
  ceilingsBps: [...PLAIN.map(() => 5000), 150, 0, 2500, 5000],
  unlisted: ['UNLISTED'],
  cash: 'CASH',
};

const T0 = 1_791_212_400;
const DAY2 = 172_800;

const v = (assets, weightsBps) => ({ n: assets.length, assets, weightsBps });
const none = () => ({ exists: 0, ...v([], []) });
const some = (assets, weightsBps) => ({ exists: 1, ...v(assets, weightsBps) });

/** Every rule a version breaks, lowest first, from the rule table. */
function breaks(c) {
  const out = new Set();
  const { next } = c;
  if (next.maxFeeBps !== 0) out.add('FeeNotZero');
  if (next.flags !== 0) out.add('FlagsNotZero');
  if (next.n < LIMITS.minAssets) out.add('TooFewAssets');
  if (next.n > LIMITS.maxAssets) out.add('TooManyAssets');
  let sum = 0;
  next.assets.forEach((name, i) => {
    const w = next.weightsBps[i];
    sum += w;
    if (!PLATFORM.assets.includes(name)) out.add('AssetNotListed');
    if (next.assets.indexOf(name) !== i) out.add('DuplicateAsset');
    if (w < LIMITS.minWeightBps) out.add('WeightBelowMin');
    if (w % LIMITS.stepBps !== 0) out.add('WeightOffStep');
    if (w > LIMITS.maxWeightBps) out.add('WeightAboveCeiling');
    if (name === PLATFORM.cash) out.add('CashNotAllowed');
  });
  if (sum > LIMITS.sumBps) out.add('WeightSum');
  if (c.prev.exists === 1) {
    if (c.ctx.hasPending === 1) out.add('VersionPending');
    if (c.ctx.now < c.ctx.lastPublishAt + c.ctx.publishDelay) out.add('VersionTooSoon');
    if (moved(c.prev, next) > 2 * LIMITS.maxTurnoverBps) out.add('TurnoverTooHigh');
  }
  return REASONS.map(([name]) => name).filter((name) => out.has(name));
}

/** Twice the turnover: every asset's absolute change, and cash's, which is what each list leaves of 10,000. */
function moved(prev, next) {
  const weight = (list, name) =>
    list.assets.reduce((n, a, i) => (a === name ? n + list.weightsBps[i] : n), 0);
  const names = new Set([...prev.assets, ...next.assets]);
  let total = 0;
  for (const name of names) total += Math.abs(weight(next, name) - weight(prev, name));
  const sum = (list) => list.weightsBps.reduce((n, w) => n + w, 0);
  return total + Math.abs(sum(next) - sum(prev));
}

// ---- the cases: inputs, and the reason expected ('' when accepted)

const cases = [];
function add(group, name, scenario, parts, reason) {
  const c = {
    name,
    group,
    scenario,
    prev: parts.prev ?? none(),
    next: { ...parts.next, flags: parts.flags ?? 0, maxFeeBps: parts.maxFeeBps ?? 0 },
    older: parts.older ?? none(),
    waiting: parts.waiting ?? none(),
    ctx: {
      now: parts.now ?? T0,
      lastPublishAt: parts.prev ? (parts.lastPublishAt ?? T0) : 0,
      publishDelay: parts.publishDelay ?? DAY2,
      hasPending: scenario.startsWith('pending') ? 1 : 0,
    },
  };
  const broken = breaks(c);
  const got = broken[0] ?? '';
  if (got !== reason) throw new Error(`${name}: the rules say "${got}", the case says "${reason}"`);
  const ok = broken.length === 0;
  const later = c.prev.exists === 1;
  c.expect = {
    ok: ok ? 1 : 0,
    error: ok ? '' : 'CreatorLimit',
    reason: got,
    reasonId: ok ? 0 : REASONS.findIndex(([n]) => n === got) + 1,
    breaks: broken,
    turnoverBps: ok && later ? Math.floor((moved(c.prev, c.next) + 1) / 2) : 0,
    effectiveAt: ok ? c.ctx.now + (later ? c.ctx.publishDelay : 0) : 0,
  };
  cases.push(c);
}

const first = (group, name, next, reason, extra = {}) =>
  add(group, name, 'first', { next, ...extra }, reason);
const spread = (names, each) =>
  v(
    names,
    names.map(() => each),
  );
const later = { now: T0 + 200_000 };

// Count: one asset is enough, sixteen the most.
first('count', 'one asset at 100%', v(['A'], [10_000]), '');
first('count', 'one asset at 0.5%, the rest cash', v(['A'], [50]), '');
first('count', 'no asset at all', v([], []), 'TooFewAssets');
first('count', 'sixteen assets, the most allowed', spread(PLAIN.slice(0, 16), 600), '');
first(
  'count',
  'sixteen assets adding up to 100%',
  v(PLAIN.slice(0, 16), [...PLAIN.slice(0, 15).map(() => 650), 250]),
  '',
);
first('count', 'seventeen assets', spread(PLAIN, 550), 'TooManyAssets');
first('count', 'seventeen assets, too much in total too', spread(PLAIN, 650), 'TooManyAssets');

// Weights: 0.5% to 100%, in 0.5% steps.
first('weight', 'the least weight, 0.5%', v(['A', 'B'], [50, 9950]), '');
first('weight', 'a weight of nothing', v(['A', 'B'], [0, 5000]), 'WeightBelowMin');
first(
  'weight',
  'a weight under the least and off the step',
  v(['A', 'B'], [25, 5000]),
  'WeightBelowMin',
);
first('weight', 'a weight off the step', v(['A', 'B'], [75, 5000]), 'WeightOffStep');
first('weight', 'a weight of 0.01%', v(['A', 'B'], [5001, 4999]), 'WeightOffStep');
first('weight', 'one asset over 100%', v(['A'], [10_050]), 'WeightAboveCeiling');
first('weight', 'two assets at 50% each', v(['A', 'B'], [5000, 5000]), '');
first('weight', 'one asset at 90%', v(['A', 'B'], [9000, 1000]), '');

// Sum: at most 100%; what is left is cash.
first('sum', 'adding up to 70%: 30% cash', v(['A', 'B'], [4000, 3000]), '');
first('sum', 'adding up to 100.5%', v(['A', 'B'], [5000, 5050]), 'WeightSum');
first('sum', 'adding up to 110%', v(['A', 'B', 'C'], [5000, 3000, 3000]), 'WeightSum');

// Ceilings: an asset's own ceiling on the factory does not refuse a version.
first('ceiling', 'over a ceiling of 1.5%', v(['CAP_150', 'A'], [5000, 5000]), '');
first('ceiling', 'all of it in an asset whose ceiling is 0', v(['CAP_0'], [10_000]), '');
first('ceiling', 'over a ceiling of 25%', v(['CAP_2500', 'A'], [9000, 1000]), '');

// Cash: what the weights leave, never a line.
first('cash', 'the cash token as a line', v(['A', 'CASH'], [7000, 3000]), 'CashNotAllowed');
first('cash', 'the cash token as the only line', v(['CASH'], [10_000]), 'CashNotAllowed');
first(
  'cash',
  'the cash token as a line, and too much',
  v(['A', 'CASH'], [7000, 3500]),
  'WeightSum',
);

// The list.
first('list', 'an asset that is not listed', v(['A', 'UNLISTED'], [5000, 5000]), 'AssetNotListed');
first('list', 'an asset twice', v(['A', 'A'], [5000, 5000]), 'DuplicateAsset');

// The header.
first('header', 'a fee', v(['A'], [10_000]), 'FeeNotZero', { maxFeeBps: 1 });
first('header', 'flags', v(['A'], [10_000]), 'FlagsNotZero', { flags: 1 });

// Later versions: turnover counts cash.
const next = (name, prev, nextList, reason, extra = {}) =>
  add('turnover', name, 'next', { prev, next: nextList, ...later, ...extra }, reason);
next('20% into cash, exactly the most', some(['A'], [10_000]), v(['A'], [8000]), '');
next('20.5% into cash', some(['A'], [10_000]), v(['A'], [7950]), 'TurnoverTooHigh');
next('20% of one asset into cash', some(['A', 'B'], [5000, 5000]), v(['A', 'B'], [5000, 3000]), '');
next(
  'all of the cash into a new asset, 30%',
  some(['A'], [7000]),
  v(['A', 'B'], [7000, 3000]),
  'TurnoverTooHigh',
);
next('20% of the cash into a new asset', some(['A'], [7000]), v(['A', 'B'], [7000, 2000]), '');
next(
  '10% from one asset to another, cash unchanged',
  some(['A'], [7000]),
  v(['A', 'B'], [6000, 1000]),
  '',
);
next(
  'the same weights again, with cash',
  some(['A', 'B'], [4000, 3000]),
  v(['A', 'B'], [4000, 3000]),
  '',
);
next('everything to cash but 0.5%', some(['A'], [10_000]), v(['A'], [50]), 'TurnoverTooHigh');
next(
  'sixteen assets, a step each into cash',
  some(
    PLAIN.slice(0, 16),
    PLAIN.slice(0, 16).map(() => 600),
  ),
  spread(PLAIN.slice(0, 16), 550),
  '',
);
next(
  'up to sixteen assets from one, exactly 20% with cash',
  some(['A'], [10_000]),
  v(['A', ...PLAIN.slice(1, 16)], [8000, ...PLAIN.slice(1, 16).map(() => 100)]),
  '',
);
next(
  'up to sixteen assets from one, one step over 20%',
  some(['A'], [10_000]),
  v(['A', ...PLAIN.slice(1, 16)], [7950, ...PLAIN.slice(1, 16).map(() => 100)]),
  'TurnoverTooHigh',
);
next('down to one asset', some(['A', 'B'], [9000, 1000]), v(['A'], [10_000]), '');
next('up to seventeen assets', some(['A'], [10_000]), spread(PLAIN, 550), 'TooManyAssets');
next(
  'an asset over its old ceiling, kept',
  some(['CAP_150', 'A'], [5000, 5000]),
  v(['CAP_150', 'A'], [5000, 5000]),
  '',
);
add(
  'turnover',
  'a weight left over a ceiling lowered since',
  'next_ceiling_lowered',
  {
    prev: some(['CAP_2500', 'A'], [5000, 5000]),
    next: v(['CAP_2500', 'A'], [4000, 5000]),
    ...later,
  },
  '',
);

// Time: unchanged from the first rules.
const timing = (name, scenario, parts, reason) => add('timing', name, scenario, parts, reason);
const prev1 = some(['A'], [7000]);
timing(
  'one second too soon',
  'next',
  { prev: prev1, next: v(['A'], [6500]), now: T0 + DAY2 - 1 },
  'VersionTooSoon',
);
timing('exactly on time', 'next', { prev: prev1, next: v(['A'], [6500]), now: T0 + DAY2 }, '');
timing(
  'too soon and too much at once',
  'next',
  { prev: prev1, next: v(['A'], [2000]), now: T0 + 3600 },
  'VersionTooSoon',
);
timing(
  'a version is pending',
  'pending',
  { prev: prev1, waiting: some(['A'], [6500]), next: v(['A'], [6000]), now: T0 + 3600 },
  'VersionPending',
);
timing(
  'a version is pending though the interval has passed',
  'pending_delay_lowered',
  {
    prev: prev1,
    waiting: some(['A'], [6500]),
    next: v(['A'], [6000]),
    now: T0 + 400,
    publishDelay: 300,
  },
  'VersionPending',
);
timing(
  'a cancelled version does not give the slot back',
  'cancelled',
  { prev: prev1, waiting: some(['A'], [6500]), next: v(['A'], [6000]), now: T0 + 3600 },
  'VersionTooSoon',
);
timing(
  'after a cancelled version, exactly on time',
  'cancelled',
  { prev: prev1, waiting: some(['A'], [6500]), next: v(['A'], [6000]), now: T0 + DAY2 },
  '',
);

// A version that waited and took effect is the one measured against.
const matured = (name, older, prev, nextList, reason, now = T0 + DAY2) =>
  add('matured', name, 'matured', { older, prev, next: nextList, now }, reason);
matured(
  '20% more cash against it, 40% against the one before',
  some(['A'], [10_000]),
  some(['A'], [8000]),
  v(['A'], [6000]),
  '',
);
matured(
  '20% against it, 40% with cash against the one before',
  some(['A', 'B'], [5000, 5000]),
  some(['A', 'B'], [5000, 3000]),
  v(['A', 'B'], [3000, 3000]),
  '',
);
matured(
  '25% against it, 15% against the one before',
  some(['A'], [7000]),
  some(['A'], [9000]),
  v(['A', 'B'], [6500, 1500]),
  'TurnoverTooHigh',
);

const file = {
  schema: 'creator-limits-vectors',
  version: 2,
  rules: 2,
  readme: 'fixtures/creator-limits/README.md',
  limits: LIMITS,
  error: 'CreatorLimit',
  reasons: REASONS.map(([name, rule], i) => ({ id: i + 1, name, rule })),
  platform: { n: PLATFORM.assets.length, ...PLATFORM },
  count: cases.length,
  cases,
};
// The committed file is in the repository's JSON format; what it says is compared, not how it is laid out.
if (process.argv.includes('--check')) {
  if (JSON.stringify(JSON.parse(readFileSync(OUT, 'utf8'))) !== JSON.stringify(file)) {
    console.error(
      'vectors-v2.json is not what vectors-v2.mjs writes: run it again and commit the file',
    );
    process.exit(1);
  }
  console.log(`vectors-v2.json: ${cases.length} cases, as written`);
} else {
  writeFileSync(OUT, `${JSON.stringify(file, null, 2)}\n`);
  execFileSync(BIOME, ['format', '--write', OUT], { stdio: 'ignore' });
  console.log(`wrote vectors-v2.json: ${cases.length} cases`);
}
