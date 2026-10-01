# Separate accounts following a shared recipe: precedents (2026-10-01)

Read-only pass. Sources are public docs, help centres and press. Wording is paraphrased; API field names are kept as written.

Marks: **[V]** read in a primary source this pass. **[S]** search snippet or secondary write-up, not opened. **[I]** my inference. **[U]** unverified.

## TL;DR

- Every product that sells "you keep your own assets" uses one account per person and treats the shared thing as a recipe. The two onchain ones differ in where the assets sit. **Cesto** leaves tokens in the user's main wallet and trades through a server-side signer. **Glider** (and Bitwise on top of it) creates a dedicated smart account per portfolio per chain, owned by the user's wallet, with a session key for Glider's keeper. On Solana Glider's account is a **Swig sub-account**, which is the design the team proposed.
- Recipe changes reach followers in three ways: pushed at the next cycle with no per-change consent (Glider, Bitwise, eToro, Autopilot auto-approve, Cesto auto-rebalance), shown as a one-click prompt (Cesto default, M1), or never, because the follower holds a fork (M1 shared pies, Composer copies, Public Generated Assets).
- In every push model the operator's keeper triggers the trade and sponsors gas. The user pays swap costs plus a fee on turnover (Cesto, Glider) or a flat methodology or subscription fee (Bitwise, Autopilot, Composer).
- No precedent enforces "swap only between recipe assets, never withdraw" onchain in a way its docs spell out. Cesto's permission is a whole-wallet delegated signer. Glider's session key is described as broad, and withdrawals are gated by a fresh user signature that Glider's server checks. An onchain-scoped keeper role would be a stronger claim than either.
- Nesting exists in TradFi only: M1 pies inside pies (flattened inside one account) and eToro copy chains (trades propagate down the tree). Neither Cesto nor Glider documents nesting.
- Top complaints: silent loss of the trading permission (Autopilot), trades with no notice (eToro), results that differ from the leader's, small accounts skipping legs, partial fills, and idle cash.

---

## 1. Cesto (Solana)

**Where assets sit.** In the user's own wallet: a Privy embedded wallet if they signed in with Google, or their Phantom/Solflare wallet. The security page states there is no Cesto-held account, escrow or vault. [V] https://docs.cesto.co/llms-full.txt (section `/cesto/security`)

**What the position is.** The position is the wallet's live token balances. Rebalance targets are measured against what the wallet holds today, not what it held at open, and the docs warn that buying or selling a basket token on your own makes the allocation deviate. [V] same file, `/sdk/rebalance-position` and `/cesto/rebalancing`. Consequence [I]: two baskets that share a token cannot be told apart in one wallet, and the user's unrelated holdings of that token count as basket holdings.

**Follow and rebalance.**
- Baskets are versioned. A creator publishes a new version that changes the token mix. A rebalance is a migration from the held version to the latest. [V]
- Default: the Rebalance page shows drift and new versions, and the user approves each rebalance. [V]
- Auto-rebalance: opt-in per basket, off by default, can be switched off. It fires when the strategy moves to a new version. The docs do not say it fires on price drift. [V]
- What the user approves, in the "existing Cesto user" path: a signed message that means "move my position in this basket to whatever its latest version is". The target version is deliberately not part of the approval; the backend resolves it when the job is queued. The approval is single-use and never retried automatically. [V]

**Permission used to trade.** `users.lookup` returns `delegatedSigning: true` when Cesto can sign for the wallet. That is the Privy embedded wallet with server-side signing. External wallets that have never used Cesto return `false` and take the client-signed flow, where the user signs every transaction. [V] So auto-rebalance needs a wallet Cesto can sign for; a pure Phantom user gets the manual path [I]. The docs describe no onchain scope (program allowlist, per-mint cap, no-transfer rule) on that signer. Privy does support policies on session signers [S] https://docs.privy.io/wallets/using-wallets/signers/delegate-wallet , but whether Cesto sets any is [U].

**Two execution routes, same target.** [V]
- Client-signed (BYOW): `rebalance.prepare` returns a batch that swaps old tokens directly into new ones; the user signs all legs up front; `submit` is single-use. Prepared transactions expire within seconds, and slippage is a platform default with no parameter.
- Managed: `rebalance.start` runs two server-signed phases, sell old tokens to USDC, then buy new ones with only those proceeds, so other USDC in the wallet is untouched.

**Failure handling.** Legs are independent transactions with no atomicity. Terminal states are `COMPLETED`, `PARTIALLY_COMPLETED`, `FAILED`. To finish, call rebalance again: it re-reads onchain balances and targets what is left. One in-flight execution per wallet and product. [V]

**Who pays.** Cesto sponsors network gas and token-account rent, so the wallet needs no SOL. The platform fee on a rebalance is charged on the value moved, not on the whole position. On opens there is also a Jupiter Ultra fee taken from swap output and a SOL gas-reserve top-up paid in USDC. [V]

**Eligibility on new versions.** `rebalance.getAvailability` returns token diffs, estimated fee, and `eligible`; a position smaller than the new version's minimum is ineligible. [V]

**SDK.** `@cesto/sdk` (server): `products.*`, `positions.*`, `open.start`, `close.start`, `rebalance.start/prepare/getAvailability/getHistory`, `users.create/lookup`, `bridge.*`, `fees.get`. `@cesto/web-sdk` is a drop-in invest dialog keyed by a publishable key. Managed wallets are Privy Solana wallets keyed to the partner's user; the partner's API key is the sole authority over them. [V]

**Creators.** Access-gated programme; Labs ideas are not investable. How a version is recorded (onchain or database) is not documented [U].

## 2. Glider (multi-chain) and Bitwise Automated Token Portfolios (Base)

**Account model.** A strategy is a template (allocation, schedule, swap preferences). A portfolio links one user to one strategy and has one smart account per chain. Accounts are ZeroDev Kernel on EVM and Swig on Solana. [V] https://docs.glider.fi/guides/security-architecture , https://docs.glider.fi/llms-full.txt

**Solana detail.** The first portfolio for a user creates a Swig wallet whose root authority is the user's own key. Each portfolio is a sub-account of that Swig with its own role id, and the sub-account address is the deposit address. Glider's "pooled agent" is attached as an authority at creation. A Solana-rooted user signs one transaction at enrolment; an EVM-rooted user signs a slot-bound Swig add-authority payload with their secp256k1 key. The paymaster pays. [V] (`/api-reference/endpoints/v2-enroll`, `v2-enroll-signature`)

**What the user approves once.** One enrolment signature bound to wallet, account index, target chains, smart-account address and flow id. It authorises a revocable session key for Glider's automation. The docs list its scope broadly: swapping, bridging, lending and borrowing, rebalancing and other strategy operations. No contract or token allowlist is published. [V] The user can rotate, revoke or re-sign. [V]

**What needs a fresh signature.** Withdrawals (binding recipient, assets, amounts, account, nonce, expiry), adding chains, rotating session-key permissions. [V] On Solana the pooled agent itself executes the transfer out of the sub-account once the owner's signature is verified. [V] So the agent role can move tokens out, and the "only with the owner's signature" rule is checked by Glider's backend rather than by the Swig role [I].

**How a published strategy is mirrored.** `strategyId` is stable; each publish increments a version. The distributor guide says: "Enrolled portfolios use the new target during their next rebalance." [V] https://docs.glider.fi/guides/strategy-distributor-overview . No re-signing, no per-version opt-in. A schedule change also fans out to every enrolled portfolio, including paused ones when they resume. [V]

**Triggers.** Scheduled by strategy `frequency` (hourly, daily, monthly appear in examples) and manual via `POST /v2/portfolios/{id}/rebalance` with a short cooldown. No drift trigger is documented. Portfolios can be stopped and started. [V]

**Swap guards.** Per strategy or tenant: `slippageBps` (300 in examples), `priceImpactBps`, `thresholdUsd` (minimum swap size, "5.00" in examples). Holdings below the threshold or without a route are left in the account. Strategies reject blocklisted assets. [V]

**Who pays.** Gas via Glider's paymaster. Fee is `swapBps` taken from the output of every swap, set per tenant or per strategy. [V]

**Roles.** Strategy provider (writes the allocation) and strategy distributor (owns the user and wallet experience, cannot change the allocation). [V]

**Chains.** Ethereum, Base, Arbitrum, BNB Chain, Polygon and Solana appear in the docs. Robinhood Chain (4663) was not seen [U]. Audits are not linked in the docs [U].

**Bitwise ATPs (launched 2026-08-25).** Bitwise designs the models (AI, robotics, Mag 7 plus extras). Users hold Coinbase tokenized stocks in their own non-custodial accounts, not a pooled fund. Glider rebalances through limited-authority credentials the user authorises; Bitwise does not execute in user wallets. Non-US eligible users only. Fee is a 0.15% methodology access fee, with trading and platform fees on top. Bitwise's CIO framed it as the model coming to the user's wallet rather than the assets going to a fund. [V] https://www.coindesk.com/business/2026/08/25/bitwise-turns-coinbase-s-tokenized-stocks-into-automated-ai-robotics-and-tech-portfolios . "Daily rebalancing" is from a search snippet [S] https://www.theblock.co/news/business/2026-08-25-bitwise-launches-automated-tokenized-stock-portfolios-for-mag-7-ai-and-robotics-themes-412706 .

Bitwise is direct evidence that a Kernel smart account can hold Coinbase's B20 stock tokens under their transfer policies [I, from the product being live].

## 3. Peaks

From the earlier pass (an internal team note, read from the app bundle): the spot product is a **shared vault** whose token mints to the user's wallet, redeemable in kind, so it is the pooled counter-example. The agent product is per user on Hyperliquid perps, with an autonomy setting: the agent executes without asking below $25 to $250 depending on risk profile. Nothing new fetched this pass.

## 4. M1 Finance Pies

- A pie is a set of slices with target percentages. A slice can be a security, another pie, or a group of pies. Up to 100 slices. [V] https://help.m1.com/en/articles/9331915-what-is-a-pie . Maximum nesting depth not found [U].
- Nesting is flattened inside one brokerage account: the user owns the leaf securities, and the sub-pie is only a weighting node [I from the above].
- Dynamic rebalancing: deposits go to the most underweight slices and withdrawals come from overweight ones, so cash flows do most of the rebalancing without selling. A full rebalance is a button the user presses on the portfolio or on one pie. Editing a pie does not trade immediately. [V] https://help.m1.com/en/articles/9332078-how-does-m1-trade
- All trades run in one or two daily trade windows. [V] Times of about 9:30 and 15:00 ET are [S].
- Sharing a pie sends its configuration by link. The recipient can invest as is, edit it or save it, and their edits do not affect the original. Nothing says later edits by the author reach recipients, so a shared pie is a snapshot [I]. [V] https://help.m1.com/en/articles/9331991-share-a-custom-pie-on-m1
- The same pie used in several of one person's accounts does update everywhere and can trigger trades and taxable events there. [S] https://help.m1.com/en/articles/9332114-moving-slices-when-the-same-pies-are-used-in-multiple-accounts

## 5. eToro CopyTrader and Smart Portfolios

CopyTrader, from eToro USA's own guide (PDF, August 2026 edition) [V] https://www.etoro.com/wp-content/uploads/2025/10/CopyTrader-Guide_Jan-2026.pdf :
- Legal framing: the user gives a standing instruction to duplicate another user's trades. eToro says it has no discretion and gives no advice.
- On start, the copier's deposit is split in the leader's current proportions at market price. After that every change by the leader is mirrored with no pre-approval and no notice. If the leader goes to cash, so does the copier.
- Stopping offers "Stop and Sell" or "Stop and Keep".
- No extra fee for copying.
- Minimum $200 to copy; a leg under $1 is not bought. A copy stop loss is mandatory, default 95%.
- The copier may sell copied positions or withdraw cash, but then stops matching the leader; if there is not enough cash a new trade is skipped.
- **Copy chains:** the leader may be copying someone else, and trades at the top of the tree flow down to every copier.
- **Same price for all:** the leader's trade and all copier trades normally go in one block filled at the same volume-weighted price.
- Orders placed while markets are closed queue for the next open.
- Leaders can become ineligible above a risk score, a copier count or an asset level.

Smart Portfolios [S] https://help.etoro.com/s/article/What-does-rebalancing-a-Smart-Portfolio-mean?language=en_GB , https://help.etoro.com/s/article/what-are-smart-portfolios?language=en_GB : eToro-curated portfolios; rebalancing is automatic on a per-portfolio schedule with no action from the investor; minimum $500, because trades are duplicated pro rata and a leg under $1 is skipped; positions closed outside market hours sit in "Pending Close" and cannot be cancelled.

Complaints [S]: copier results differ from the leader's because of timing, slippage and minimums (eToro's own risk page https://www.etoro.com/copytrader/risk-warnings/ ); a UK Financial Ombudsman decision concerns positions closed by a copy stop loss without the customer expecting it (https://www.financial-ombudsman.org.uk/decision/DRN-4069307.pdf , not opened).

## 6. Composer

- A symphony is a rules tree that resolves to target weights. Trades for all users are aggregated and executed in one daily window near the close. Rebalance means sell overweight, buy underweight. Edits take effect at the next scheduled trade. [V] https://help.composer.trade/article/65-how-does-composer-trade
- Orders are "not held", giving Composer time and price discretion. If sells fill worse than expected, buys are prorated. Fractions down to 1/100,000 of a share. [V]
- Trading frequency is set per symphony from daily to yearly, or by threshold: trade only when a weight leaves a corridor, which cuts fees and slippage. [S] https://help.composer.trade/article/76-threshold-trading
- Community symphonies are copied and then edited or invested. Copies appear as separate symphonies; the docs do not say a copy follows later edits by the author, so treat it as a fork [I].
- Pricing: a Trading Pass of about $40 a month, no commission or management fee [S]. Search titles now read "Composer by SoFi" [U].

## 7. Autopilot

- Links the user's existing brokerage account through the broker's API or an aggregator, takes no custody, and places proportional trades when the "pilot" portfolio changes. It also rebalances to target weights. Users choose auto-approve or approve each change. [S] https://thecollegeinvestor.com/59796/autopilot-review/ , https://www.wallstreetzen.com/blog/autopilot-investment-app-review/
- Scale from the earlier pass: about $750M followed, about 80k paying subscribers, $29 a quarter or $100 a year.
- Complaints (App Store reviews via search) [S] https://apps.apple.com/us/app/autopilot-automated-investing/id1613625799?see-all=reviews&platform=iphone : the brokerage link keeps disconnecting (Robinhood, Schwab, Fidelity re-login and 2FA), trades are missed even with auto-approve on, pricing surprises and minimums. Earlier pass: disclosure lag up to 45 days and idle cash.
- Adviser registration and discretion not checked this pass [U] (Forbes page returned 403).

## 8. Public Generated Assets

- A prompt becomes an index of stocks with a backtest against the S&P 500; the user invests in it as a separate account. [S] https://www.prnewswire.com/news-releases/investors-can-turn-ideas-into-an-investable-index-with-publics-launch-of-generated-assets-302454862.html
- The user picks the rebalance frequency: daily, monthly, quarterly, yearly or never. Deposits, withdrawals and dividends are invested or raised at the next trading window. Rebalancing returns the account to the allocation the user originally selected. [V] https://help.public.com/en/articles/12874226-how-is-my-generated-assets-account-rebalanced
- Whether constituents are ever regenerated, and what happens when someone else's Generated Asset changes, is not documented [U]. The disclosure page title names Public Advisors, which suggests an advisory account [U] https://public.com/disclosures/ga .

## 9. Direct indexing

- A separately managed account holds the index's stocks directly, often a sample optimised to track it. The owner can exclude names or sectors, and the manager harvests losses stock by stock. [S] https://www.schwab.com/direct-indexing , https://www.parametricportfolio.com/blog/direct-indexing
- Costs and minimums: Wealthfront S&P 500 Direct 0.09% and Nasdaq-100 Direct 0.12%, $5,000 minimum; Frec offers about 25 indices with add and exclude controls. [S] https://frec.com/resources/blog/comparing-frec-to-other-direct-indexing-providers
- Drawbacks: hundreds of positions with separate cost bases, tracking error that grows with customisation and harvesting, and "lock-in" once every lot is in gain, which makes leaving expensive. [S] https://www.longangle.com/research/direct-indexing , https://bulloak.com/blog/why-you-should-probably-avoid-direct-indexing-at-all-costs/
- Relevance: this is the TradFi name for "the index is a recipe and each person holds the pieces", and its selling point is personalisation, which a pooled fund cannot offer.

---

## 10. Comparison

| Product | Where assets sit | Approved once | Approved each time | Recipe change reaches follower | Trigger / gas | User pays |
|---|---|---|---|---|---|---|
| Cesto, default | User's wallet | Nothing | Invest, rebalance, close, withdraw | Prompt on Rebalance page, one click | User / Cesto sponsors gas | Fee on value moved, swap costs |
| Cesto, auto-rebalance | User's wallet (Cesto-signable) | Opt-in per basket; "move to latest version" | Withdraw | Automatic on new version | Cesto server signer / Cesto | Same |
| Glider / Bitwise | Smart account per portfolio per chain, user is root | Enrolment signature granting session key | Withdraw, add chain, rotate key | Automatic at next scheduled rebalance | Glider agent / paymaster | `swapBps` on swaps; Bitwise 0.15% |
| Peaks spot vault | Shared vault, token in wallet | Deposit | Redeem | Vault trades itself | Vault | Not published |
| M1 pie | Own brokerage account | Pie targets, auto-invest | Full rebalance | Shared pie is a snapshot; no sync | M1 at trade window | No commission |
| eToro CopyTrader | Own account, copy sub-balance | Copy instruction, stop loss | Stop copy | Automatic, no notice | eToro block order | Normal spreads and fees |
| eToro Smart Portfolio | Own account | Invest | Close | Automatic on portfolio schedule | eToro | Normal spreads |
| Composer | Own brokerage account | Invest in symphony | Edit | Copies are forks; own edits at next window | Composer daily window | Subscription |
| Autopilot | User's existing broker | Broker link, auto-approve | Each change if manual | Automatic or prompt | Autopilot via broker API | Subscription |
| Public Generated Assets | Own account | Invest, frequency | Changes | Fixed to original selection | Public at trading window | Not checked |
| Direct indexing | Own SMA | Mandate and exclusions | Mandate changes | Manager follows index changes | Manager | 0.09% to 0.40% a year |

## 11. What users complain about

1. The permission breaks silently and trades are missed (Autopilot). The onchain equivalents are an expired session key, a paused keeper, or a frozen or paused token.
2. Trades happen with no notice and no preview (eToro states this openly as a condition).
3. The follower's result differs from the leader's: later entry price, slippage, skipped small legs, cash shortfalls.
4. Small accounts cannot hold every leg ($1 leg floor at eToro, $5 swap floor at Glider, basket minimums at Cesto).
5. Partial completion leaves the position between two versions (Cesto documents this).
6. Idle cash and dust left behind.
7. Stops and closes that fire unexpectedly or cannot be cancelled outside market hours (eToro).
8. Stale leader data (45-day disclosure lag on trackers).
9. Headline returns that are backtests (Cesto, Composer, Public).
10. Many small positions and difficulty leaving (direct indexing).

## 12. What this means for Q1 to Q4

**Q1, own vault versus shared pool.** The precedent for own vault per basket per chain is strong and current: Glider runs it in production on Base and on Solana with Swig sub-accounts, and Bitwise and Coinbase chose it over a fund for tokenized stocks. A dedicated account per basket fixes two weaknesses of Cesto's wallet-level model: overlapping baskets cannot be separated in one wallet, and the trading permission covers the whole wallet. A shared pool only earns its place if a transferable share token is wanted, and it makes the pool the holder of regulated stock tokens for many people, which is harder under B20 transfer policies and non-US rules [I].

**Q2, auto-follow.** It is the industry norm, and it is usually blunter than proposed: Glider applies a new version at the next rebalance with no opt-in, and eToro sends no notice. Guardrails the precedents suggest:
- Off by default and per basket (Cesto). A pause switch and "stop and keep" versus "stop and sell" (Glider, eToro).
- Approve the move, not a version (Cesto), but then bound what a version may do: turnover cap per period, version cooldown, asset registry with liquidity floors, blocklist (Glider), leader capacity caps (eToro).
- Scope conflict: a role limited to the recipe's mints cannot buy a mint added in a later version without a new root signature. Either scope the role to the platform's approved universe up front, or ask for one tap only when a version adds an asset.
- Withdrawals should be impossible for the keeper role onchain, not gated by a server check. Glider's Solana agent can transfer once the backend accepts an owner signature.
- Fees on turnover (Cesto, Glider) reward churn; cap or disclose.
- Slippage and price-impact caps per swap, a minimum swap size, skip-and-report for dust legs, one in-flight job per vault, and "re-read balances and retry" after partial fills (Cesto, Glider).
- Fair ordering: published versions are visible before followers trade, so batch or randomise follower execution and check each swap against a reference price. eToro's same-price block order is the TradFi answer.
- Show sync status and last successful rebalance, and alert on failure (Autopilot's main complaint).
- Respect market hours for stock tokens (eToro queues; Glider flags market-hours behaviour for Ondo tokens).

**Q3, nesting.** Use M1's approach: a sub-basket is a weighting node, and one vault holds the leaves. Store the personal recipe as leaf weights plus a reference to a community index id; resolve it to flat leaf targets at rebalance time, merging duplicates. An index version change then changes the personal vault's effective recipe and travels through the same auto-follow path, like an eToro copy chain. Keep depth to one level, reject cycles, and resolve per chain since there is no bridging. No precedent uses vault-in-vault or share tokens for this.

**Q4, 11-day MVP.**
- All chains: Cesto's client-signed pattern as the baseline. Show "new version available", prepare a batch, user signs once, submit, retry on partial. Needs no smart account.
- Solana: Swig sub-account per basket with a keeper role and Jupiter swaps, and live auto-follow. Glider proves the Swig sub-account pattern; Token-2022 stock tokens from a Swig account remain untested by us.
- Base: Kernel smart account with a session key is proven for Coinbase stock tokens by Bitwise. Auto-follow is feasible with ZeroDev permissions if time allows.
- Robinhood Chain: manual one-click rebalance first. Auto-follow only if the Base code ports cleanly.
- Glider's B2B API could supply EVM execution, but it needs an API key and Robinhood Chain support is unconfirmed.

## 13. Open questions

- Does Cesto set a Privy policy on its server signer, and can a Phantom user enable auto-rebalance at all?
- What exactly does Glider's session key allow onchain (Kernel permission plugin config, Swig role actions)? Reading a live Glider Swig account on Solana would settle it.
- Does a Swig sub-account role support "swap via program X between mints A..N, no transfers" tightly enough, given swaps route through arbitrary pools?
- Can a new smart account receive Coinbase B20 stock tokens without issuer onboarding, or did Bitwise and Glider get an allowlist entry?
- M1 nesting depth, Composer copy behaviour, Autopilot's adviser status and Public's constituent refresh are unverified.
- Regulatory framing: eToro leans on "instruction, not discretion". A keeper that follows a third-party creator's recipe sits close to that line; not assessed here.

## Sources

- Cesto: https://docs.cesto.co/llms-full.txt (sections /cesto/security, /cesto/rebalancing, /sdk/rebalance-position, /sdk/open-position, /sdk/close-position, /sdk/users, /sdk/managed-wallets, /sdk/fees)
- Glider: https://docs.glider.fi/llms-full.txt ; https://docs.glider.fi/guides/security-architecture ; https://docs.glider.fi/guides/strategy-distributor-overview ; https://docs.glider.fi/guides/two-stage-enrollment ; https://docs.glider.fi/guides/b2b-overview ; https://docs.glider.fi/overview
- Bitwise: https://www.coindesk.com/business/2026/08/25/bitwise-turns-coinbase-s-tokenized-stocks-into-automated-ai-robotics-and-tech-portfolios ; https://www.theblock.co/news/business/2026-08-25-bitwise-launches-automated-tokenized-stock-portfolios-for-mag-7-ai-and-robotics-themes-412706 ; https://cryptobriefing.com/bitwise-automated-token-portfolios-launch/
- Privy: https://docs.privy.io/wallets/using-wallets/signers/delegate-wallet ; https://docs.privy.io/recipes/wallets/session-signer-use-cases/server-side-access
- M1: https://help.m1.com/en/articles/9331915-what-is-a-pie ; https://help.m1.com/en/articles/9332078-how-does-m1-trade ; https://help.m1.com/en/articles/9331991-share-a-custom-pie-on-m1 ; https://help.m1.com/en/articles/9332114-moving-slices-when-the-same-pies-are-used-in-multiple-accounts
- eToro: https://www.etoro.com/wp-content/uploads/2025/10/CopyTrader-Guide_Jan-2026.pdf ; https://www.etoro.com/copytrader/risk-warnings/ ; https://help.etoro.com/s/article/What-does-rebalancing-a-Smart-Portfolio-mean?language=en_GB ; https://help.etoro.com/s/article/what-are-smart-portfolios?language=en_GB ; https://www.financial-ombudsman.org.uk/decision/DRN-4069307.pdf
- Composer: https://help.composer.trade/article/65-how-does-composer-trade ; https://help.composer.trade/article/76-threshold-trading
- Autopilot: https://thecollegeinvestor.com/59796/autopilot-review/ ; https://www.wallstreetzen.com/blog/autopilot-investment-app-review/ ; https://apps.apple.com/us/app/autopilot-automated-investing/id1613625799?see-all=reviews&platform=iphone
- Public: https://help.public.com/en/articles/12874226-how-is-my-generated-assets-account-rebalanced ; https://www.prnewswire.com/news-releases/investors-can-turn-ideas-into-an-investable-index-with-publics-launch-of-generated-assets-302454862.html ; https://public.com/disclosures/ga
- Direct indexing: https://www.schwab.com/direct-indexing ; https://www.parametricportfolio.com/blog/direct-indexing ; https://frec.com/resources/blog/comparing-frec-to-other-direct-indexing-providers ; https://www.longangle.com/research/direct-indexing ; https://bulloak.com/blog/why-you-should-probably-avoid-direct-indexing-at-all-costs/
- Earlier team notes: an internal team note ; research/solana-liquidity.md ; internal team notes
