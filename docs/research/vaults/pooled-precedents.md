# Pooled index precedents: how shared pools work and how they fared

Research date: 2026-10-01. Read-only web research. Tags: **[V]** verified this session from the cited page, **[S]** secondary source or search snippet only, **[M]** from memory and not re-checked, **[I]** my inference.

Caveat on method: most pages were read through a summarising fetch tool, so quoted sentences are as the tool returned them. Re-read the primary page before putting any quote in a pitch or relying on a number in code.

## Bottom line

- A pool buys three things separate vaults can't: one fungible share token (tradable, usable as collateral, trivially nestable), one rebalance for everyone, and identical returns for every holder.
- It costs three things: a share price that can be attacked, a manager or rebalancer who becomes a fiduciary over everyone's money, and a contract that must itself be an eligible holder of restricted stock tokens.
- Every pooled product that rebalances ended up building the same heavy machinery: governance timelock, role split, Dutch auctions, deposit lockups, loss caps, audits. None of it fits in 11 days.
- The pooled products that shipped fast on Robinhood Chain (reference dapp, Vimen) did so by removing rebalancing and the manager entirely: fixed composition, in-kind mint and redeem, immutable.
- Traction is weak everywhere. Index Coop is at $15.56M TVL with DPI sunset [S]; all four Robinhood Chain index protocols together hold about $11.3k [S].

## Comparison table

| Product | Who holds assets | Share pricing | Rebalance | Manager can | Manager cannot | Fees | Traction | Failures |
|---|---|---|---|---|---|---|---|---|
| Set Protocol v2 / Index Coop | SetToken contract (ERC-20) holds components [M] | No oracle for mint/redeem; in-kind issuance via BasicIssuanceModule [V: DPI page names the module] | Manager-driven trades on DEXs, later single-asset auctions (2023) [V] | Start rebalances, set targets, auction params [V] | Withdraw directly [M] | DPI 0.95%/yr streaming, 0% mint/redeem [V] | Index Coop $15.56M TVL; DPI sunset [S] | DPI slippage on large rebalances led to 5% per-rebalance cap [S] |
| Reserve Index DTF (Folio) | Folio contract [V] | No oracle; NAV-based mint/redeem, arbitrage aligns price [V] | Dutch auctions inside governance-approved ranges [V] | Governance: assets, fees, roles. Rebalance manager: start rebalance. Auction launcher: open auctions, pick prices in range [V] | Launcher can't change tokens or exceed ranges [V] | TVL fee and mint fee with a DAO floor [V, numbers conflict, see below] | Five thematic DTFs launched July 2026 on BNB chain [S] | None found. README states launcher can leak value in its own favour in one mode [V] |
| Enzyme | Vault contract per fund [M] | NAV from on-chain price feeds [V: Idle feed bug] | Manager trades through adapters [M] | Trade, track/untrack assets [V] | Exceed policy limits if policies are set [V] | Manager-set entrance/exit/mgmt/perf [M] | Not checked | Idle price-feed manipulation bug (whitehat, low funds at risk) [V] |
| dHEDGE (now Chamber) / Toros | Vault contract [V] | NAV; shares are ERC-20 [V] | Manager trades inside guards [V] | Trade enabled assets on allowlisted protocols; charge capped fees [V] | Withdraw depositor funds, use unlisted assets or protocols, raise fees without 14-day notice [V] | Entry, exit (0-2%), performance, management, all capped [V] | Not checked | "No publicly known exploits" (self-reported) [V] |
| Symmetry v3 (Solana) | Vault account with a vault token mint [V] | Oracle aggregation: Pyth, Raydium CLMM/CPMM, LST [V]; site also says in-kind mint/redeem [V] | Dutch auctions run by off-chain keepers for bounties [V] | Set weights and oracle config; up to 10 managers per vault [V] | Not documented on pages read | Deposit/withdraw fee tiers; mgmt and perf fees "currently disabled" [V] | "990+ baskets" on V2; no TVL figure found [V] | None found |
| Kamino lending vaults | Vault [V] | total assets / total shares [V] | Curator reallocates across Kamino reserves [V] | Allocate [V] | Not documented on page read | Deposit, withdrawal, performance (liquidity vaults) [S] | Not checked | Not checked |
| Reference dapp (hummusonrails) | BasketToken contract [V] | None for mint/redeem; Chainlink only for display [V] | None; fixed composition [V] | Nothing; no owner [V] | n/a | None [V] | Demo | Unaudited, educational [V] |
| Vimen | Basket contract [V] | NAV of underlying; in-kind redeem [V] | None; immutable [V] | Nothing [V] | Change composition [V] | 0.30% mint (hard cap 0.50%), redeem free [V] | $10,767 TVL [S] | Unaudited; deposit caps [V] |
| RobinIndex (RBDX) | RBDXVault [V] | Chainlink feeds, staleness checks [V] | No trades; +/-1% rebate or penalty on single-asset mint/redeem pushes toward target [V] | 2-of-3 Safe governs asset list [V] | Supply weights by hand; weights computed from on-chain totalSupply [V] | "fee + rebate logic", rates not given [V] | $436.59 TVL [S] | Unaudited, no legal review [V] |
| Hood Index | Unknown | Unknown | Unknown | Unknown | Unknown | Unknown | $85.16 TVL [S] | Unknown |
| HoodVault (HoodMarket) | Unknown | Unknown | Unknown | Unknown | Unknown | Unknown | $0 TVL [S] | Unknown |

## Per-product notes

### Set Protocol v2, TokenSets, Index Coop

- Architecture [M]: a SetToken is an ERC-20 that custodies its components and tracks "units per token". A manager attaches modules approved by a protocol controller. Issuance and redemption are in-kind and pro rata, so no oracle is needed to price a share. Not re-verified; the Index Coop page for Set v2 returned 404.
- DPI: 0.95% annual streaming fee, 0% mint, 0% redeem, issuance through BasicIssuanceModule [V] https://docs.indexcoop.com/index-coop-community-handbook/products/legacy-products/defi-pulse-index-dpi . It now lives under "legacy products", and the product page reads "The product has been sunset" [S] https://www.indexcoop.com/products/defi-pulse-index .
- Rebalancing history: first DEX-only trades by the manager. After large rebalances caused slippage, a cap of 5% maximum change per token per rebalance was added, with the excess spread pro rata [S, Gate explainer] https://www.gate.com/learn/articles/what-is-de-fi-pulse-index-all-you-need-to-know-about-dpi/7993 . In 2023 Index Coop built an Auction Rebalance Module "to overcome some limitations and inefficiencies associated with DEX-only trading": the manager calls `startRebalance()` with target units, a quote asset, per-component auction params and a duration; anyone bids per component via `bid()` [V] https://docs.indexcoop.com/index-coop-community-handbook/protocol/index-protocol/modules/auction-rebalance-module .
- Who pays for rebalancing: holders, through execution cost inside the pool. The streaming fee is separate.
- Traction: Index Coop total TVL $15.56M; Q3 2026 gross protocol revenue $53.1K; INDEX token down about 75% year on year [S, DefiLlama and price trackers via search] https://defillama.com/protocol/index-coop . DPI peak AUM was in the hundreds of millions in 2021 [M, not checked].
- No exploit or post-mortem for Set or Index Coop index products turned up in two searches. Absence of a result is not proof of none.

### Reserve Index DTFs (Folio)

Source: repo README https://github.com/reserve-protocol/reserve-index-dtf and docs https://docs.reserve.org/core-components/index-dtfs/roles , https://docs.reserve.org/core-components/index-dtfs/overview . There is also a Solana port: https://github.com/reserve-protocol/reserve-index-dtfs-solana (not read).

- Roles [V]:
  - Admin (a governance timelock, about 48h): add/remove assets, set fees, set roles, deprecate.
  - REBALANCE_MANAGER (governance timelock or approved basket managers): starts a rebalance by publishing ranges for weights, basket limits and prices per token. Price range may be at most 100x wide.
  - AUCTION_LAUNCHER ("semi-trusted EOA or multisig"): opens auctions inside those ranges during a restricted window. If it is offline, anyone can open auctions after the window using the pre-approved spot estimates, and cannot tune parameters.
  - Guardian: veto on queued proposals. Brand manager: metadata only.
- Auctions [V]: exponential-decay Dutch auction from the most optimistic to the most pessimistic price. Lot size is the largest amount that keeps both tokens inside the approved limits. Optional "trusted fillers" (CoW Swap) alongside permissionless bids. A rebalance has a fixed time-to-live.
- Stated trust limits [V], quoted from the README:
  - "If the `AUCTION_LAUNCHER` is actively malicious, they can maximally deviate the final portfolio within the governance-granted range or prevent a Folio from rebalancing entirely."
  - In PARTIAL price-control mode the launcher can "begin auctions at dishonest prices that leak value to MEV searchers".
  - In ATOMIC_SWAP mode "they can cause value leakage AND make themselves the beneficiary."
- Pricing [V]: no price oracles; anyone mints or redeems "at real-time asset value" and arbitrage keeps market price near basket value. Whether redemption stays open mid-rebalance was not stated on the pages read (unverified).
- Fees: README says TVL fee up to 10%/yr and mint fee up to 5%, each with a 10 bps floor that goes to the DAO [V as summarised]. The docs overview says TVL fee under 5% and mint fee under 1% [V as summarised]. The two conflict; treat exact caps as unverified. Example live setting: 0.3% mint, 0.6%/yr TVL fee, quarterly rebalance, on the five July 2026 BNB-chain DTFs [S] https://www.sagix.io/ai_dtf/ .
- Token support [V as summarised from README, re-read before relying]: fee-on-transfer, ERC-777/callback, multiple-entrypoint and **pausable/blocklist tokens are listed as not supported**. Rebasing is supported with an accounting caveat. Every stock token we care about is pausable or has a block/allow policy, so the most mature pooled index protocol excludes our asset class by its own spec.
- Creation is not permissionless in the official UI: "The Reserve Register does not yet support permissionless creation of Index DTFs" [V].

### Enzyme

- Known-risks page [V] https://specs.enzyme.finance/topics/known-risks-and-mitigations lists the two sides of pooled share pricing:
  - Opportunistic investors: buy shares when on-chain price lags real value ("deviation between on-chain and off-chain values of assets"), or when the fund holds untracked value. Mitigations: a shares-action timelock and entrance fees.
  - Opportunistic managers: "trade in an opportunistic manner that results in value leaking from the fund into external accounts". Mitigation: a policy limiting share-price loss (their example: 5% over 24 hours). Managers can also untrack assets to create an arbitrage; mitigation is a policy allowing removal only of negligible amounts.
- Disclosed bug [V] https://immunefi.com/blog/bug-fix-reviews/enzyme-finance-price-oracle-manipulation-bugfix-review/ : the price feed for Idle tokens used totalNav / totalSupply, which a flash loan from the Idle token itself could move, letting an attacker buy vault shares cheap. Reported by a whitehat; funds at risk were low. Lesson: any pool that prices deposits from a manipulable on-chain number can be diluted.

### dHEDGE (renamed Chamber) and Toros

- dHEDGE docs now redirect to Chamber [V] https://docs.chamberfi.com/ . Toros is "built on the Chamber protocol (formerly dHEDGE)" [V] https://docs.toros.finance/resources/security .
- Manager limits [V] https://docs.chamberfi.com/concepts/vaults-as-guardrails.md : can trade only enabled assets on allowlisted protocols; cannot withdraw depositor funds; fees are capped and increases need "a 14-day announcement". Enforcement is a guard system: "every trade the manager submits is checked against the vault's enabled assets and the protocol allowlist, and anything that violates them reverts."
- The page does not mention a slippage or price-impact check on manager trades. If none exists, a manager can still bleed a vault through bad fills on thin pairs (unverified either way).
- Deposits [V] https://docs.chamberfi.com/deposit/lockup-withdrawals.md : 24-hour lockup after deposit as a "flash-loan protection measure"; a top-up re-locks the whole balance on a weighted basis. Two exits: single-asset (vault sells your slice, you pay slippage) or underlying basket (in-kind slice). Exit fee 0-2%. The manager cannot block withdrawals.
- Security record [V, self-reported]: "No publicly known exploits or security incidents have affected Chamber or Toros." Audits: CertiK 2021, Sherlock 2024 and 2025, others.
- Audit findings exist [S] https://github.com/santipu03/santipu03/blob/main/private-audits/dHEDGE_GMX.md : a high-severity finding where a manager could send a token to the vault and make every withdrawal revert. Lesson: "manager cannot withdraw" does not cover "manager can brick withdrawals".

### Symmetry (Solana)

- v3 [V] https://symmetry.fi/ and https://docs.symmetry.fi : "multi-token baskets with target weights, oracle pricing, and a vault token mint"; up to 100 tokens, SPL and Token-2022; rebalancing by "an auction system powered by off-chain keepers" who "earn bounties"; up to 10 managers per vault; time-locked intents; deposit and withdrawal fee tiers; "management and performance fees are currently disabled". SDK: `@symmetry-hq/sdk`.
- Site claims "In-kind mint/redeem → New Deposits Never Dilute Holders" and "990+ baskets" on V2 [V]. No TVL, audit list or incident disclosure on the pages read.
- Unverified: whether a Symmetry vault can actually hold xStocks. Token-2022 support in general does not mean the vault handles pausable mints, a frozen vault account, a permanent delegate or a scaled-UI multiplier.

### Kamino vaults

- Lending vaults are single-asset: deposit one token, a curator spreads it across Kamino lending reserves, share price is "total assets divided by total shares outstanding" [V] https://kamino.com/docs/products/lending-vaults . Risks named: allocation risk, liquidity constraints, bad debt.
- Not a basket product. Useful only as the standard share-accounting pattern and as a reminder that a pooled vault can have withdrawals limited by where the manager put the money.
- Curator powers, timelocks and fee rates were not on the page read (unverified).

### Robinhood Chain index products

DefiLlama "Indexes" category on Robinhood Chain: total $11,289 across Vimen $10,767, RobinIndex $436.59, Hood Index $85.16, HoodVault $0 [S, search snippet; the page itself returned 403] https://defillama.com/protocols/indexes/robinhood-chain .

- **Reference dapp** [V] https://github.com/hummusonrails/robinhood-chain-dapp-example and https://dev.to/arbitrum/i-built-my-first-robinhood-chain-app-as-an-index-basket-20li
  - `BasketFactory.createBasket(name, symbol, components, maxPriceAge)` deploys a `BasketToken` (ERC-20). `mint(shares, to)` pulls each component with `transferFrom`, rounding up; `redeem(shares, to)` returns each component, rounding down. `quoteMint`, `quoteRedeem`, `sharePriceUsd()`, `totalValueUsd()`.
  - Fixed units per share, no rebalancing, no owner, no fees. Author: "I keep pricing and redemption apart on purpose. You use the price for the UI. Redeem returns the collateral."
  - ERC-8056: raw balances stay fixed; Chainlink feeds "price the raw token with the multiplier already applied", so no multiplier maths in the basket.
  - `maxPriceAge` is 4 days in the deploy script because equity feeds update 24/5.
  - MIT, Solidity 0.8.28, Foundry, OpenZeppelin 5.4.0, unaudited, educational. Testnet (chain id 46630) factory `0xC1940D5fd58ce735A44a53f910852B12250F6a14`.
  - Nothing in the repo or article about Stock Token transfer eligibility for a contract holder (unverified).
- **Vimen** [V] https://www.vimen.org/ : fixed baskets (MAG7, AI6, HOOD6), ERC-20 basket token, one-click mint with ETH or USDG, burn to redeem underlying. 0.30% mint fee hard-capped at 0.50%; redemptions "free, ungated, forever". Immutable; nobody can change composition. Unaudited, with deposit caps stepping $100K, $500K, $2M, $10M+.
- **RobinIndex** [V] https://github.com/Marthaerys/RobinIndex : RBDXVault holds 27 Stock Tokens. Target weights come from each token's on-chain `totalSupply()` times Chainlink price, with no admin input. No rebalance trades: single-asset mint or redeem gets up to +/-1% rebate or penalty depending on whether it moves the vault toward target (the GLP pattern). 2-of-3 Safe controls the registry. Launched 2026-09-06. Explicitly not audited and not legally reviewed.
- **Hood Index, HoodVault**: nothing beyond the TVL line found. Unverified.
- Also seen in search: a third-party clone of the reference dapp (0o0r7/IndexBasket) and "Basketstock". The category is already a clone field [I].

### Cautionary case outside the brief: Indexed Finance

On 2021-10-14 the DEFI5 and CC10 pools lost about $16M [S] https://rekt.news/indexed-finance-rekt , https://blocksecteam.medium.com/the-analysis-of-indexed-finance-security-incident-8a62b9799836 . The pools were AMM-style index pools that priced mints from their own balances and re-weighted gradually when a token was added. The attacker used about $156M of flash swaps to distort the pool's internal valuation during a re-index, minted pool tokens cheaply and redeemed them for the assets. This is the textbook case of "pooled index + internal pricing + rebalance in progress".

## What a pool gives followers that separate vaults cannot

1. **A share token.** One fungible asset that can be transferred, traded on a DEX, posted as collateral or held inside another basket. Nesting becomes "hold the token". Separate vaults have no such object.
2. **One rebalance for everyone.** The pool trades once; nobody has to come back, sign, or grant a keeper permission. The auto-follow problem (Q2) doesn't exist in a pool.
3. **Identical returns.** Every holder gets the same performance, so the published track record is each holder's track record. Separate vaults drift apart by entry time, fills and missed rebalances.
4. **No dust.** A $20 holder owns a clean fraction of 20 assets. A $20 vault with 20 legs has $1 positions that can fall below router minimums [I].
5. **Easy fees.** A streaming fee is a few lines of share inflation. Charging followers of a recipe in separate vaults needs a fee hook on every vault.
6. **Netting.** Buyers and sellers of the share can trade with each other without touching the underlying [I].

## What pooling cost these projects

1. **Share pricing is the attack surface.** Oracle-priced deposits can be arbitraged (Enzyme's Idle feed bug, Enzyme's own "stale oracle" risk entry) or flash-manipulated (Indexed Finance, $16M). The defences are lockups (Chamber's 24h), timelocks and entrance fees, which make UX worse, or in-kind-only mint and redeem (Set, Reserve, reference dapp), which pushes the buying of components back onto the user or a zap.
2. **The rebalancer becomes a fiduciary.** Reserve's README says a malicious launcher can leak value to itself in one mode. Enzyme lists manager value extraction as a known risk and offers a loss-cap policy. Chamber needs a guard on every call. Each project carries governance, timelocks, vetoes and role splits just to make one trade safe.
3. **Rebalances are large, public and predictable.** DPI capped changes at 5% after slippage problems; Index Coop, Reserve and Symmetry all moved from DEX swaps to Dutch auctions. That is real engineering and needs bidders to show up.
4. **The pool must be an eligible holder.** Reserve excludes pausable and blocklist tokens outright. A pool of stock tokens can be frozen or paused as one account, which stops every holder at once; with separate vaults a freeze hits one user [I]. A freely transferable share over non-US-only tokens also sidesteps the issuer's transfer policy, which is the kind of thing that gets a pool address blocked [I].
5. **It looks like a fund.** A manager-run pooled vehicle over tokenized securities that issues shares is close to a collective investment scheme. RobinIndex says outright it has had no legal review. Separate vaults where each user owns the underlying are a much easier story [I, not legal advice].
6. **Concentrated contract risk.** One bug loses everyone's money, so audits are table stakes. The unaudited ones cap deposits (Vimen) or stay tiny.
7. **No personalization.** Every holder gets the same basket. Per-user limits, existing holdings and eligibility can't be expressed inside a pool.
8. **Weak demand so far.** Index Coop $15.56M and DPI sunset; Robinhood Chain indexes about $11.3k combined; Symmetry shows no current TVL. Pooled index tokens have not found many buyers [S].

## What this means for Q1-Q4

**Q1, pool or own vaults.** Own vault per user per chain as the default. It matches Cesto, keeps the underlying in the user's name, needs no share price, and keeps eligibility per user. A community index is a versioned recipe. If a share token is wanted for the demo, the only pooled form that is safe in the time available is the reference-dapp form: fixed composition, in-kind, no manager, no oracle in the money path. A pool that rebalances is out of scope.

**Q2, auto-follow.** Sound in principle, and the pooled precedents hand over the guardrail list, because a keeper acting on N vaults is the same fiduciary problem as a pool manager, with smaller blast radius per vault and the same key risk across all of them:
- asset allowlist equal to the recipe's assets, and venue allowlist (Chamber guards);
- no withdraw, no transfer out, output must land back in the vault (Chamber);
- per-trade minimum-out bounded by an oracle price, plus a per-period loss cap on vault value (Enzyme's 5%/24h policy is the model);
- cap on how far one rebalance can move weights (DPI's 5% rule) and a cool-off between rebalances;
- delay between a creator publishing a new version and keepers acting on it, so followers can opt out (Chamber's 14-day fee notice, Reserve's 48h timelock; hours, not days, is enough here);
- recipe changes that add a new asset should need the follower's fresh consent, since "only the recipe's assets" is meaningless if the creator can add an illiquid token they control and the keeper then buys it;
- stale-price handling for stock tokens outside market hours (the reference dapp's 4-day `maxPriceAge` shows the weekend problem);
- user can revoke at any time; keeper cannot block exit (the dHEDGE audit finding shows "can't withdraw" is not the same as "can't brick").

**Q3, nesting.** Pools make nesting trivial because there is a token to hold; own vaults have no token. With own vaults, nest by look-through: store the personal basket as "40% index X v7, 60% other legs", flatten to target weights per asset at rebalance time, and re-flatten when X publishes a new version. This avoids share pricing and fee stacking. Nesting stays inside one chain since there is no bridging. If a static share token exists on Robinhood Chain (reference-dapp style), a personal basket there could hold it directly, but that is optional.

**Q4, 11-day MVP.**
- Solana: own vaults via Swig roles plus Jupiter. Don't build or integrate a pooled program; Symmetry v3 exists but its handling of xStocks' Token-2022 extensions is unverified.
- Robinhood Chain: own-wallet baskets through Uniswap or 1inch. Forking the MIT reference dapp gives a static in-kind index in about a day if a share token is wanted, but that category is the clone field and holds $11k in total.
- Base: own wallet only. B20 transfer policies make a pool contract's eligibility an open question.
- On no chain is a rebalancing pool realistic. Every precedent needed auctions, governance and audits to do it safely.

## Open questions and risks

- Can a contract (pool, vault or smart wallet) hold each stock token at all? Verify per issuer: xStocks freeze and permanent delegate, B20 transfer policy, Robinhood Stock Token allow/blocklist. Nothing read this session settles it.
- Reserve's "pausable/blocklist tokens not supported" line and its fee caps came through a summarised README; re-read before quoting.
- Hood Index and HoodVault are undocumented here. DefiLlama TVL numbers are from a search snippet.
- No Set / Index Coop exploit found, but the search was shallow.
- Whether Chamber enforces any slippage bound on manager trades is unknown.
- Legal characterisation of pooled versus own-vault designs is my inference, not advice.

## Sources

- https://github.com/hummusonrails/robinhood-chain-dapp-example
- https://dev.to/arbitrum/i-built-my-first-robinhood-chain-app-as-an-index-basket-20li
- https://www.vimen.org/
- https://github.com/Marthaerys/RobinIndex
- https://defillama.com/protocols/indexes/robinhood-chain (403 on fetch; figures from search snippet)
- https://global.foresightnews.pro/article/16745 (Vimen description, search snippet)
- https://github.com/reserve-protocol/reserve-index-dtf
- https://docs.reserve.org/core-components/index-dtfs/roles
- https://docs.reserve.org/core-components/index-dtfs/overview
- https://www.sagix.io/ai_dtf/
- https://docs.indexcoop.com/index-coop-community-handbook/protocol/index-protocol/modules/auction-rebalance-module
- https://docs.indexcoop.com/index-coop-community-handbook/products/legacy-products/defi-pulse-index-dpi
- https://www.indexcoop.com/products/defi-pulse-index
- https://defillama.com/protocol/index-coop
- https://www.gate.com/learn/articles/what-is-de-fi-pulse-index-all-you-need-to-know-about-dpi/7993
- https://specs.enzyme.finance/topics/known-risks-and-mitigations
- https://immunefi.com/blog/bug-fix-reviews/enzyme-finance-price-oracle-manipulation-bugfix-review/
- https://docs.chamberfi.com/concepts/vaults-as-guardrails.md
- https://docs.chamberfi.com/deposit/lockup-withdrawals.md
- https://docs.toros.finance/resources/security
- https://github.com/santipu03/santipu03/blob/main/private-audits/dHEDGE_GMX.md
- https://symmetry.fi/
- https://docs.symmetry.fi
- https://kamino.com/docs/products/lending-vaults
- https://rekt.news/indexed-finance-rekt
- https://blocksecteam.medium.com/the-analysis-of-indexed-finance-security-incident-8a62b9799836
