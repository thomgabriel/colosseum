# Spike: Solana vault swap through Jupiter

Oct 1, 2026. Code and raw results: `spikes/solana-vault-swap/` (README has the commands and the mainnet steps). Nothing was sent to mainnet; mainnet was only read.

## Answer

A program-owned vault can buy SPYx (Token-2022) with USDC through Jupiter by CPI and check its own balances before and after. Proven on a local validator running mainnet's Jupiter and Raydium CLMM programs with the live pool and mint state cloned. Not yet proven on mainnet: that needs Thom's wallet (about 1.4 SOL, of which 1.265 is refundable program rent, and 12 USDC).

## Measured

Local validator, 10 USDC → SPYx, one transaction, v0 with Jupiter's lookup table:

| Route | Jupiter accounts | Tx accounts (limit 64) | Tx bytes (limit 1,232) | Compute units | Deepest invoke (limit 5) |
|---|---|---|---|---|---|
| Raydium CLMM, `route` | 28 | 23 | 611 | 83,404 | 4 |
| Raydium CLMM, `shared_accounts_route` | 32 | 26 | 712 | 96,575 | 4 |

- Received 1,301,508 raw SPYx against a quote of 1,301,487.
- The wrapper itself costs about 20,000 compute units.
- Invoke chain: vault → Jupiter → AMM → token program. Mainnet still caps CPI nesting at 4 (stack height 5): `solana feature status -um` lists SIMD-0296 (raise to 8) as inactive. One level is spare, so a keeper leg cannot also be wrapped in Swig or Squads if the AMM or a future transfer hook needs that level.
- Mainnet transactions built but not sent: $10–$1k legs are 19–23 accounts and 522–623 bytes; a $50k leg split over three pools is 38 accounts and 841 bytes (29 and 682 with `maxAccounts=30`).
- Deposit, swap and in-kind withdraw were rehearsed end to end locally; SPYx left the vault to the owner's wallet with a plain `transfer_checked`.

## Checks that held

| Attempt | Outcome |
|---|---|
| Output account swapped for an attacker's inside Jupiter's account list | Jupiter succeeded; the vault's own balance check rejected it (`ReceivedTooLittle`) |
| `min_out` above what the pool gives | Jupiter's own slippage check passed; the vault rejected it |
| Caller is not the owner | Rejected before the CPI |

This confirms design rule 3 in `design/technical-design.md` section 5: measure the vault's balances and ignore what the router reports.

## What changes in the design

1. **Ask Jupiter for direct routes or shared accounts on every vault leg.** Left to its default, Jupiter once returned USDC → another stock token → SPYx as a plain `route`, which expects the vault to hold a token account for the middle token and failed with Jupiter error 6025 `InvalidTokenAccount`. Use `onlyDirectRoutes=true` or `useSharedAccounts=true`, and reject a response whose setup instructions name a mint outside the recipe.
2. **Ignore Jupiter's setup instructions.** They create token accounts with the vault as payer, which a PDA cannot be at the top level. The owner (or keeper) pays for one token account per recipe mint when the vault is created.
3. **One PDA is enough.** The vault account that stores state also signs the CPI. Jupiter and Raydium accepted a program-owned account with data as the user. No separate authority PDA.
4. **Compute limit.** 200,000 units covers a single-pool leg; keep 400,000 until proprietary market makers and split routes are measured on mainnet.
5. **Program tests need plain AMMs.** Proprietary market makers (Riptide here) fail from a snapshot with `Oracle data is invalid`. Stream B's tests should pin `dexes=Raydium CLMM` and reuse `scripts/prepare-local.ts`; start-up is about 5 seconds. The adversarial cases listed for streams B and C in the design are runnable this way.
6. **Build.** Anchor 0.31.1 with the default platform-tools fails on an edition-2024 dependency. Build with `anchor build --no-idl -- --tools-version v1.54`, then `anchor idl build`. Pin `anchor-lang = "=0.31.1"`.
7. **Jupiter's keyless endpoint rate-limits fast** (429 after a handful of calls in a minute, likely because several agents share one IP). Get an API key, and have tests replay a saved route file.
8. **Deploy cost.** The spike binary is 248,904 bytes, 1.265 SOL of rent. The real program will be larger; 2–4 SOL is a guess, refundable on close.

## For agents using the product

The user asked that the product be easy for AI agents to use and integrate with. What the spike shows works:

- An agent needs three things to trade a vault: the IDL, the PDA seeds (`["vault", owner, basket_id]`), and a function that returns an unsigned transaction. `buildVaultSwapIx` in `scripts/common.ts` is that function for one leg; it is the shape of `buildOwnerRebalance` and `buildKeeperLeg` in the adapter interface.
- Every script prints one JSON object (accounts, bytes, compute units, balances before and after, named error). Keep that for the API: simulate first, return the simulation, send only when asked.
- Errors are named in the IDL (`ReceivedTooLittle`, `SpentTooMuch`, `OtherAccountDebited`, `AccountTampered`), so an agent can decide to requote or stop without reading logs.
- Publish the IDL on chain (`anchor idl init`) so agents can fetch it from the program id.
- Because the vault checks every trade, an agent holding the keeper role cannot take funds. That is the property to state in the agent docs.

## Not verified

- Any mainnet execution. Steps are in the spike README.
- Compute units and invoke depth through proprietary market makers (Riptide, Byreal, PancakeSwap were Jupiter's default picks today) and through split routes.
- `OtherAccountDebited` and `AccountTampered` have no test that triggers them.
- Jupiter's `route_v2` instructions (present in the on-chain IDL; the API returned v1).
- Whether every AMM accepts `useSharedAccounts=true`.
- Whether mainnet's Token-2022 build matches the one in the local validator (3.0.1).
- Keeper path, oracle check, loss cap: not in the spike.

## Sources

- https://github.com/jup-ag/jupiter-cpi-swap-example (starting point)
- Jupiter API: `https://lite-api.jup.ag/swap/v1/quote`, `/swap-instructions`
- Jupiter on-chain IDL, `anchor idl fetch JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4` (error 6025, v2 instructions)
- `solana feature status -um` (SIMD-0296 inactive), `solana rent 248904 -um`
- Raw run output: `spikes/solana-vault-swap/out/report-*.json`, `out/measure-routes.jsonl`
