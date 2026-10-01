# STATE-RISK.md — risk layer progress (branch `risk-layer`)

Steps are defined in `docs/PLAN-RISK.md` §3. Status: `todo | in-progress | done | blocked`. Evidence points to files, tests, commands or links.

| Step | Status | Evidence |
|---|---|---|
| 0. Decoders | done | Raydium CLMM, Orca Whirlpool, Meteora DLMM, Raydium CPMM in `packages/risk/src/pools/`. `tests/risk-layer/pools.test.ts` checks frozen mainnet accounts against same-pool Jupiter quotes: CLMM ≤ 2e-8, CPMM 3e-13 (with the Token-2022 transfer fee), DLMM 3e-5, Orca 3e-4 (adaptive fee not modelled). Liquidity rebuilt from ticks = stored liquidity exactly (CLMM, Orca). Commits `3299d86`, `df5b985`. |
| 1. Pool registry | in-progress | `pnpm risk:registry` (on-chain confirmation + search by mint per venue + TVL from vault balances); `pnpm risk:retier`. Tables `risk_pools`, `risk_pool_snapshots` (migration `0002_faulty_trauma.sql`, applied locally 2026-10-01). |
| 2. Pool collector | in-progress | `scripts/risk/collector/pools.ts`, installed by `pnpm risk:install-collector` as `com.colosseum.risk-pools` |
| 3. Quote cross-check | in-progress | `scripts/risk/collector/quotes.ts` → `com.colosseum.risk-quotes` |
| 4. LP concentration | todo | |
| 5. History | todo | |
| 6. Engine | todo | |
| 7. Service + dashboard | todo | |
| 8. Join | todo | |
| 9. Mainnet rebalance | todo | |
| 10. Lending markets | todo | |

## Discovered

- 2026-10-01: the old depth job ran without the Jupiter key (`~/.colosseum/env` had no key); 115 of 416 rows on Sep 30 were `429`. Re-installed with the key (founder approved); the script is unchanged.
- 2026-10-01: Chainstack rate-limits `getProgramAccounts` per method ("Too many requests for a specific RPC call"), despite the unlimited plan. Scripts back off (0.5 s doubling, 8 attempts); the collector calls `getProgramAccounts` only hourly or when a tick map is stale.
- 2026-10-01: an on-chain search by mint finds far more pools than DexScreener; for example, 531 Raydium CLMM pools have SPYx as token 0. Most are dust; pools below `MIN_POOL_TVL_USD` are tier X and are not collected.
- 2026-10-01: the Byreal CLMM fork decodes at header level, but its tick arrays differ from Raydium's. It is excluded until it has its own decoder.
- 2026-10-01: some transactions are now version 1; `getTransaction` needs `maxSupportedTransactionVersion: 1` (Step 5).
- 2026-10-01: the risk tables live in the same local Postgres as the structurer (additive migration `0002`). If `main` adds its own `0002` before the merge, regenerate the risk migration at merge time.
