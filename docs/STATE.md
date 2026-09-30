# STATE.md — slot status

Status: `todo | in-progress | done | slipped`. Evidence links point to files, test names, signatures or screenshots. Full slot definitions: `docs/PLAN.md` §4.

| Slot | Date | Workstream | Status | Evidence |
|---|---|---|---|---|
| D1-AM | Thu Oct 1 (run early, Wed Sep 30) | Setup + Verify | done | scaffold; `CLAUDE.md`; `packages/db/migrations/0000_*.sql` applied to local Postgres (15 tables); `docs/VERIFICATION.md` V1–V7; `pnpm lint && pnpm typecheck && pnpm test` green (12 tests) |
| D1-PM | Thu Oct 1 (run early, Wed Sep 30) | Exec plumbing | done (funding pending) | `packages/chain-solana`: `rpc.ts`, `jupiter.ts` (quote, `/swap`, `/swap-instructions`), `simulate.ts`, `wallet.ts`; demo wallet `GMhJgqo4MqSD29iDNQvHA5ksJeYQJZD2UKKAHqJQtFCh` created (`secrets/`, gitignored), **not yet funded**; registry (`packages/engine/src/assets/registry.ts`, 8 assets incl. abstract BRL leg) seeded via `pnpm db:seed`; `pnpm depth:import` loaded 112 rows into `depth_observations`; check `pnpm check:d1pm`: USDC→USDY $5 quote + swap build + `simulateTransaction` ok (58,374 CU, Jupiter success) using a **labelled proxy signer** (exchange wallet, sigVerify=false) because the demo wallet is unfunded; 18 tests green |
| D2-AM | Fri Oct 2 (run early, Wed Sep 30) | Exec: first mainnet txs | done | Three confirmed mainnet transactions from `GMhJ…tFCh`, 5 USDC each, rows in `executions` with explorer links: USDC→USDY swap [`2Aoz1bhv…ZaTv8a`](https://solscan.io/tx/2Aoz1bhvLDECQYbzJGxQdFnPADZddwhtZUsqQ9LV364mAZpREXMtKrQsXQJnRx2uZ5g7seETMQf7H6CTLEZaTv8a) (slot 452077892); USDC→syrupUSDC swap [`5UsayYGR…Vrj1fh`](https://solscan.io/tx/5UsayYGRmiTjuUsuYumFx7QLA54qcVF1mHPo4Y2udnUBmZYSCvZhbtTVdcVpSwmFzzaXgKt1TXN7f4YesVJrj1fh) (slot 452077905); Kamino USDC deposit incl. user-metadata + obligation init [`AuBoh4p3…tiNCoR`](https://solscan.io/tx/AuBoh4p3XHsKv59ke5beC3UtK83BiBpMTL6c6cZDWyzpD8rsBiH57A9FLgJKp1C7aEZTwCTYJhUdRDXVztiNCoR) (slot 452078448). Code: `chain-solana/sign.ts` (sign, send once, poll confirm), `chain-solana/kamino.ts` (deposit via klend-sdk + market LUT), `db/executions.ts` logger, `scripts/execute/d2am-*.ts`, `scripts/checks/positions.ts` |
| D2-PM | Fri Oct 2 (run early, Wed Sep 30) | Policy spike + decision | done | Decision in `docs/GATES.md` → POLICY: **A** for Token-program legs. Evidence: setup `3PCcL9bP…YoEu2y`, agent-only rebalance `351mCDMs…7qzVMa` (slot 452085568), balances verified on-chain; rows in `executions` (`approve`, `rebalance`; two earlier `failed` rows are the dropped fee-less attempts, accurate). Code: `chain-solana/compose.ts`, `delegate.ts`, `scripts/execute/d2pm-spike.ts`; tests `tests/compose.test.ts` |
| D3-AM | Sat Oct 3 (started Wed Sep 30) | Exec engine + `/transactions` | in-progress | Built: `chain-solana/executor.ts` (plan → ordered unsigned tx set, per-leg skip/error, BRL leg never executed), `compose.buildUnsignedV0`, `kamino.buildKaminoDepositUnsigned` (no-op signer), API `POST /plans/{id}/transactions` (creates `executions` rows in `built`) and `POST /executions/{id}/report`, `scripts/sign-and-send.ts` (partner reference flow with `--fail-leg`), `scripts/fixtures/insert-fixture-plan.ts`. Dry run on fixture plan `fc25d11a…`: 3 unsigned txs returned, all sign + simulate ok. Pending founder-run mainnet check: clean run (3 links) and forced failure on leg 2. |
| D3-PM | Sat Oct 3 (started Wed Sep 30) | Policy + rebalance #1 | in-progress | Built: `Policy` schema (+`mechanismByAsset`, `delegation`; migration 0001), `engine/policy/drift.ts` + `rebalance.ts` (pure, 6 tests: allow-list, owner destination, bands, interval, mechanism), `chain-solana/prices.ts` (Jupiter 1-unit sell quote), `positions.ts` (token balances + Kamino obligation), `rebalance-executor.ts` (order → delegated signed tx or unsigned user tx; lending orders reported unsupported until D7-AM), `buildApprovalsTx`, `scripts/execute/d3pm-rebalance.ts`. Policy `93f49547…` created for fixture plan; live propose: syrupUSDC over band → order syrupUSDC→USDY 2.29 USD delegated. Pending founder-run: `--step approve --send`, `--step run --send`. |
| D4-AM | Sun Oct 4 | UI skeleton | todo | |
| D4-PM | Sun Oct 4 | Registry + feeds + risk sheet | todo | |
| D5-AM | Mon Oct 5 | Solver (+ S1 decision, xStocks buy) | todo | |
| D5-PM | Mon Oct 5 | Schedule + stress | todo | |
| D6-AM | Tue Oct 6 | Parser + API + deploy | todo | |
| D6-PM | Tue Oct 6 | UI hero flow + high-risk execution (G-Nora latest) | todo | |
| D7-AM | Wed Oct 7 | Monitoring + rebalance #2 | todo | |
| D7-PM | Wed Oct 7 | FLEX-1 (BRS-1 or label + UI polish) | todo | |
| D8-AM | Thu Oct 8 | FLEX-2 (BRS-2 or S1 / hardening) | todo | |
| D8-PM | Thu Oct 8 | FLEX-3 (BRS-3 or friendly users) | todo | |
| D9-AM | Fri Oct 9 | Hardening + acceptance | todo | |
| D9-PM | Fri Oct 9 | FREEZE + video prep | todo | |
| D10-AM | Sat Oct 10 | Video dry run | todo | |
| D10-PM | Sat Oct 10 | Buffer | todo | |
| D11-AM | Sun Oct 11 | Recording | todo | |
| D11-PM | Sun Oct 11 | Package | todo | |
| D12-AM | Mon Oct 12 | Buffer | todo | |
| D12-PM | Mon Oct 12 | Submission | todo | |

## What changed vs plan

- **Kickoff ran on Wed Sep 30**, one day early, because the founder approved the plan the same day. The hackathon window opened Sep 14, so the commits are in-window.
- **Solana client library:** `klend-sdk` 12.x depends on `@solana/kit` 2.x, not `@solana/web3.js` v1. `packages/chain-solana` will use `@solana/kit`; the web app keeps the wallet adapter (web3.js v1) and receives base64 transactions, so the two never share objects. `docs/PLAN.md` §2 updated.
- **Jupiter works keyless** at a low tier (five requests per window on `x-ratelimit-remaining`). The 16-quote depth snapshot passes at 1.3 s spacing. A key from portal.jup.ag is still required in D1-PM for headroom during execution.
- **BRS has no DEX route** (`TOKEN_NOT_TRADABLE` on Jupiter) and only ~2,885 BRS exist on Solana. The BRL-leg cap parameter must be set from Nora's mint limits, not from DEX depth; there is no swap fallback for BRS.
- **xStocks are Token-2022 with transfer hooks, permanent delegate, pausable and default-account-state extensions.** Consequences: the delegated mechanism (A) needs hook-aware transfers for xStocks, so the D2-PM spike scopes A to Token-program legs first; the risk sheet must show `permanentDelegate` (issuer can move tokens) and `pausable`.
- **Issuer yield feeds are not machine-readable today.** Ondo's page renders inconsistent APY labels; Maple's app blocks non-browser fetches and its GraphQL API has introspection disabled. D1 records an aggregator stand-in (DefiLlama, labelled `aggregator_defillama`) for USDY and syrupUSDC; D4-PM implements `realised_30d` from on-chain price / exchange rate as the primary method. Kamino has a protocol API (`/kamino-market/{market}/reserves/metrics`) and the SDK on-chain read.
- **Local Postgres runs on port 5433** (5432 is held by another project's container) via plain `docker run` (this machine's Docker CLI has no `compose` plugin; `docker-compose.yml` is kept for CI and other machines).
- **Depth cron runs from `~/.colosseum`, not the repo.** macOS privacy controls block launchd agents from reading `~/Documents` (`Operation not permitted`), so `pnpm depth:install-cron` copies the dependency-free `scripts/depth-snapshot.mjs` to `~/.colosseum/` and the agent writes `~/.colosseum/depth/YYYY-MM-DD.jsonl` every 15 min. D4-PM imports those files into `depth_observations`. The laptop must stay awake over Oct 3–4.
- **pnpm 11** requires `allowBuilds` in `pnpm-workspace.yaml` and enforces a minimum release age (it auto-excluded a list of fresh packages); this is why `klend-sdk` resolved to 12.0.1 instead of 13.0.1.

## Discovered (out-of-slot notes)

- D3-AM: each `POST /plans/{id}/transactions` call creates fresh `executions` rows in `built`; rows never reported stay `built`. D7-AM monitoring should treat `built` rows older than the blockhash window as stale (or a cleanup marks them `failed: expired`).

- D2-PM: every hand-composed transaction must carry a SetComputeUnitPrice instruction; Jupiter `/swap-instructions` only includes one when `prioritizationFeeLamports` is requested. Two sends were dropped before this was fixed (logged as `failed`, no funds moved).
- D3-PM: the policy object must store the delegate approval amount per asset as the on-chain limit, and the mechanism per asset (`delegated` | `user_signed`), not one mechanism per policy.

- D2-AM: Kamino's `/kamino-market` (v1) config omits `lookupTable`; `/v2/kamino-market` has it (main market LUT `FGMSBiyVE8TvZcdQnZETAAKw28tkQJ2ccZy6pyp95URb`). The first deposit spends ~183k CU with 8 instructions (user metadata + obligation init + deposit); later deposits will be smaller.
- D2-AM: `sendAndConfirm` polls `getSignatureStatuses` (no websocket needed) and never retries; a timeout is logged as `failed` and a human rebuilds.
- D3-AM should reuse `d2am-first-txs.ts` leg loop as the `compose/` per-leg status model; the Kamino leg cannot share a Jupiter `/swap` transaction, so multi-leg plans are N transactions with per-leg rows, not one bundle.

- D1-PM: the founder's Chainstack RPC returns 403 for `getTokenLargestAccounts`; the public RPC rate-limits it. Avoid that method in product code.
- D1-PM: with the Jupiter key the quote tier shows `x-ratelimit-remaining: 9` per window (keyless: 4). Execution paths still space calls.
- D1-PM: the `/swap` endpoint is used for single-leg transactions; `/swap-instructions` is wired for the D2-PM delegated composition. Both honour `destinationTokenAccount`.
- D1-PM: the first demo keypair was retired unfunded after its private key was echoed into the chat session via the `!` prompt prefix (`secrets/demo-wallet.RETIRED-*.json`, never fund it). Wallet export must be run in a normal terminal window.
- D2-AM prerequisite: fund `GMhJgqo4MqSD29iDNQvHA5ksJeYQJZD2UKKAHqJQtFCh` with ~0.3 SOL and 100–150 USDC before Fri Oct 2 morning; re-run `pnpm check:d1pm` to see the simulation on the real wallet.

- Kamino main market has three USDC reserves; only `D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59` is the real one. Hard-coded in `scripts/lib.ts`; registry seed (D1-PM) must use it.
- `swap-instructions` silently ignores unknown parameters, so parameter acceptance proves nothing; the destination check compares the swap instruction's account list instead (V5).
