# PLAN-RISK.md — build plan for the liquidity and risk layer

*Written Thu 2026-10-01 (00:10Z) on branch `risk-layer`. Spec: `HANDOFF-RISK.md` (wins on conflict). Product it joins: `docs/HANDOFF-IDEA1.md`. Slot status will live in `docs/STATE-RISK.md` (created in P0-1). Every figure in this file is a parameter, a date or a count of work. None of it is a market fact.*

---

## 1. Plan summary

- **Phase 0 (Thu Oct 1, 2 slots):** a second, keyed collector writes sell and buy quotes for 8 assets every 15 min, plus hourly raw market snapshots, with the old job untouched. **Must prove:** both jobs write side by side through the Oct 3–4 and Oct 10–11 weekends.
- **Phase 1 (from Tue Oct 13, 6 slots):** `packages/risk` with pure functions over a frozen fixture, plus `pnpm risk:report`. **Must prove:** Saturday and Tuesday give different, reproducible numbers, and the breach and likely-breach fixture works.
- **Phase 2 (6 slots):** `risk_*` tables, importer, `/risk/*` plugin, standalone `apps/risk-api`, dashboard and methodology page. **Must prove:** HTTP reproduces Phase 1 byte for byte.
- **Phase 3 (9 slots):** the `LiquidityProvider` seam and four engine hooks. **Must prove:** with no provider, the engine is unchanged. It closes with one mainnet rebalance from a `liquidity_breach` proposal on Tue Oct 27.
- **Phase 4 (6 day-slots, from Wed Oct 28):** market readers, gap simulator, a lending leg gated by pool score, and a borrow-capacity view. **Must prove:** market parameters come from on-chain reads, not docs.
- **Most likely failure point:** Jupiter rate limits that leave holes in the time series. Signs are already visible: the existing collector runs **keyless**, and 115 of its 416 rows on Sep 30 were `429`. **Mitigation:** P0-1 measures the keyed tier before writing the collector, then sets spacing and grid to fit inside it. 429s are stored as rows, and coverage is reported per bucket so a thin bucket is labelled, not hidden.

## 2. Stack additions

| Need | Choice | Why (one line) |
|---|---|---|
| Engine, DB, API, web | **Nothing new** | `packages/risk` is TypeScript on the existing toolchain. Drizzle, Fastify with swagger, and Next are already in the repo. |
| Curve fitting | **No library.** Isotonic (pool-adjacent-violators) over per-grid-point quantiles, then monotone piecewise-linear interpolation in ln(notional) | About 60 lines, deterministic, invertible in closed form, auditable on the methodology page |
| Time zones and DST | **No library.** `Intl.DateTimeFormat` with `timeZone: 'America/New_York'` (Node ICU) | DST comes from the tz database that ships with Node; holidays are a fixture list |
| Charts (curves, heatmap) | **Plain SVG components** in the style of `apps/web/components/ScheduleChart.tsx` | Same pattern as the existing chart, no chart dependency, no SSR issues |
| Collector scheduling | **Second launchd job** `com.colosseum.risk-collect`, new plist and new `scripts/launchd/install-risk.sh` | Same mechanism as the proven first job; files outside `~/Documents` for the same privacy reason |
| Market reads (Phase 4) | `@kamino-finance/klend-sdk` 12.x (already installed). For Jupiter Lend: HTTP or raw account decode by default; an SDK only if R4-1 shows no other path | Avoids a new dependency unless verification forces one; pnpm's minimum-release-age rule applies |

## 3. Architecture sketch

```
Phase 0 (files only)                    Phase 2 (service)                         Phase 3 (seam)
scripts/risk-collect.mjs  ──JSONL──▶  scripts/risk-import.ts ──▶ depth_observations (side=buy|sell)
  (launchd, ~/.colosseum/risk/)         risk_market_snapshots (raw)        │
                                       scripts/risk-compute.ts ──▶ risk_depth_curves (method_version)
                                                                 ──▶ risk_liquidity_scores
packages/risk (pure, no I/O):                                    ──▶ risk_redemption_models (assumption)
  time       ET clock, hour-of-week, regime(at)                  ──▶ risk_market_params / risk_assessments
  curves     fit(samples) → DepthCurve; impactAt, maxNotionalAt, recoverableValue
  redemption primaryCapacity(issuer, at, H, n)
  recoverable recoverable(asset, n, at, H) → {value, path, provenance}
  score      liquidityScore(asset, H, τ, Nref)
  breach     assess(positions, withdrawals, window, params) → LiquidityAssessment
  gap        gapSim(marketParams, aggregates, gapPct) (Phase 1 math, Phase 4 inputs)
  markets    decoders for Kamino reserve / Jupiter Lend vault (Phase 4)
  provider   createLiquidityProvider(curveSnapshot, models) implements schemas.LiquidityProvider

apps/api/src/routes/risk.ts  (Fastify plugin: /risk/*)  ← mounted by apps/api AND by apps/risk-api (only this plugin + /docs)
apps/web/app/risk/*          (assets, asset/[id], markets, methodology)

packages/schemas  ◀── packages/risk        packages/schemas ◀── packages/engine
   (types + LiquidityProvider interface; risk never imports engine; engine never imports risk)
apps/api builds the provider from packages/risk and passes it into engine calls. No provider → today's code path.
```

**Data flow, quote to binding constraint:** Jupiter quote (USDC→asset buy, asset→USDC sell) → JSONL row with `source`, `fetchedAt`, `method`, `error` → `risk-import` → `depth_observations` → `risk-compute` buckets each row by regime → `risk_depth_curves` (asset, side, regime, points, samples, date range, `method_version`) → `apps/api` `POST /plans` loads the latest curve snapshot into `createLiquidityProvider` → `solve({..., liquidity})` computes the effective cap per stock → `bindingConstraints` gets "spyx capped at w: weekend sell capacity $C at τ, shareOfDepth s, n samples, dates" → the plan stores the curve snapshot id in each leg's risk-sheet `liquidity` block.

**Quote to `liquidity_breach` order:** `GET /policies/:id/drift` reads live positions and the plan's schedule → `provider.assess(positions, next withdrawals, window, policy.trigger.liquidity)` → `LiquidityAssessment {breach, likelyBreach, shortfall, monthsAtRisk}` → `proposeRebalance({..., liquidity})` adds orders illiquid → `usdc` with `reason: 'liquidity_breach'` → `/monitor` → `POST /policies/:id/rebalance` (xStocks are user-signed) → `executions` row with explorer link → `rebalances` row.

## 4. Method definitions (source for the methodology page; `method_version = risk-0.1`)

Every name in `code font` below is a **policy input** in `RISK_PARAMS`, `SOLVER_PARAMS` or `STRESS_PARAMS`. Each input is stored next to each output and is never a market fact.

**Collection.**
- Notional grid `G` = 8 log-spaced USD notionals from `gridMinUsd` to `gridMaxUsd` (defaults: 100 and 5,000,000).
- Buy quote: USDC→asset, exact-in `n` USDC.
- Sell quote: asset→USDC, exact-in `n / p_ref` units, where `p_ref` is the USDC rate from the same run's smallest buy quote. If that quote failed, sell rows are written with `error: 'no_ref_price'`.
- A failed quote is a row with `error` and null values. It is never retried in a loop.

**Impact.** For a quote with input value `n` (USD) and output value `o` (USD), the effective rate is `r(n) = o/n`. Own impact is `I(n) = 1 − r(n)/r(n_min)`, where `n_min` is the smallest successful grid notional in the same run and side. Jupiter's `priceImpactPct` is stored beside it and never used in formulas. The methodology page states that a quote is an executable route at that instant, not order-book depth and not a fill guarantee.

**Buckets and regimes** (`time` module). Convert `at` to ET with `Intl` (DST is automatic). Hour-of-week is `h = weekday(ET)×24 + hour(ET)`, 0..167. The regime is the first match in this order:
1. `us_holiday`: ET date is in `fixtures/risk/us-market-holidays.json`.
2. `weekend`: from `weekendStartET` to `weekendEndET`. Defaults: Fri 20:00 and Sun 20:00. These are parameters, set from the issuer's published trading window in VR-6.
3. `us_market_hours`: Mon–Fri `rthOpenET`–`rthCloseET` (09:30–16:00).
4. `us_offhours_weekday`: everything else.

A `us_holiday` bucket with fewer than `minSamplesPerPoint` samples falls back to the `weekend` curve, and the response says so. There is no NYSE holiday between Oct 1 and Nov 25, 2026, so this fallback will be live. Tests cover the DST change on Sun Nov 1, 2026.

**Curve fit** (`curves`). For each (asset, side, regime), and per hour-of-week only if D3 allows it:
1. At each grid point take the `curveQuantile` (default median) of `I` over successful samples. Record `samples_k`, `errors_k`, `from`, `to`.
2. Apply isotonic regression in `n` so impact never falls as notional rises.
3. Interpolate linearly in `x = ln n`.

Queries:
- `impactAt(n)` = interpolated value for `n` in [min G, max G]. Below the grid it is the value at min G. Above the grid it is `null` (`beyond_measured`).
- `maxNotionalAt(τ)` = largest `n` with `impactAt(n) ≤ τ`, solved on the segment. It is 0 if `impactAt(min G) > τ`. If `impactAt(max G) ≤ τ` it is `≥ max G`, flagged as a lower bound.
- `recoverableValue(n)` (sell side) = `n × (1 − impactAt(n))`.
- A point with `samples_k < minSamplesPerPoint` makes the curve `insufficient` above that point.

**Weekend ratio.** `ρ(asset, τ) = maxNotionalAt_weekend(τ) / maxNotionalAt_us_market_hours(τ)` on the sell side. It is a measured output with both sample counts beside it, and `null` if either curve is `insufficient`.

**Primary-redemption overlay** (`redemption`). Issuer model `M` = {`windowSchedule` (fixture: 24/5 or 24/7 in ET), `minNotionalUsd`, `kycRequired`, `settlementHours`, `capacityUsdPerOpenHour`, `feePct`}. Every field has `provenance: 'assumption'` unless VR-6 finds a primary source.

`primaryCapacity(issuer, at, H, n)` is:
- 0 if `n < minNotionalUsd`;
- 0 if no window hour lies in `[at, at + H − settlementHours]`;
- otherwise `min(n, capacityUsdPerOpenHour × open hours in that interval)`.

The response always lists the primary path with its status: `available`, `window_closed`, `below_minimum`, `settles_after_horizon` or `kyc_required`.

**Recoverable value** (`recoverable`). For `(asset, n, at, H)`:
- DEX path: `n × (1 − impactAt_b(n))` in the best bucket `b` reachable in `[at, at+H]`. It is a single sale; `splitAcrossBuckets` defaults to off.
- Combined path: `x(1 − feePct) + DEX(n − x)` with `x = primaryCapacity`.
- Result: `max(DEX, combined)`, returned with path, bucket, curve ids, sample counts and provenance (`live` for curves, `assumption` for the issuer model).

**Liquidity score** (`score`). `S(asset, H, τ, Nref) = min(1, min_{regimes reachable in H} maxNotionalAt_r(τ) / Nref)`. `Nref` is the leg's USD amount inside a plan and `refNotionalUsd` on public pages. It is a number in [0,1], published with τ, Nref, the worst regime, samples and dates. No grades.

**Breach** (`breach`). Inputs:
- positions (cash, BRL leg, liquid USD legs, illiquid legs);
- withdrawals `W_k` over `horizonMonths`;
- `liquidityWindowDays`;
- τ, `shareOfDepth`, `dryFactorFloor`.

Steps:
1. Draw each `W_k` in order from BRL leg, then cash, then liquid USD legs (same order as `buildSchedule`), depleting balances.
2. `need_k` is the remainder.
3. `cap_k = Σ_illiquid shareOfDepth × maxNotionalAt_worst(τ)`, where "worst" is the worst regime inside `[t_k − liquidityWindowDays, t_k]`.
4. Dry depth multiplier `d = max(dryFactorFloor, min(1, ρ))`. The dry curve is `I_dry(n) = I(n/d)`, so `cap_k^dry = d × cap_k`.

Outputs:
- `breach` = ∃k: `cap_k < need_k`.
- `likelyBreach` = ∃k: `cap_k^dry < need_k`.
- `shortfall` = `max_k (need_k − cap_k^dry)⁺`, plus `monthsAtRisk`.
- Orders: sell illiquid → `usdc` for `shortfall`, least liquid leg first, each order ≤ that leg's value. The function re-runs on the post-order positions, and a test asserts `likelyBreach = false` afterwards.

**Effective cap in the solver.** With a provider:
- `capEff_i = min(capWeight_i, shareOfDepth × maxNotionalAt_worst(τ; window = liquidityWindowDays) / capital)`.
- The equity budget is split as today within `capEff`; anything not placed flows to the LP remainder, as today.
- Binding text names the regime, dollar capacity, τ, samples and dates.

Without a provider, `capEff_i = capWeight_i` through untouched code.

**Exit cost in the schedule.** With a provider, equity becomes the last-resort source after liquid legs.
- Drawing `y` USD of value yields `y × (1 − impactAt_worst(y))`. Bisection finds the `y` that covers the remaining need, capped at `maxNotionalAt_worst(τ_exit)`, where `τ_exit = exitImpactCapPct`.
- `liquidityOk` is false if equity cannot cover the remainder at that cap.

Without a provider, equity is never drawn (today).

**`liquidity_dry` stress.** Same schedule with `I_dry` (multiplier `d` as above, `STRESS_PARAMS.dryFactorFloor`). Added only when the plan holds a leg with a curve and a provider is present.

**Gap simulator** (`gap`). Market params `{ltvLiq, closeFactor, fullLiqLtv, liqBonus, bandPct}` come from on-chain in Phase 4, or a labelled fixture in Phase 1. Aggregates are collateral `C` and debt `D` at the last close. For gap `g = gapPct`:
- **Liquidatable at reopen:** debt where `D > ltvLiq × C(1−g)`, repaid at `closeFactor` (or fully above `fullLiqLtv`). Seized collateral is valued at `recoverable(seized, reopen bucket, H = liquidationHorizonHours)`.
- **Unliquidatable while closed:** debt underwater at `C(1−g)` but not at the banded oracle price `C(1 − min(g, bandPct))`.

Every assumption is listed in the response.

## 5. Slot tables

Slots are half days (AM 09–13, PM 14–18 BRT) for Phases 0–3 and full days for Phase 4. Post-hackathon work uses weekdays only. `[B2]` marks work for a possible second builder. Every slot ends with `pnpm typecheck && pnpm lint && pnpm test`, an evidence row in `docs/STATE-RISK.md`, and a commit named after the slot (`R1-3: curve fit and queries`).

### Phase 0 — Collect (Thu Oct 1)

| Slot | Phase | Workstream | Deliverable | Check | Depends on | [B2]? | Notes |
|---|---|---|---|---|---|---|---|
| P0-1 Thu Oct 1 AM | 0 | Verify + collector | **First check:** the existing job is still writing. Then **VR-1** (Jupiter keyed tier) and **VR-2** (xStocks discovery and mint checks, §9a). Then `scripts/risk-collect.mjs`: dependency-free; sell and buy, 8 notionals, tiered asset list (§9a); hourly market block; spacing from VR-1; 429s as rows; reads the old job's file mtime only to avoid overlap. Plus `docs/STATE-RISK.md`. | (1) `stat -f %m ~/.colosseum/depth/2026-10-01.jsonl` advanced within the last 16 min, before any new file is written. (2) One manual run into a scratch dir: 16 quote rows per Tier-1 asset plus the Tier-2 rotation share (errors included) + ≥ 1 market row with `source`, `fetchedAt`. (3) `docs/VERIFICATION-RISK.md` rows VR-1 and VR-2. | — | [B2] | Grid and spacing follow decision D8. Assets whose mint fails VR-2 are left out, never guessed. Kamino xStocks reserve addresses come from `GET /v2/kamino-market` plus `reserves/metrics` filtered by verified mints, stored raw. Config fields are not interpreted until R4-1. |
| P0-2 Thu Oct 1 PM | 0 | Scheduling + markets | `scripts/launchd/com.colosseum.risk-collect.plist` (`StartCalendarInterval` at fixed minutes, 7 min after the old job's observed phase), `scripts/launchd/install-risk.sh` (copies to `~/.colosseum/risk-collect.mjs`, its own env file `~/.colosseum/risk/env` with the key and RPC), the hourly market block (Kamino metrics plus raw `getAccountInfo` base64 of each reserve; Jupiter Lend vaults by the source found in a 45-min timebox), and `pnpm risk:coverage` (runs, 429 rate, rows per regime). | Two consecutive scheduled runs in `~/.colosseum/risk/2026-10-01.jsonl`. `~/.colosseum/risk/markets-2026-10-01.jsonl` has Kamino rows (and Jupiter Lend rows, or a logged `not_found` row). `launchctl list \| grep colosseum` shows both jobs. The old file's mtime is still advancing. `risk:coverage` output pasted into STATE-RISK. | P0-1 | [B2] | `scripts/launchd/install.sh`, the old plist, `~/.colosseum/env` and `~/.colosseum/depth/` are not edited. Founder action: power settings for the Oct 3–4 and Oct 10–11 weekends (R-9). |

**Between Oct 2 and Oct 12 (no slots, about 2 min a day):** run `pnpm risk:coverage` and append one line to STATE-RISK. If coverage of any regime falls below the D3 threshold, record it; do not patch the job mid-weekend unless it has stopped writing.

### Phase 1 — Engine (`packages/risk`), default Tue Oct 13 – Thu Oct 15

| Slot | Phase | Workstream | Deliverable | Check | Depends on | [B2]? | Notes |
|---|---|---|---|---|---|---|---|
| R1-1 Tue Oct 13 AM | 1 | Fixture + boundary | **VR-6** (primary-redemption terms). `packages/risk` scaffold. `scripts/risk-fixture.ts` freezes `fixtures/risk/quotes-2026-10-01_12.jsonl` (both collectors, two weekends) and `fixtures/risk/issuer-models.json` (assumptions). `tests/risk-layer/boundary.test.ts`: no `@colosseum/engine` import anywhere under `packages/risk` or `apps/risk-api`. | Boundary test green. Fixture row counts per regime printed and recorded. Decisions D3 and D6 recorded in STATE-RISK. | P0 data | | Before this slot (15 min): merge `main` into `risk-layer`, then apply the D6 fold. |
| R1-2 Tue Oct 13 PM | 1 | `time` | ET conversion, hour-of-week, `regimeAt`, `bucketsIn(at, H)`, holiday fixture | `tests/risk-layer/time.test.ts`: Sat 10:00Z → `weekend`. Tue 15:00Z → `us_market_hours`. DST changes on Sun Nov 1, 2026 and Sun Mar 8, 2026. Thanksgiving 2026 → `us_holiday`. | R1-1 | | |
| R1-3 Wed Oct 14 AM | 1 | `curves` | `fitCurve`, `impactAt`, `maxNotionalAt`, `recoverableValue`, coverage and `insufficient` flags, weekend ratio | `tests/risk-layer/curves.test.ts`: monotone output on non-monotone input. Inverse round-trip `impactAt(maxNotionalAt(τ)) ≤ τ`. Same input gives byte-identical JSON. Leave-one-day-out error is printed (D2). | R1-2 | | |
| R1-4 Wed Oct 14 PM | 1 | `redemption` + `recoverable` | `primaryCapacity`, `recoverable` with path and status | `recoverable.test.ts`: `spyx, $50k, Sat 10:00Z, 24h` → DEX only. Same at `72h` → primary path present with `provenance: 'assumption'` and its status (see Q5). | R1-3 | | |
| R1-5 Thu Oct 15 AM | 1 | `score` + `breach` | `liquidityScore`, `assess` (base and dry), orders sized to the shortfall | `breach.test.ts`: fixture A (monthly withdrawal > cash + liquid) gives `breach: false`, `likelyBreach: true`, with orders, and no `likelyBreach` after applying them. Fixture B (enough cash) gives neither. | R1-4 | | |
| R1-6 Thu Oct 15 PM | 1 | `gap` + CLI | `gapSim` over a labelled fixture market. `pnpm risk:report` prints sell curves for `weekend` and `us_market_hours`, `maxNotionalAt(τ)` and ρ per asset. `no-yield-literals.test.ts` extended to `packages/risk` (impact, price and depth names). | `docs/risk/report-2026-10-15.txt` committed. Literal test green. `gap.test.ts` green. | R1-5 | | Phase 1 acceptance run. |

**Alternative, Phase 1 from Mon Oct 5 (on the branch, during the hackathon):**
- R1-1..R1-4 → Oct 5 AM, Oct 5 PM, Oct 6 AM, Oct 6 PM. These are D5/D6 calendar slots, free because D5/D6 ran early.
- R1-5..R1-6 → Thu Oct 8 AM and PM (FLEX-2, FLEX-3), only if G-Nora FAILED on Oct 6. If G-Nora passed, they move to Tue Oct 13 AM and PM.
- The fixture has one weekend (Oct 3–4). It is refreshed with Oct 10–11 in a dedicated `R1-fixture-refresh` commit on Oct 13, and D3 still decides on Oct 13.
- Phase 2 then starts Oct 13 AM, Phase 3 ends Thu Oct 22 AM (mainnet), and Phase 4 runs Fri Oct 23 – Fri Oct 30.
- **Cost to the hackathon:**
  - FLEX-2 (S1 EVM adapter or execution hardening) and FLEX-3 (friendly-user onboarding, ≥ 2 external wallets) are dropped.
  - The founder items that would use Oct 5–6 (deploy logins, rebalance #2, S1 decision) compete with R1 slots.
  - Context switching costs the run-up to the Oct 9 freeze.
  - `main` is not touched either way.

### Phase 2 — Service, Fri Oct 16 – Tue Oct 20

| Slot | Phase | Workstream | Deliverable | Check | Depends on | [B2]? | Notes |
|---|---|---|---|---|---|---|---|
| R2-1 Fri Oct 16 AM | 2 | Tables | **VR-7** (quote vs realised slippage, method only). Drizzle tables `risk_depth_curves`, `risk_liquidity_scores`, `risk_redemption_models`, `risk_market_params`, `risk_market_snapshots`, `risk_assessments`, each with `method_version` and provenance columns. Migration. `docs/DATA-MODEL.md` rows. | Migration applies on local Postgres (5433). `db-schema.test.ts` extended and green. | R1-6 | | `depth_observations` kept; sell rows land there with `side='sell'` |
| R2-2 Fri Oct 16 PM | 2 | Importer + compute | `scripts/risk-import.ts` (quotes → `depth_observations`, markets → `risk_market_snapshots`, idempotent; error rows counted into coverage). `scripts/risk-compute.ts` (curves and scores persisted with `method_version`, snapshot id). | Two consecutive imports: the second prints `inserted: 0`. `risk:compute` prints the curve count per regime. | R2-1 | [B2] | |
| R2-3 Mon Oct 19 AM | 2 | Read API | `apps/api/src/routes/risk.ts` plugin: `GET /risk/assets`, `/risk/assets/:id/depth?side&regime`, `/risk/assets/:id/score`, `/risk/recoverable`. zod schemas, so they appear in OpenAPI. `DISCLAIMER` on every response. | `curl /risk/assets/spyx/depth?side=sell&regime=weekend` returns points, `samples`, `from`, `to`, `methodVersion`. Saved to `docs/risk/evidence/r2-3.json`. | R2-2 | | |
| R2-4 Mon Oct 19 PM | 2 | Assess + standalone | `POST /risk/positions/assess`. `apps/risk-api` (Fastify, mounts only the risk plugin and swagger). | API test: the HTTP result equals the R1-5 fixture result (deep-equal). `pnpm --filter risk-api dev`: `/docs` lists only `/risk/*`, and `/plans` returns 404. | R2-3 | | |
| R2-5 Tue Oct 20 AM | 2 | Dashboard | `apps/web/app/risk/page.tsx` (assets and scores), `risk/[asset]/page.tsx` (SVG curves per regime, hour-of-week heatmap with sample counts, ρ) | Screenshot `docs/screenshots/r2-5-risk-spyx.jpg`, showing the regime, samples and date range | R2-4 | [B2] | |
| R2-6 Tue Oct 20 PM | 2 | Methodology + slippage | `risk/methodology` rendered from §4 of this plan plus the §3.3 honesty lines and the disclaimer. `pnpm risk:slippage`: quoted vs realised for every `executions` swap row (Sep 30 SPYx/QQQx onward), shown on the methodology page. | Screenshot. `risk-slippage.test.ts` (computation on fixture executions). Decision D4 recorded. | R2-5 | [B2] | Phase 2 acceptance run |

### Phase 3 — Join, Wed Oct 21 – Tue Oct 27

| Slot | Phase | Workstream | Deliverable | Check | Depends on | [B2]? | Notes |
|---|---|---|---|---|---|---|---|
| R3-1 Wed Oct 21 AM | 3 | **No-provider proof** | `tests/engine-baseline.test.ts`: the three demo goals' full plan output (legs, binding constraints, schedule, stresses, risk sheet) snapshotted on the unchanged engine. Additive schema types: `DepthCurve`, `LiquidityScore`, `LiquidityAssessment`, `LiquidityEntry`, the `LiquidityProvider` interface, optional `Policy.trigger.liquidity`, optional `RiskSheetEntry.liquidity`. | Full `pnpm test` green with **zero** snapshot updates (`git diff tests/__snapshots__` is empty apart from the new baseline file). Commit hash recorded as the baseline. | R2-6 | | Decision D7 recorded. From here on, any engine change re-runs this test. |
| R3-2 Wed Oct 21 PM | 3 | Providers | `packages/risk/provider` (`createLiquidityProvider(snapshot)`) and `tests/fixtures/fixture-liquidity-provider.ts` (`provenance: 'fixture'`) | `provider-contract.test.ts` runs the same assertions against both | R3-1 | | |
| R3-3 Thu Oct 22 AM | 3 | Solver hook | `solve({..., liquidity?})`: effective cap, binding text, `SOLVER_PARAMS.impactTolerancePct` and `shareOfDepth` | `solver-liquidity.test.ts`: high-risk plan SPYx/QQQx weights fall as capital crosses weekend capacity, and the binding text names `weekend` and the dollar capacity. Baseline green. | R3-2 | | |
| R3-4 Thu Oct 22 PM | 3 | Schedule hook | Equity drawable at exit cost; `liquidity_dry` stress; `STRESS_PARAMS.dryFactorFloor` | `schedule-liquidity.test.ts`: `liquidity_dry` present for stock plans only. A fixture whose withdrawal is drawn from stocks flips `liquidityOk` when exit cost applies. Baseline green. | R3-3 | | |
| R3-5 Fri Oct 23 AM | 3 | Risk-sheet hook | `buildRiskSheet({..., liquidity?})` emits a `liquidity` block (score, capacity at the plan's window, ρ, primary summary, samples, dates, provenance). `depthNote` is rendered from it. | `risk.test.ts`: high-risk plan has the block on SPYx and QQQx. Income and accumulation plans have it on USDY and syrupUSDC. Baseline green. | R3-4 | | Today `POST /plans` passes an empty depth map; that stays the no-provider behaviour |
| R3-6 Fri Oct 23 PM | 3 | Policy hook | `proposeRebalance({..., liquidity?})` with `liquidity_breach` orders | `policy.test.ts` adds: never above band max; destination is always the owner; liquidity orders only reduce illiquid legs; liquidity orders respect the minimum interval. Existing six invariants unchanged. | R3-5 | | R-7 |
| R3-7 Mon Oct 26 AM | 3 | API wiring | `POST /plans` and `GET /policies/:id/drift` build and pass the provider; responses gain `liquidity`; `/risk/*` mounted in `apps/api`. `pnpm acceptance:risk` → `docs/ACCEPTANCE-RISK.md`. | `curl` evidence for both routes. `acceptance:risk` passes P0–P2 and P3 checks 1–4. | R3-6 | | |
| R3-8 Mon Oct 26 PM | 3 | UI | `PlanView` liquidity panel (capacity vs need per window, regime); `/monitor` liquidity status row with the proposal reason | Screenshots: plan panel, and a monitor showing a `liquidity_breach` proposal for the fixture policy (FIXTURE badge visible). P3 check 5 passes. | R3-7 | [B2] | |
| R3-9 Tue Oct 27 AM | 3 | **Mainnet** | Demo-wallet policy with `trigger.liquidity` (τ per D10). `/monitor` proposes `liquidity_breach` (stock → USDC). User-signed, smallest sensible amount, sent once. | Explorer link in `executions` and `rebalances`, shown on `/monitor`. `acceptance:risk` passes all Phase 3 checks. | R3-8 | | Weekday. A failed send is logged, never auto-retried. Tue Oct 27 PM is unallocated buffer. |

### Phase 4 — Lending (day slots), Wed Oct 28 – Wed Nov 4

| Slot | Phase | Workstream | Deliverable | Check | Depends on | [B2]? | Notes |
|---|---|---|---|---|---|---|---|
| R4-1 Wed Oct 28 | 4 | **Verify account reads** | **VR-3** (Kamino xStocks reserves: addresses, `ReserveConfig` fields, Scope price-band config), **VR-4** (Jupiter Lend vault configs), **VR-5** (obligation enumeration feasibility). Scratch decoders run against the raw P0 snapshots. | `docs/VERIFICATION-RISK.md` VR-3..VR-5 with method, timestamp and value. Decisions D5 and D9 recorded. | R3-9 | | First because these reads are the unfamiliar part |
| R4-2 Thu Oct 29 | 4 | Market readers | `packages/risk/markets` decoders. `risk-import` backfills `risk_market_params` from the raw snapshots collected since Oct 1. | `GET /risk/markets` lists each reserve and vault with on-chain params, `source`, `fetchedAt`, and the dispersion table | R4-1 | [B2] | |
| R4-3 Fri Oct 30 | 4 | Gap + market pages | `POST /risk/markets/:id/gap` on real params. `apps/web/app/risk/markets/*`. | Gap response for one market at a chosen `gapPct`: liquidatable-at-reopen, unliquidatable-while-closed, assumptions listed. Screenshot. | R4-2 | [B2] | |
| R4-4 Mon Nov 2 | 4 | Lending leg | Registry entry "USDC supplied to stock-collateral market", haircut rule `HC-LEND-RWA`, gate on pool score, `db:seed` | `registry.test.ts`: appears in an accumulation plan only when score ≥ `poolScoreMin`, never in income. Acceptance registry-vs-DB diff green. | R4-3 | | Registry is the enforcement point |
| R4-5 Tue Nov 3 | 4 | Borrow capacity | `POST /risk/positions/borrow-capacity` (read-only) | For a wallet holding SPYx: capacity, liquidation distance, thinnest hour-of-week. Test asserts no transaction is built. | R4-4 | | |
| R4-6 Wed Nov 4 | 4 | Obligations or hardening | If D5 = yes: obligation enumeration into `risk_market_snapshots`. Else: full `acceptance:risk` across Phases 0–4 and fixes. | `docs/ACCEPTANCE-RISK.md` all rows | R4-5 | | |

## 6. Decision log with cut-offs

| # | Decision | Options | Default | Cut-off | What changes on each outcome |
|---|---|---|---|---|---|
| D1 | Phase 1 start | Oct 5 (hackathon slots) / Oct 13 | **Oct 13** | Sun Oct 4 20:00 BRT | Oct 5: alternative row map in §5; FLEX-2 and FLEX-3 content dropped; everything after shifts 3 working days earlier. Oct 13: table as written. |
| D2 | Curve fit | Isotonic + PL in ln n / parametric power law | **Isotonic + PL** | R1-3 | Parametric only if its leave-one-day-out error is lower on ≥ half the (asset, side) pairs. Then `method_version` changes, and the methodology text gets a new section. |
| D3 | Hour-of-week curves | Regime only / hour-of-week where data allows | **Regime curves for all decisions; hour-of-week as a descriptive heatmap only** | R1-1 (Oct 13, after the second weekend) | Hour-of-week becomes decision-grade per (asset, side) only where every bucket has ≥ `minSamplesPerPoint` successful samples at every grid point. `risk:coverage` reports this. |
| D4 | Second depth source (direct Raydium/Orca/Meteora reads) | yes / no | **No** | R2-6 | Yes only if realised slippage diverges from quoted impact beyond `slippageDivergenceTol` on most executions, or more than `maxErrorRunShare` of runs fail. It would be added as a Phase 4+ slot, not inside Phases 1–3. |
| D5 | Obligation enumeration | yes / no | **No** (market aggregates from reserve metrics) | R4-1 | Yes only if the paid RPC serves filtered `getProgramAccounts` within budget and the founder approves the cost. Then R4-6 builds it. |
| D6 | Fold the old collector on Oct 13 | Fold / keep both | **Fold.** Final `pnpm depth:import` of `~/.colosseum/depth/`, unload `com.colosseum.depth-snapshot`, keep its files read-only, mark `depth-snapshot.mjs` superseded. | Tue Oct 13 AM | Keep both: two key/IP consumers stay (R-8). The old grid series continues for comparison only. |
| D7 | Merge `risk-layer` into `main` | After Phase 2 / after Phase 3 | **After Phase 3** (R3-9 green) | R3-1 | Merging after Phase 2 brings the service onto `main` earlier, but leaves engine hooks on the branch longer. |
| D8 | Collector grid and cadence if VR-1 shows the keyed tier is too tight | Full grid / 6 notionals / sell every run and buy every second run | **Full grid at the spacing VR-1 allows**, provided a run finishes in ≤ 10 min | P0-1 | Otherwise: sell side every run (it matters for exit), buy side on alternate runs. The cadence is written into every row (`runId`, `grid`). |
| D9 | Jupiter Lend source | HTTP API / raw account decode / SDK | **HTTP if found in P0-2's timebox, else raw accounts** | P0-2 (collection), R4-1 (decode) | Neither found by P0-2: Jupiter Lend history starts at R4-2, and §6 P0 check 3 is partial (recorded) |
| D10 | τ for the mainnet demo policy | `impactTolerancePct` default / tighter, set from measured curves | **Chosen at R3-9 from the stored curves, written into the policy before the proposal runs** | R3-9 | A breach exists only under a tolerance the policy actually states. The value and its reason go in STATE-RISK. It is never tuned after seeing the proposal. |

## 7. Risk register

| # | Risk | Likelihood | Impact | Early signal | Mitigation | Retired in |
|---|---|---|---|---|---|---|
| R-1 | Jupiter rate limits corrupt the time series | **High** (seen: old job keyless, 115/416 rows `429` on Sep 30; key added Oct 1 per Q8) | Thin buckets, biased toward quiet hours | `risk:coverage` 429 share per run | VR-1 sizes spacing; D8 thins the buy side; errors stored as rows; per-point sample counts and `insufficient` flags | P0-2 (partially), R1-3 |
| R-2 | Sparse weekend samples make regime curves unreliable | Medium | Weekend capacity and ρ wrong, so caps and breach are wrong | Weekend samples per grid point after Oct 4 | Two weekends before Phase 1; D3 keeps hour-of-week descriptive; `insufficient` curves cap nothing silently: the solver treats them as capacity 0 and says so | R1-1 |
| R-3 | Quote impact diverges from realised slippage | Medium | Capacity overstated | `risk:slippage` on Sep 30 executions | Reported on the methodology page; D4 can add a second source; `curveQuantile` can move to a pessimistic quantile | R2-6 |
| R-4 | Kamino weekend price band unreadable from Scope config | Medium | Gap simulator's "unliquidatable while closed" undefined | VR-3 cannot locate the band field | `bandPct` becomes a labelled `assumption` input with the reason; the output says "band not read" | R4-1 |
| R-5 | Jupiter Lend vault API or layout changes | Medium | Market page breaks or shows stale data | Decoder errors in `risk-import` | Raw snapshots stored before decoding; decoder version in `method_version`; errors render as errors, never as zeros | R4-2 |
| R-6 | The solver change alters existing plans unexpectedly | Low (opt-in), high impact | Hackathon plans and demo change | `engine-baseline.test.ts` diff | No-provider baseline frozen in R3-1 before any hook; every hook slot re-runs it | R3-1, R3-3..R3-6 |
| R-7 | Liquidity orders conflict with band invariants | Medium | A proposal violates a band, or sells into an over-band asset | New `policy.test.ts` invariants fail | Liquidity orders go only to `usdc` and only reduce illiquid legs; post-order weights are checked against band max; on conflict the band wins and the residual shortfall is reported | R3-6 |
| R-8 | Second launchd job disturbs the first (shared IP window, overlap) | Medium | Old weekend series (cannot be re-collected) loses rows | Old job's 429 share before vs after install (same hours) | Separate env file and key; fixed-minute schedule offset from the old job's phase; mtime guard waits if the old file was written < 30 s ago; uninstall the new job if the old 429 share rises | P0-2 (+ Oct 2 check) |
| R-9 | Laptop asleep during collection | **High** (`fetch failed` rows already present) | Gaps on the weekends that matter most | Missing runs in `risk:coverage` | Founder keeps the laptop on power with sleep disabled for Oct 3–4 and Oct 10–11 (`sudo pmset -c sleep 0` or `caffeinate -s`); gaps reported, never interpolated | Oct 12 (D6) |
| R-10 | Scope creep into the agent layer or the design system | Medium | Phases 3–4 slip | Any slot touching `apps/web` beyond the listed pages, or an "agent" module | Out-of-scope list from `HANDOFF-RISK.md` §4 in STATE-RISK; plain UI; discoveries logged, not built | Ongoing, reviewed at R2-6 and R3-9 |
| R-11 | `main` moves through Oct 12 and conflicts with `risk-layer` | Medium | Merge pain in Phase 3 | `git merge-base` drift | Phases 0–2 touch only new files; merge `main` into `risk-layer` on Oct 13 before R1-1 and again at R3-1 | R3-1 |
| R-12 | Primary-path acceptance wording vs settlement assumption (Q5) | Certain ambiguity | §6 P1 check 2 read two ways | — | Default in Q5; the response lists the path and status either way | R1-4 |
| R-13 | No sell-side liquidity at all for a new xStock (VR-2 passes, routes fail) | Medium | Curve empty | Sell rows all error | Asset kept with `insufficient`; score 0 with reason; not dropped silently | R1-3 |

## 8. Acceptance mapping (`HANDOFF-RISK.md` §6)

| # | Check | Slot | Artifact that proves it |
|---|---|---|---|
| P0.1 | `~/.colosseum/risk/YYYY-MM-DD.jsonl` grows every 15 min with sell and buy rows for 8 assets × 8 notionals; 429s are rows | P0-2 | `risk:coverage` output in STATE-RISK; file listing |
| P0.2 | Existing `com.colosseum.depth-snapshot` unchanged and still writing (mtime) | P0-1 (first check), P0-2, daily | `stat` output in STATE-RISK; `git diff main -- scripts/depth-snapshot.mjs scripts/launchd/` empty |
| P0.3 | Hourly Kamino and Jupiter Lend market rows with `source` and `fetched_at` | P0-2 | `~/.colosseum/risk/markets-*.jsonl`; D9 note if Jupiter Lend is partial |
| P1.1 | `risk:report` prints weekend and market-hours sell curves, `maxNotionalAt(1%)`, ρ | R1-6 | `docs/risk/report-2026-10-15.txt` |
| P1.2 | `recoverable(spyx, $50k, Sat 10:00Z, 24h)` DEX only; at 72h primary path labelled `assumption` | R1-4 | `tests/risk-layer/recoverable.test.ts` |
| P1.3 | Breach fixture: base `false`, dry `true`, orders remove it; cash fixture: neither | R1-5 | `tests/risk-layer/breach.test.ts` |
| P1.4 | Deterministic, unit-tested, no literals outside `fixtures/` | R1-6 | `no-yield-literals.test.ts` (extended); determinism assertions in each test file |
| P2.1 | `GET /risk/assets/spyx/depth?side=sell&regime=weekend` returns curve with samples, dates, method version | R2-3 | `docs/risk/evidence/r2-3.json` |
| P2.2 | `POST /risk/positions/assess` reproduces Phase 1 fixture | R2-4 | API test (deep-equal with R1-5 output) |
| P2.3 | `apps/risk-api` serves only `/risk/*` and `/docs` | R2-4 | `/docs` listing and `/plans` 404 in STATE-RISK |
| P2.4 | Dashboard: curves per regime, heatmap, methodology with §3.3 lines | R2-5, R2-6 | `docs/screenshots/r2-5-*.jpg`, `r2-6-*.jpg` |
| P3.1 | No provider: every existing test and snapshot passes unchanged | R3-1 (then every R3 slot) | `engine-baseline.test.ts`; empty snapshot diff |
| P3.2 | With provider: SPYx/QQQx weights fall past weekend capacity; binding text names regime and capacity | R3-3 | `solver-liquidity.test.ts` |
| P3.3 | `liquidity` block per stock leg; also USDY and syrupUSDC for income and accumulation | R3-5 | `risk.test.ts` |
| P3.4 | `liquidity_dry` in stress table for stock plans; `liquidityOk` changes with exit cost | R3-4 | `schedule-liquidity.test.ts` |
| P3.5 | Monitor shows `liquidity_breach` for a fixture policy; invariants hold | R3-6, R3-8 | `policy.test.ts`; `docs/screenshots/r3-8-monitor.jpg` |
| P3.6 | One mainnet rebalance from a `liquidity_breach` proposal, user-signed, explorer link | R3-9 | `executions` and `rebalances` rows; Solscan link in STATE-RISK |
| P4.1 | `GET /risk/markets` lists Kamino reserves and Jupiter Lend vaults with on-chain params, source, timestamp, dispersion | R4-2 | Response saved to `docs/risk/evidence/r4-2.json` |
| P4.2 | Gap simulator: liquidatable at reopen and unliquidatable while closed, assumptions listed | R4-3 | `gap` API test and saved response |
| P4.3 | Lending leg in registry, gated by pool score, haircut `HC-LEND-RWA`, appears only when score passes | R4-4 | `registry.test.ts`, solver test |
| P4.4 | Borrow capacity for a SPYx wallet: capacity, liquidation distance, thinnest hour; no borrow | R4-5 | API test asserting no transaction built |

**Verification tasks** (`HANDOFF-RISK.md` §7; results go to `docs/VERIFICATION-RISK.md`, values dated, never copied into this plan):

| Id | Item | Slot | How | If it fails |
|---|---|---|---|---|
| VR-1 | Jupiter keyed quote tier | P0-1 | Burst of keyed `GET api.jup.ag/swap/v1/quote` calls. Record `x-ratelimit-*` headers, the call that first returns 429, and the window reset. Compare with the plan shown on portal.jup.ag. | D8: thin buy side or grid; spacing set from the measured window |
| VR-2 | Mints for TSLAx, NVDAx, AAPLx, GOOGLx | P0-1 | V6 method: `lite-api.jup.ag/tokens/v2/search` (verified tag), then `getAccountInfo jsonParsed`. Must be Token-2022 with the same extension set and mint authority / hook program as SPYx. | Asset left out of the collector and recorded; no guessed mint |
| VR-3 | Kamino xStocks reserves, `ReserveConfig`, Scope band | R4-1 | klend-sdk `KaminoMarket.load` on each market found in P0; `reserve.state.config`; Scope `OracleMappings` / price-chain config for the xStocks tokens; cross-check against the raw bytes stored since Oct 1 | Band → labelled assumption (R-4); a reserve not found → removed from `/risk/markets` with a note |
| VR-4 | Jupiter Lend `getVaultConfig()` for SPYx/QQQx/TSLAx/NVDAx | R4-1 | Source chosen in D9; compare decoded collateral factor and liquidation threshold with the vault UI | Vault shown as `unverified` and excluded from the dispersion table |
| VR-5 | Obligation enumeration | R4-1 | One filtered `getProgramAccounts` on the paid RPC; record latency, size and cost | D5 = no |
| VR-6 | Primary redemption terms (window, minimum, KYC, settlement; Ondo 24/7 limits) | R1-1 | `docs.xstocks.fi` FAQ and terms, the Ondo blog and docs; a primary source per field or `assumption` | Field stays `assumption`; only values change, not code |
| VR-7 | Quote impact vs realised slippage | R2-1 (method), R2-6 (report) | `executions` rows (Sep 30 SPYx/QQQx buys onward): realised rate from the confirmed transaction's balance changes vs the quote at build time | D4 |
| — | Direct pool reads as a second source | Not scheduled | Decision D4 | — |

## 9. Open questions for the founder

Answered on 2026-10-01 unless marked OPEN.

| # | Question | Answer |
|---|---|---|
| Q1 | Impact tolerance τ (`impactTolerancePct`)? | **1%** (founder accepted the recommendation) |
| Q2 | Share of measured capacity the solver may plan to use (`shareOfDepth`)? | **OPEN.** Recommendation: 0.25; reasoning given to the founder |
| Q3 | Which xStocks? | **OPEN.** Founder asked for all of them. Proposal: all verified xStocks in tiers (§9a) |
| Q4 | `liquidity_dry` multiplier? | **Agreed:** `d = max(dryFactorFloor, min(1, ρ))`, `dryFactorFloor` 0.25; if ρ is `insufficient`, `d = dryFactorFloor` |
| Q5 | Does a too-slow issuer redemption count in a 72 h answer? | **OPEN.** Re-asked in plain words. Default: listed as "too slow for this horizon", not counted |
| Q6 | Rate limit on third-party `/risk/*`? | **None while local; limited when deployed live** |
| Q7 | Phase 1 start date? | **OPEN.** Re-asked in plain words. Default: Tue Oct 13 |
| Q8 | Re-install the old collector with the Jupiter key? | **Yes.** Done 2026-10-01 ~00:30Z with `pnpm depth:install-cron`. The script was unchanged (the deployed copy differed from the repo only in formatting); the env file now has the key. This is the one approved exception to "do not touch the existing job". |

### 9a. Asset coverage (proposal for Q3)

The limit on coverage is Jupiter's quote rate, not RPC. Each asset costs 16 quotes per run (8 notionals × 2 sides); RPC is used only for hourly market snapshots. VR-1 gives the quote budget per 15 minutes. The proposed tiers:

- **Tier 1, every 15 min:** SPYx, QQQx, TSLAx, NVDAx, AAPLx, GOOGLx, MSTRx, HOODx (the xStocks lending markets accept as collateral, subject to VR-2), plus USDY and syrupUSDC.
- **Tier 2, rotating:** every other verified xStock. Each is quoted at least hourly, sell side first.
- **Discovery:** P0-1 enumerates xStocks from Jupiter token search (verified tag, Token-2022, same mint authority and hook as SPYx) and stores the list with `source` and `fetchedAt`. No mint is typed by hand.
- An asset with no route is kept and shown as "no measurable depth". That is a result, not a gap.

Tier 2 cadence is set in P0-1 from the measured budget (D8). If the budget allows every asset every 15 min, the tiers collapse into one.

## 10. Plan self-check

- **(a) Nothing touches the existing collector, its data or `main` before Oct 12.** Confirmed, with one approved exception: Q8, a key-only re-install of the old job on Oct 1 (script unchanged). Phase 0 writes new files only: `risk-collect.mjs`, a new plist, `install-risk.sh`, `~/.colosseum/risk/`. It only `stat`s the old file. All commits go on `risk-layer`. The fold (D6) and the first merge from `main` happen on Oct 13.
- **(b) `packages/risk` has no import from `packages/engine`.** Confirmed by design (§3) and enforced by `tests/risk-layer/boundary.test.ts` from R1-1.
- **(c) The no-provider path is proven before any engine change.** Confirmed. R3-1 freezes `engine-baseline.test.ts` on the unchanged engine. Engine hooks start at R3-3, and each one re-runs it.
- **(d) Every §7 unverified item the build depends on has a verification task in the first slot of its phase.**
  - Phase 0, P0-1: Jupiter tier (VR-1), four mints (VR-2).
  - Phase 1, R1-1: redemption terms (VR-6).
  - Phase 2, R2-1: slippage (VR-7).
  - Phase 4, R4-1: Kamino config and Scope band (VR-3), Jupiter Lend (VR-4), obligations (VR-5).
  - Direct pool reads are not a dependency (D4).
- **(e) Every §6 check maps to a slot.** Confirmed: 21 of 21 in §8.
- **(f) No depth, yield or price figure appears as a fact in the plan.** Confirmed. Numbers here are parameters with defaults (τ, grid bounds, `shareOfDepth`, `dryFactorFloor`), dates, slot counts, or the dated health counts of the existing collector's file (rows and errors, not market values). Dossier figures (LTVs, volumes, settlement days) are not carried; they are verification targets.
- **(g) Phase 0 fits in ≤ 2 slots and starts Oct 1.** Confirmed: P0-1 and P0-2, Thu Oct 1 AM and PM.
