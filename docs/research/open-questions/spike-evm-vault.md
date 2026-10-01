# Spike: can a contract vault hold and trade stock tokens on Robinhood Chain and Base?

Run 2026-10-01, about 13:40-14:30 UTC (first hour of the US session). Code and raw outputs: `spikes/evm-vault/` (README there lists every command). Nothing was signed or sent to a real chain.

Labels: **[ran]** = executed here, output in `spikes/evm-vault/evidence/`. **[doc]** = primary source. **[unverified]** = not confirmed.

## Answer

**Yes on both chains.** A plain Solidity vault received, held, traded and returned NVDA on a Robinhood Chain fork, and did the same for NVDAc against live Base state in a read-only simulation. The one thing that does not work is forking Base with stock Foundry: B20 tokens are precompiles and anvil cannot run them.

| | Robinhood Chain (4663) | Base (8453) |
|---|---|---|
| Contract can receive / hold / send | Yes [ran, fork] | Yes [ran, eth_call on mainnet state] |
| Transfer-time gate on a fresh contract | None seen | None seen (policy 5 lets a new contract through) |
| Keeper swap from the vault | Yes: Universal Router 2.1.2, Uniswap v4 | Yes: Aerodrome Slipstream pool through a 40-line adapter |
| Gas, `keeperSwap` | 295,659 per tx (238,718 inside the call) | 267,603 inside the call, about 296k per tx (estimate) |
| Cost per swap | about $0.016 at 0.0201 gwei | about $0.005 at 0.006 gwei, plus a negligible L1 fee |
| Execution vs Chainlink feed, $10 | +0.31% (0.01% pool), +0.50% (0.3% pool) | +0.28% |
| Fork test with stock Foundry | Works | **Does not work** (`OpcodeNotFound`) |
| Real mainnet transaction | Not run | Not run |

## Robinhood Chain: what passed

Anvil fork at block 77417307 (13:40:11 UTC), 10 of 10 fork tests pass, and both $10 scripts ran end to end on the fork.

- **Receive, hold, send.** 0.05 NVDA moved from an impersonated holder (`0xd4EB…14a3`, a contract found from Transfer logs) into the vault, stayed there across a one-hour warp, then went to a fresh EOA and to the owner through `withdraw` / `withdrawAll`. Each transfer emits two logs (`Transfer`, `TransferWithScaledUI`). No registry or allowlist check fired. This closes open risk 2 in `research/vaults/evm-feasibility.md` as far as a fork can: a sequencer-level filter would not show up in a fork.
- **Swap.** 10 USDG -> 0.043279 NVDA through Universal Router 2.1.2 (`0x204FAca1764B154221e35c0d20aBb3c525710498`) and the hookless v4 pool `USDG/NVDA, fee 100, tickSpacing 1`. The older router `0x8876…0904` works with the same calldata.
- **Gas** (receipts from the fork): `keeperSwap` 295,659; deposit 70,149; approve 57,976; `withdrawAll` 79,481-96,581; vault deploy 1,375,512 (a full contract, not a clone). A 5-leg rebalance sent as five transactions is about 1.5M gas, about $0.08.
- **$1,000 leg** on the same pool: +0.35% vs feed, so about 0.04% of extra impact over the $10 leg.
- **The checks bite.** Reverts confirmed for: output routed to the keeper (caught by the vault's own balance delta, and by the value invariant when `minOut = 0`), a swap through a 90%-fee pool (value invariant), a non-keeper caller, a non-owner withdraw, an unlisted router.

Things the build needs to know:

1. **The v4 swap struct changed.** Universal Router 2.1.x expects `ExactInputSingleParams` with a `minHopPriceX36` field between `amountOutMinimum` and `hookData` ([v4-periphery IV4Router](https://github.com/Uniswap/v4-periphery/blob/main/src/interfaces/IV4Router.sol)). The older five-field struct reverts with empty data on both routers [ran]. Most examples online still show the old struct.
2. **Permit2 is in the path.** The router pulls through Permit2, so "exact approval" is two calls (token -> Permit2, Permit2 -> router, expiry = this block) and two calls to zero them. That is about 60k of the swap gas.
3. **There are 182 USDG/NVDA v4 pools, 131 with hooks**, several with fees of 50-99% [ran, `evidence/rh-usdg-nvda-pools.json`]. Usable hookless pools today: fee 3000/spacing 60 (deepest), fee 100/spacing 1. The keeper must pick the pool; the value invariant is what stops a bad pick.
4. **RPC.** The official endpoint returned a Cloudflare 403 after about 45 calls in a few minutes. `https://robinhood.drpc.org` (listed on chainid.network) served archive state at the pinned block and carried the whole fork. `robinhood-rpc.publicnode.com` refuses archive calls. `eth_getLogs` on the official RPC allows 10M-block ranges and 10k results.
5. **Anvil does not emulate ArbOS precompiles.** It did not matter for token, Permit2, router or Chainlink calls.

## Base: what passed and what did not

- **Fork: fails.** `eth_getCode(NVDAc)` is `0xef`. In an anvil fork every call to the token (`balanceOf`, `decimals`, `transfer`) returns `EVM error OpcodeNotFound`; `forge test` on a fork and `forge script` fail the same way [ran]. This confirms the guess in the feasibility note.
- **`eth_call` with state overrides: works** on `https://mainnet.base.org` [ran]. `script/base-sim.sh` injects a driver contract's bytecode at an unused address and gives it 100 USDC through a `stateDiff` on USDC's balance slot (mapping slot 9). One call then: deploys the vault, deposits 10 USDC, runs `keeperSwap` USDC -> NVDAc on the Aerodrome Slipstream pool `0x853F…7ab9`, checks the Chainlink invariant, withdraws in kind to `0x…bEEF`.
  - Received 0.04330827 NVDAc; execution 230.90 vs feed 230.27 (+0.28%, feed 760 s old); vault value 9.9995 -> 9.9724 USD.
  - Gas inside the call: `keeperSwap` 267,603, `withdrawAll` 32,055, vault deploy 1,255,618. `eth_estimateGas` for the vault deploy on its own: 1,384,957.
  - So a contract created seconds earlier passes the sender, receiver and executor policies, as holder and as the caller of `transfer`.
- **Venue.** USDC/NVDAc liquidity is in Aerodrome's pool from factory `0xf8f2…61Ef`. The classic Slipstream router `0xBE6D…18a5` belongs to a different factory (`0x5e7B…809A`) [ran], and Uniswap's Universal Router cannot call Aerodrome pools. The spike used its own adapter. The Uniswap v4 pools that hold NVDAc pair it with other B20 tokens at fee 0 (arbitrage routes), not with USDC, in the transactions I sampled. Production needs an aggregator (LiFi's diamond appears in live NVDAc routes) or Aerodrome's router for that factory [unverified which].
- **RPC.** `eth_getLogs` is capped at 2,000 blocks on the public endpoint, 10,000 on dRPC free.

### How to test Base instead

1. **`script/base-sim.sh` pattern** for anything that must see real B20 behaviour and real liquidity. Read-only, about one RPC call per scenario, usable in CI. Limits: one call, no multi-block scenarios, and USDC is the only balance that can be faked (B20 storage layout is not something to poke).
2. **Base's own Foundry fork.** `base/base-anvil` ships `base-forge` and `anvil --base`, which host the precompiles; base-std's docs describe fork tests against a chain that has them ([LIVE_PRECOMPILE_TESTING.md](https://github.com/base/base-std/blob/main/LIVE_PRECOMPILE_TESTING.md)). Prebuilt darwin-arm64 nightlies exist (latest 2026-09-03). **Not installed or run here** [unverified that a mainnet fork reads live token balances]. If it works, `test/RobinhoodFork.t.sol` ports to Base nearly unchanged.
3. **base-std mocks** (`MockB20Asset`, `MockPolicyRegistry`) etched at the real addresses for vault-logic unit tests, including the "issuer flips the policy to an allowlist" case.
4. **A $10 mainnet run** (below).

## Calibration notes for the vault rules

- **A leg loses 0.3-0.5% against the feed in normal conditions**, even at $10, because the pool price sits off a feed that only moves on a 0.5% deviation. The 1.25% EVM tolerance has room. The 2%-per-week loss cap does not if it is measured as vault value against the feed: four to six full-turnover rebalances would exhaust it without anyone misbehaving. Measure the cap against traded notional, or reset it on owner action.
- The spike's invariant values cash with its own feed (USDG read 0.99993). Fine, but a stablecoin feed blip would block keeper trades; consider pinning cash at $1 inside a band.
- Decimals differ per chain (NVDA 18 on Robinhood, NVDAc 8 on Base, cash 6, feeds 8). The vault reads them at construction; the same bytecode ran against both.
- The spike vault omits cooldown, weekly cap, market-hours gate, target-weight direction, recipe versions, guardian and clones. It is not a starting point for `contracts/`, only evidence.

## For agents

Requested by Thom: the product should be easy for AI agents to use and integrate with. What this spike shows for the EVM side:

- `keeperSwap` takes opaque router calldata and judges only outcomes, so an agent can bring any route from any venue and the vault decides. No per-venue integration is needed on the vault.
- Every refusal is a typed custom error with the numbers in it (`ValueFell(before, after)`, `OutputTooLow(received, minOut)`, `StaleFeed(feed, updatedAt)`), which an agent can decode and act on.
- An agent can dry-run any vault action with `eth_call` before paying for it, on both chains. On Base this is the only simulation that works, so the chain adapter should expose "simulate" as a first-class call rather than relying on a local fork.
- Suggested for the design: a per-vault `agent` slot with the keeper's exact limits that the owner sets and revokes in one call, and one view that returns balances, feed prices, feed ages and value in a single read.

## The $10 mainnet test (not run; needs Thom)

- Robinhood Chain: `forge script script/TenDollar.s.sol --rpc-url $RH_RPC_URL --account <name> --sender <addr> --broadcast --slow`. The same script broadcast cleanly on the fork.
- Base: `RPC=$BASE_RPC_URL SIGNER="--account <name>" ./script/ten-dollar-cast.sh base`. forge script cannot run on Base, so this uses `forge create` + `cast send`. The `rh` path of the same shell script ran on the fork; the `base` path has only been dry-run, though each step matches what `base-sim.sh` simulated.
- Both deploy a vault, deposit $10, keeper-swap into NVDA, and withdraw in kind to the signer. If the swap reverts the cash is still withdrawable.
- What only the real run can show: whether the Robinhood sequencer filters a contract-originated stock trade, and real L1 fee components.

## Could not be run or confirmed

- Any real transaction on either chain.
- `base-forge` fork tests.
- Which production router or aggregator serves the Aerodrome B20 pools, and whether 0x / 1inch / the Uniswap Trading API quote for a contract taker on 4663.
- Behaviour when the market is closed (feeds frozen): the run was inside the US session with feeds 150 s (Robinhood) and 760 s (Base) old.

## Sources

- Uniswap v4-periphery `IV4Router.sol` and `Actions.sol`: https://github.com/Uniswap/v4-periphery/tree/main/src
- base-std README and live precompile testing: https://github.com/base/base-std , https://github.com/base/base-std/blob/main/LIVE_PRECOMPILE_TESTING.md
- base-anvil releases: https://github.com/base/base-anvil/releases
- Robinhood Chain RPC list: https://chainid.network/chains.json (chain 4663)
- Addresses and feeds: `research/vaults/evm-feasibility.md`
- On-chain reads and simulations: Robinhood Chain block 77417307, Base block about 52,036,450, 2026-10-01
