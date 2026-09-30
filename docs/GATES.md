# GATES.md — decisions with cut-offs

Source: `docs/PLAN.md` §5. Status is one of `OPEN | PASSED | FAILED | DECIDED`. A slot that needs a gate stops if the gate is `OPEN` (PROMPT-BUILD 2B).

| Gate | Status | Cut-off | Default if nothing arrives | Decided on | Facts / outcome |
|---|---|---|---|---|---|
| **POLICY** — rebalance mechanism | OPEN | D2-PM, Fri Oct 2 18:00 BRT | **C**: policy checks and proposes; user signs | — | D1 inputs (docs/VERIFICATION.md V5): Jupiter `swap-instructions` honours `destinationTokenAccount`; Squads v4 spending limits are transfer-only; Kamino deposit needs the owner signature; SPYx/QQQx are Token-2022 with `transferHook` + `permanentDelegate`, so a delegated transfer of xStocks needs hook-aware instructions. Mechanism A is scoped to Token-program legs (USDC, USDY, syrupUSDC) unless the spike also clears the hook path. |
| **G-NORA** — BRS mint approach | OPEN | D6, Tue Oct 6 18:00 BRT | **FAIL**: BRL leg labelled "BRS mint via Nora: integration in progress", excluded from execution | — | D1 facts: BRS (`BRSxQRUa…ZtUo`) is a plain Token-program mint, 6 decimals, ~2,885 BRS in circulation on Solana (V6); **not routable on Jupiter** (`TOKEN_NOT_TRADABLE`, V2), so primary mint is the only path. Founder to confirm: who mints, API/auth/sandbox, accepted inputs and chain, min/max, fees, FX source and spread, settlement, redeem path, KYB for the demo wallet. |
| **EVM-S1** — EVM adapter | OPEN | D5-AM, Mon Oct 5 | **Skip** | — | Build only if a partner confirms a pilot chain in writing, `STATE.md` has no `slipped` rows, and G-Nora has not passed. |
| **SOLVER** — form | OPEN | D5-AM, Mon Oct 5 | LP (`javascript-lp-solver`) + rules layer; greedy waterfall on infeasibility | — | |
| **FREEZE** — feature freeze | DECIDED | Fri Oct 9 18:00 BRT | — | 2026-09-30 | After the freeze: P0 fixes only (crash, wrong number, failed mainnet path), each with a test; no schema or dependency changes; `main` tagged `freeze`. |
| **B2** — second builder | DECIDED: no | D1-AM | No | 2026-09-30 | Solo. `[B2]` marks stay in the plan for a possible later hand-over. |
| **KAMINO-LEG** — SDK vs substitute | DECIDED: klend-sdk | D1-AM | klend-sdk | 2026-09-30 | `@kamino-finance/klend-sdk@12.0.1` loads the main market and reads the USDC reserve on public RPC (V3). Note: it depends on `@solana/kit` 2.x, not web3.js v1. 13.0.1 was published 2026-09-30 and is held back by pnpm's minimum-release-age policy; revisit only if 12.x breaks. |

## Founder items (not build tasks, recorded here when answered)

| Item | Status | Answer |
|---|---|---|
| Discord: can one submission win Solana and Base tracks? | OPEN | — |
| Which chain each LOI partner pilots on (Chainless, Picnic) | OPEN | — |
| Written permission to use partner names or logos in the embed | OPEN | default: unbranded |
| Regulatory position (who carries personalised-allocation liability) | OPEN | default: disclaimer on plan view, API docs, README, video |
