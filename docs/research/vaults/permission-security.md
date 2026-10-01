# Auto-follow permission: is "swap only, never withdraw" safe?

Researched 2026-10-01. Read-only: no transactions, no accounts. Claims carry a source link; anything marked **[unverified]** is from memory or inference and was not confirmed against a primary source in this session.

## Short answer

The permission is sound only if it limits the *value* a keeper can lose per trade and per period, not just *where tokens can go*. A swap is a withdrawal whenever the counterparty or the price is not constrained: value leaves as bad execution. Every permission framework I reviewed (Zodiac Roles, ZeroDev, Rhinestone, Brahma, Swig, Squads) scopes who / which contract / which token / how much. None of them checks price. dHEDGE and Enzyme, which are the closest production analogues, both had to add oracle-valued slippage accounting on top of their allowlists for exactly this reason.

So the guard has to be our own code on every chain: a single `rebalance` entrypoint that checks tokens against the recipe, measures the vault's own balance change, and compares it to an oracle price. The frameworks are useful as a second layer (caps, expiry, revoke), not as the guard.

## 1. The precedent that settles the question: trade-only API keys

Centralized exchanges have offered "trade, no withdrawal" API keys for years. In Oct–Dec 2022 about 100,000 3Commas-connected keys leaked. Attackers had no withdrawal rights and still drained accounts by trading victims' balances into low-liquidity pairs they had positioned in. One investigator verified 44 victims and $14.8M; one victim described "dozens and dozens" of trades selling everything into a low-cap coin. 3Commas confirmed the leak on 2022-12-28.

- https://www.bleepingcomputer.com/news/security/crypto-platform-3commas-admits-hackers-stole-api-keys/
- https://www.coindesk.com/tech/2022/12/28/anonymous-twitter-user-leaks-alleged-3commas-api-database
- https://wublock.substack.com/p/review-of-the-whole-process3commas

That is our keeper key. If it leaks, the attacker's playbook is: take a position in the thinnest allowlisted pool, make every follower vault buy it at a bad price, sell into that flow. GLDx has about $0.88M of DEX liquidity and QQQx $2.12M (`solana-liquidity.md`), so this is cheap to do without a price check.

## 2. How the manager-restricted vaults do it, and how value still leaked

### dHEDGE

Managers cannot withdraw investor funds; they can only call whitelisted contracts on whitelisted assets, enforced by per-contract and per-asset "guards".
- https://dhedgehog.gitbook.io/dhedge/dhedge-protocol/synthetic-asset-pools (old docs; `docs.dhedge.org` now redirects to `docs.chamberfi.com`, apparently a rebrand, **[unverified]**)

On top of the allowlists there is a `SlippageAccumulator` contract. Its NatSpec: "Contract to check for accumulated slippage impact for a pool manager." Mechanics, from the source:
- Values the source and destination amounts in USD with the pool factory's oracle; slippage = `(srcValue - dstValue) / srcValue`, counted only when negative for the pool.
- Adds it to a per-pool running total that decays over `decayTime`.
- Reverts with "slippage impact exceeded" above `maxCumulativeSlippage` (example value 5e4 = 5%).
- Only contract guards can call it.
- Source: https://github.com/dhedge/V2-Public/blob/master/contracts/utils/SlippageAccumulator.sol

Audit findings worth copying as test cases (https://github.com/santipu03/santipu03/blob/main/private-audits/dHEDGE_GMX.md, https://github.com/santipu03/santipu03/blob/main/private-audits/dHEDGE_SAW.md):
- A non-whitelisted manager added a GMX pool as a supported asset by calling `PoolManagerLogic::changeAssets` directly, bypassing the contract guard, and could then make all withdrawals revert. Lesson: every path that changes the asset list is part of the guard.
- Nested vaults: a manager could call `EasySwapperV2::initWithdrawal` with a malicious contract that returns a reverting ERC-20 as a "supported asset", blocking all withdrawals from the parent vault. Lesson for Q3: vault-holds-vault-shares adds a withdrawal path the manager can poison.
- Slippage accumulation was not reversed when a GMX market order was cancelled (M-07, partially mitigated). Lesson: async orders and accumulators mix badly; keep swaps atomic.

### Enzyme

Policy stack (https://specs.enzyme.finance/topics/policies):
- `AllowedAdaptersPolicy`: "Prevent fund managers from using arbitrary adapters." Cannot be disabled or updated.
- `AllowedAdapterIncomingAssetsPolicy`: restricts which assets a trade may bring into the vault.
- `CumulativeSlippageTolerancePolicy`: tracks value lost through adapter actions over a 7-day tolerance period; loss is added to a running total that decays linearly. Stated purpose: "Slow the rate at which a malicious manager can drain a fund enough to allow alerting and exiting." Council-listed adapters "that cannot be manipulated by asset managers to steal fund value" bypass it.
- `OnlyUntrackDustOrPricelessAssetsPolicy` and `OnlyRemoveDustExternalPositionPolicy`: stop a manager hiding value in untracked assets or positions.

Enzyme's own framing is that the slippage policy slows a drain; it does not prevent it. The design assumes someone is watching and can exit.

Share-price arbitrage is a separate, shared-pool-only problem: "Investors can arbitrage temporarily mispriced shares or mispriced assets held by a fund by depositing and/or redeeming", mitigated with entrance fees and a shares-action timelock (https://specs.enzyme.finance/topics/known-risks-and-mitigations). Own vaults do not have this problem because there is no share price.

### The extraction routes, as a checklist

| Route | Works against | Stopped by |
|---|---|---|
| Swap through a pool the attacker controls or has pre-moved | allowlist-only vaults | oracle-anchored min-out measured on the vault's own balance |
| Wash-trade back and forth, losing the tolerance each time | per-trade slippage check alone | drift-reducing-only rule, cooldown, cumulative loss budget |
| Route calldata sets the recipient to the attacker | "may call router X" permissions | measure vault balance delta; never trust router return values |
| Swap into a token the attacker issued or that cannot be sold | permissionless asset lists | platform-curated asset allowlist, by address |
| Leftover approval to a router that is later exploited | infinite approvals | exact-amount approval, reset to zero in the same call |
| Change the asset list through a side door | guards on the swap path only | every recipe-mutating path gated and versioned |
| Poison a withdrawal path (reverting token, nested vault) | vaults that swap on withdraw | in-kind withdrawal that never calls a router |

Router-approval drains are a real category, not a hypothetical: Socket/Bungee (Jan 2024) and LI.FI (Jul 2024) both lost user funds through arbitrary-call bugs reachable via standing approvals **[unverified this session; from memory]**.

## 3. What each permission framework can and cannot express

### EVM (Base, Robinhood Chain)

**Zodiac Roles Modifier v2 (Safe).** Scopes target, function and parameters with condition expressions, plus "allowances" that refill per period. The `allowCowOrderSigning` preset takes sell-token and buy-token lists and an optional receiver; the "swapper" recipe pins the receiver to the Safe so "swaps remain internal to the treasury". The docs warn: "Without an allowance, the policy permits unlimited swaps for that asset." No price check; the role member chooses the limit price.
- https://docs.roles.gnosisguild.org/general/allowances
- https://docs.roles.gnosisguild.org/sdk/api
- https://docs.zodiac.eco/guides/recipes/swapper
- In production for the ENS endowment: https://discuss.ens.domains/t/ep-5-12-roles-modifier-v2-migration-updates-to-endowment-permissions/19173

**Brahma Console.** Sub-accounts are Safes owned by the main account; registered "executors" act on them under protocol / asset / time policies; a Safe guard (`SafeModeratorOverridable`) calls a `TransactionValidator`. Enforcement is described as "on-chain and off-chain", so part of the policy check depends on Brahma's validator.
- https://docs.brahma.fi/brahma-accounts/brahma-pro/team-management-and-access-control/sub-accounts
- https://github.com/code-423n4/2023-10-brahma

**ZeroDev / Kernel permissions.** Signer (ECDSA, passkey, multisig) plus policies: call (target, selector, argument conditions), gas, signature, rate-limit, timestamp, sudo. https://docs.zerodev.app/sdk/permissions/intro. The Robinhood Chain notes list ZeroDev as supported there (`ecosystems/robinhood-chain.md`).

**Rhinestone Smart Sessions (ERC-7579).** Session keys with policies: Universal Action (calldata-offset conditions), Spending Limit, Time Frame, Usage Limit, Value Limit. https://docs.rhinestone.dev/smart-wallet/smart-sessions/overview

**ERC-7715 (`wallet_grantPermissions`).** A request format: the dapp asks, the wallet's account enforces. Support depends on the user's wallet, so it cannot be the only path for "bring your own wallet" users. https://eco.com/support/en/articles/11953354-erc-7715-explained-wallet-permissions-sessions-and-subscriptions

**EIP-7702.** Avoid asking users to sign a delegation. Research presented at USENIX Security reportedly found 63% of sampled 7702 authorizations pointed at malicious contracts with $2.3M+ in confirmed thefts, and a separate analysis found 97%+ of delegations went to identical "sweeper" code (figures from secondary coverage; I did not open the paper). Re-delegation also keeps old storage, so a new delegate can misread it; OpenZeppelin recommends ERC-7201 namespaced storage for any 7702 delegate.
- https://arxiv.org/pdf/2512.12174
- https://www.tradingview.com/news/newsbtc:db38b61bf094b:0-eip-7702-wallet-delegation-faces-scrutiny-after-phishing-research/
- https://www.nethermind.io/blog/eip-7702-attack-surfaces-what-developers-should-know
- https://blog.base.dev/securing-eip-7702-upgrades

**What this means on EVM.** A session key scoped to a generic aggregator router (1inch, 0x) is not "swap only": the route is opaque nested calldata with its own recipient field and arbitrary executors, and argument conditions cannot bound the price. Scoping to a single Uniswap pool call can pin `recipient` and the token pair, but `amountOutMinimum` is still the keeper's choice. Either way an oracle check needs a contract of ours. Once that contract exists, the simplest structure is the dHEDGE/Enzyme one: a per-basket vault contract owned by the user, with a keeper role that can call exactly one function. No session-key framework is required for the MVP. The same Solidity runs on Base and Robinhood Chain.

### Solana

**Swig.** Action types (https://build.onswig.com/protocol/concepts-and-permissions.md, https://build.onswig.com/developer-sdk/permissions.md):
- Broad: `All`, `AllButManageAuthority`, `ManageAuthority`.
- Spend: `SolLimit`, `SolRecurringLimit`, `TokenLimit` ("a total allowance for one token mint"), `TokenRecurringLimit`, and destination variants (`mint`, `amount`, `destination` token account).
- CPI: `Program` ("Invoke one specified program through the wallet", keyed by `programId` only), `ProgramCurated`, `ProgramAll`, `ProgramScope` (binds a program, a target account and numeric field offsets; not exposed in the Developer SDK's `AddRoleAction`).
- "Program access and asset spending are checked separately ... Granting `program`, `programAll`, or `programCurated` alone does not grant an unlimited SOL or token allowance."
- Time-bounded permissions count slots, not seconds.
- Audit: Accretion, 2025 (https://build.onswig.com/protocol/security-and-audits.md).

Not documented on the pages I could read: how spend is measured (balance diff on which accounts), whether inflow offsets outflow in a swap, and Token-2022 handling.

The gap for our use: `Program` is keyed by program ID only. A role with `Program(Jupiter)` plus a `TokenRecurringLimit` on USDC can call Jupiter with any route, any output mint and, as far as the docs say, any destination token account. Jupiter's swap takes a destination token account, so that role can swap the vault's USDC into the attacker's account up to the limit **[inference from documented semantics; needs a devnet test]**. A Swig role alone gives "bounded loss per period", not "never withdraw", and gives no price protection.

**Squads v4 spending limits.** Fields: members, mint, amount, period (one-time or resetting), destinations ("If empty, funds can be sent to any address"). It lets a member transfer out without a proposal. It is a withdrawal permission and has no swap concept, so it does not fit. https://docs.rs/squads-multisig/latest/squads_multisig/state/struct.SpendingLimit.html, https://squads.xyz/blog/spending-limits

**What this means on Solana.** The guard has to be a small program of ours. Two shapes:

1. *Bracketed swap* (recommended). Vault token accounts are owned by a program PDA. One transaction holds three top-level instructions: `begin_rebalance` (checks the recipe, cooldown and caps, snapshots balances, releases exactly `amount_in`, and uses the instructions sysvar to require a matching `end_rebalance` later in the same transaction), the Jupiter swap, and `end_rebalance` (requires the vault's output account to have grown by at least the oracle-derived minimum, and the input account to have fallen by no more than `amount_in`). If the end check fails everything reverts. Jupiter stays at the top level, which avoids CPI depth and account-count limits. Drift's `begin_swap` / `end_swap` works this way **[unverified this session; from memory]**.
2. *CPI wrapper.* The guard program CPIs into Jupiter and checks balances around the call. Simpler to reason about, but with Token-2022 mints the call stack is guard → Jupiter → AMM → Token-2022, which sits at the classic depth limit, and long routes may not fit **[inference]**.

Swig can still sit in front as the user's wallet (passkey sign-in, revoke, a hard recurring token cap as a second line), but the bracket cannot be enforced through a Swig `Program(Jupiter)` role, because that role could call Jupiter without the bracket.

Token-2022 specifics for the guard: compare raw amounts and apply the scaled-UI multiplier exactly once when valuing; treat a paused or frozen mint as "rebalance fails, vault unchanged"; reject any mint whose transfer-hook program is set (xStocks have the slot empty today); the issuer's permanent delegate can seize regardless of anything we build, which is a disclosure item.

## 4. Front-running a public index change

Two different problems share this name.

**Mempool sandwiching.** Less of an issue than it sounds on these three chains. Base and Robinhood Chain (Arbitrum stack) have a single sequencer and no public mempool **[inference; not re-verified]**. On Solana, Jupiter Ultra lands transactions through its own engine (Beam) with "complete transaction privacy until on-chain execution" and sets slippage with its Real-Time Slippage Estimator; Jupiter's older "MEV Protect" sends directly to Jito validators.
- https://developers.jup.ag/docs/ultra
- https://www.theblock.co/press-releases/375289/jupiter-launches-ultra-v3-the-ultimate-trading-engine-for-solana
- https://x.com/JupiterExchange/status/1831698316557701612

**Predictive front-running.** This is the real one. A recipe change is public the moment it is published, every auto-follow vault will trade the same direction in the same thin pools, and anyone (above all the creator) can buy first and sell into the flow. No private order flow fixes this, because the attacker does not need to see our transactions. Copy-trading products have the same structure; bot builders already treat "the wallet you copy can buy a honeypot or bait you" as a baseline risk (https://rpcfast.com/blog/how-to-build-a-solana-copy-trading-bot).

How index products deal with it:
- **Index Coop** moved from DEX-only rebalances to an `AuctionRebalanceModule` (2023): single-asset Dutch auctions where bidders compete, because DEX-only rebalancing showed up as NAV decay. Its leverage tokens chunk trades (TWAP) with a cooldown so pools are arbitraged back between chunks.
  - https://docs.indexcoop.com/index-coop-community-handbook/protocol/index-protocol/modules/auction-rebalance-module
  - https://www.indexcoop.com/blog/introducing-auction-rebalancing
- **Set Protocol v1** used Dutch auctions for rebalances. https://help.tokensets.com/en/articles/3399436-how-to-participate-in-set-protocol-rebalance-auctions
- **CoW Protocol** batch auctions give all orders in a batch one clearing price and take orders as signed intents; Zodiac's swapper recipe uses it for that reason. Listed as a venue for Coinbase stock tokens on Base (`ecosystems/base.md`). Availability on Robinhood Chain **[unverified]**.
- **Cesto** only fires auto-rebalance when the curator publishes a new version (`compose/cesto-and-rivals.md`); I found no published front-running mitigation.

What works for us, in order of value per day of work:

1. **Oracle-anchored min-out.** If someone has pushed the pool above the reference price plus tolerance, the rebalance reverts and the keeper retries later. The front-runner is left holding inventory with no forced buyer. This is the same check that contains a leaked keeper key, so it is one piece of code for both threats.
2. **Stock legs trade only while the oracle is live.** Chainlink equity feeds on Base and Robinhood Chain freeze on nights, weekends and holidays; a staleness check turns that into an automatic pause. The Solana notes recorded a −12% hour and a −27% wick in thin weekend pools.
3. **Jitter and chunking.** Random delay per vault inside a window, random vault order (otherwise early vaults get better prices than late ones), and split any order above a small share of pool depth.
4. **Creator rules.** Recipe assets only from the platform allowlist; a limit on weight change per update and on updates per day; a cap on weight × follower AUM relative to pool depth.
5. **Timelock on recipe changes** (12–24h between publish and first keeper action). This gives front-runners more notice, but it gives followers time to opt out of a hostile change, and item 1 already bounds the front-run cost. Creator abuse is the worse risk.
6. **Netting, batching, auctions.** Defer. In a recipe change every follower trades the same way, so netting saves little; it matters for deposits crossing withdrawals, which is a shared-pool feature.

## 5. Minimum guardrail list for the MVP

On-chain, required before any auto-follow is switched on with real funds:

1. **One entrypoint.** The keeper can call `rebalance` and nothing else. No generic execute, no transfer, no approve.
2. **Balance-delta accounting.** Output is whatever the vault's own token account gained. Router return values and route calldata are ignored.
3. **Asset allowlist by address/mint.** `tokenIn` and `tokenOut` must be in the vault's current recipe or its cash asset, and recipe assets must be on the platform list. Creators cannot add mints.
4. **Router allowlist.** Jupiter program ID on Solana; one or two fixed router addresses on EVM. Exact-amount approval, zeroed in the same call.
5. **Oracle min-out.** `value_out >= value_in × (1 − tol)`. Revert on stale price, on a wide Pyth confidence interval, and when the L2 sequencer-uptime feed is down. Multiplier applied once. Starting tolerances to calibrate on day 1: about 75 bps for stock and gold legs, 30 bps for dollar-yield legs (measured DEX cost at $10k was 4–11 bps, `solana-liquidity.md`).
6. **Drift-reducing only.** A leg may not trade more than the amount needed to reach its target weight, and no trade is allowed while the vault is inside its band on the current recipe version.
7. **Rate limits.** Cooldown per vault (for example 1h), turnover cap per day, and a cumulative loss budget with decay in the dHEDGE/Enzyme style (for example 2% per 7 days). With 5 and 7 together, a fully compromised keeper is bounded to about the loss budget per vault per week, assuming the oracle is honest.
8. **Owner controls that nothing can block.** Revoke auto-follow in one transaction; withdraw in kind at any time without touching a router; pin a recipe version. Pause must not affect any of these.
9. **Pause.** A guardian key can stop `rebalance` globally and per index. It cannot move funds.
10. **Versioned recipes with a timelock.** Recipe hash and `effectiveAt` on-chain; the keeper can only act on a version that is past its timelock; every path that changes a recipe goes through this.

Off-chain, same week:

11. Keeper key in a KMS, one per chain, holding no other authority and no funds beyond gas.
12. Simulate every rebalance; send through Jupiter Ultra or Jito on Solana.
13. Jitter, random vault order, chunking above a pool-depth threshold.
14. No stock-leg rebalances outside oracle hours or around a multiplier change's effective time.
15. Alert when rebalances revert on the oracle bound (it means someone is leaning on the pool) and when any vault's loss budget passes half.

Cut from the MVP: cross-vault netting, batch or Dutch auctions, CoW integration, session-key frameworks on EVM, 7702 delegation, anything cross-chain.

How to describe it to users: "the keeper can only trade between the index's assets, at no worse than X% from the reference price, at most Y% loss per week, and you can revoke or withdraw at any time". Do not say "cannot lose funds" or "cannot withdraw" without the price clause.

## 6. Open items to test on day 1

- Solana: does a Jupiter swap of SPYx from a program-PDA-owned Token-2022 account work inside a begin/end bracket, and does it fit in one transaction with a Pyth price update? Is there a live Pyth (or Chainlink) feed for each xStock underlying, and during which sessions?
- Solana: if Swig is the wallet, confirm how its token limits count a swap, and whether `Program` roles can be combined with a destination restriction.
- Base: is a vault contract address authorized under the B20 transfer policy (`isAuthorized(policyID, vault)`)? The notes say `approve()` bypasses policy gates, which may itself be a hazard for a contract holder.
- Robinhood Chain: can an arbitrary contract hold Stock Tokens, and is there a Chainlink feed for each token we list?
- All chains: the guard is new, unaudited code written in days. Cap deposits per vault and say so.
