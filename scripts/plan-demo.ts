import 'dotenv/config';
import { readFileSync } from 'node:fs';
import {
  buildScheduleWithStresses,
  fetchAllYields,
  fetchFx,
  parseGoal,
  pickPrimaryYield,
  REGISTRY,
  REGISTRY_BY_ID,
  solve,
} from '@colosseum/engine';

// Runs the three demo goals end to end (parse → solve → schedule + stresses) with live feeds, no execution.
// Capital per goal is a parameter (--capital), not a claim.
const capitalUsd = Number(
  process.argv.includes('--capital')
    ? process.argv[process.argv.indexOf('--capital') + 1]
    : 100_000,
);
const goals = JSON.parse(
  readFileSync(new URL('../fixtures/goals.json', import.meta.url), 'utf8'),
) as Array<{ id: string; text: string; expectedProfile: string }>;
const { observations, errors } = await fetchAllYields(REGISTRY);
const yields = pickPrimaryYield(observations);
const fxAll = await fetchFx();
const fx = fxAll.find((f) => f.pair === 'USD/BRL');
if (!fx) throw new Error(`no USD/BRL observation: ${(fxAll.errors ?? []).join('; ')}`);
let failed = 0;
for (const g of goals) {
  const parsed = await parseGoal(g.text);
  if (!parsed.sheet) {
    failed++;
    console.log(JSON.stringify({ goal: g.id, parse: 'invalid', errors: parsed.errors }));
    continue;
  }
  const r = solve({
    sheet: parsed.sheet,
    capitalUsd,
    assets: REGISTRY,
    yields,
    fxUsdBrl: fx.value,
  });
  const s = buildScheduleWithStresses({
    sheet: parsed.sheet,
    legs: r.legs,
    assets: REGISTRY_BY_ID,
    yields,
    capitalUsd,
    fxUsdBrl: fx.value,
  });
  const ok = parsed.sheet.profile === g.expectedProfile;
  if (!ok) failed++;
  console.log(
    JSON.stringify({
      goal: g.id,
      profile: parsed.sheet.profile,
      expected: g.expectedProfile,
      parser: parsed.method,
      legs: r.legs.map((l) => `${l.assetId}:${l.weight}`),
      method: r.method,
      binding: r.bindingConstraints,
      base: s.base.summary,
      stresses: s.stressSummaries.map(
        (x) =>
          `${x.id}:${x.summary.monthsFunded === x.summary.monthsTotal ? 'ok' : `FAIL(${x.summary.monthsFunded}/${x.summary.monthsTotal})`}`,
      ),
    }),
  );
}
console.log(
  JSON.stringify({
    feedsErrors: errors,
    fx: { value: fx.value, source: fx.source, fetchedAt: fx.fetchedAt },
  }),
);
process.exit(failed ? 1 : 0);
