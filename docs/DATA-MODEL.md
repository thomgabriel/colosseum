# DATA-MODEL.md

Postgres, Drizzle ORM. Schema in `packages/db/src/schema.ts`, migrations in `packages/db/migrations/`. Enums mirror `packages/schemas/src/enums.ts` and a test keeps them in sync.

| Table | One line |
|---|---|
| `goals` | The goal text as typed, its language and the wallet that typed it. |
| `constraint_sheets` | Each parsed or user-edited `ConstraintSheet` for a goal, with `valid` and validation errors; origin `llm`, `user_edit` or `fixture`. |
| `assets` | The registry: kind (`usd_yield`, `brl_stable`, `cash`, `equity`), chain, mint, token program, eligible profiles, cap weight, mint path, static metadata (oracle, redemption, gates, issuer) and provenance. No yield numbers. |
| `yield_observations` | Every yield figure ever used: quoted, haircut, rule id, `source`, `method`, `fetched_at`, provenance. |
| `fx_observations` | USD/BRL, Selic and CDI observations with source and timestamp. |
| `depth_observations` | Jupiter quote depth by asset, side and notional (price impact, out amount, route); the xStocks weekend cron lands here. |
| `plans` | One solved plan per constraint sheet: profile, capital, solver version, binding constraints, disclaimer. |
| `plan_legs` | Weight, USD amount and reasoning per leg, linked to the yield observation it was priced on. |
| `schedules` | Month-by-month BRL rows for the base case (and each stress), with the liquidity check result. |
| `stress_cases` | Stress definitions (params) and outcomes per plan. |
| `risk_sheets` | The per-leg risk sheet as rendered at plan time (frozen JSON). |
| `policies` | Allowed assets, weight bands, trigger, withdrawal destination and mechanism (`delegated` or `user_signed`). |
| `positions` | Observed on-chain balances per wallet and asset. |
| `executions` | Every transaction built or sent: kind, status, signature, explorer link, amounts, provenance. |
| `rebalances` | A policy decision (trigger reason, proposed orders, mechanism) linked to the execution that carried it out. |

Provenance rule: any row that is not `live` (`mock`, `sandbox`, `fixture`, `prior_dataset`) must be labelled wherever it renders.
