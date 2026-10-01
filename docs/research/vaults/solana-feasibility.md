# Solana feasibility: per-user basket vault with a restricted rebalancer

Checked Oct 1, 2026 (about 12:30–13:00 UTC, US pre-market). Read-only: docs, GitHub source, public RPC, Jupiter quote API, Pyth Hermes metadata. Nothing was signed or sent. Items marked **[unverified]** were not confirmed against a primary source or a live test.

## Verdict

- Build a small custom Anchor program with one PDA vault per basket. It is the only one of the three options that can enforce all of: swaps only between recipe mints, output lands back in the vault, minimum output checked against an oracle, keeper can never withdraw.
- Swig alone gives a bounded-loss delegation, not a "can't withdraw" guarantee. Its role model checks which program is called and how much of each mint leaves the wallet; it does not check where swap output goes or how much comes back (source read below). Keep Swig as the user's wallet (passkey sign-in, owner of the vault), not as the rebalancing guard.
- Squads v4 is the wrong tool for the vault. Use it to hold the program's upgrade authority.
- One swap leg per transaction. A 5-asset rebalance is 3–5 transactions, not atomic. Each leg must be safe on its own.
- The oracle is the hard part, not the vault. Free 24/7 xStock prices on Solana exist only as Pyth `Crypto.SPYX/USD`-style feeds, and fetching Pyth updates now needs an API key.

## 1. What the tokens look like on chain (verified by RPC)

`getAccountInfo` (jsonParsed) on mainnet-beta, Oct 1, 2026:

| Mint | Program | Decimals | Extensions / authorities |
|---|---|---|---|
| SPYx `XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W` | Token-2022 | 8 | freezeAuthority `JDq14B…`, permanentDelegate `5aMNNL…`, pausable (authority `JDq14B…`, paused=false), scaledUiAmount (multiplier 1.003909…, newMultiplier 1.005714560286254 effective ts 1781755200 = Jun 18, 2026 04:00 UTC, so the new one is live), transferHook (authority `5aMNNL…`, programId null), defaultAccountState=initialized, confidentialTransferMint (autoApprove false), metadata |
| NVDAx `Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh` | Token-2022 | 8 | same set; multiplier 1.000918… |
| TSLAx `XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB` | Token-2022 | 8 | same set; multiplier 1 |
| jlUSDC `9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D` | classic SPL Token | 6 | no extensions, **no freeze authority** |
| syrupUSDC `AvZZF1YaZDziPY2RCK4oJrRVrbN3mTD9NL24hPeaZeUj` | classic SPL Token | 6 | no extensions, freeze authority `76Qpx…` |

jlUSDC and syrupUSDC symbols confirmed through Jupiter's token search (`lite-api.jup.ag/tokens/v2/search`), both `isVerified: true`.

What this means for any vault:

- A PDA can own these token accounts. `defaultAccountState` is `initialized`, so a new ATA is usable immediately. Kamino and Jupiter Lend already hold xStocks in program-owned accounts as collateral ($31M and $20M on Jul 23 per Chainlink: https://x.com/chainlink/status/2053905717954744725).
- The transfer-hook slot is empty but its **authority is set**. The issuer can point it at a hook program later; every transfer would then need extra accounts. A vault that passes Jupiter's account list through untouched survives this; a vault that hardcodes transfer accounts breaks.
- Issuer powers no design removes: pause stops every transfer of that mint, freeze locks one account, permanent delegate can move or burn from any account including a PDA vault. Rebalance legs touching a paused mint will fail; the vault must still let the owner withdraw the other assets.
- Amounts on chain are raw. DEX pools and Jupiter quote raw units, so price per raw token = share price × multiplier. The multiplier is readable from the mint account that is already in the swap transaction (use `newMultiplier` once `now >= newMultiplierEffectiveTimestamp`).
- The mix is two token programs (Token-2022 for stocks, classic for USDC/jlUSDC/syrupUSDC). Use Anchor `token_interface` everywhere.

## 2. Option A: custom Anchor program, PDA vault, Jupiter by CPI

**Feasible. Recommended.**

Reference: `jup-ag/jupiter-cpi-swap-example` (pushed Apr 7, 2026; Anchor 0.30.1; https://github.com/jup-ag/jupiter-cpi-swap-example). The program is about 70 lines: a `vault` PDA, input and output ATAs validated with `associated_token::token_program = …` over `TokenInterface`, then `invoke_signed` into `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4` with the instruction bytes and `remaining_accounts` returned by Jupiter's `/swap-instructions`, with `userPublicKey = vault PDA`. The client is hardcoded to classic SPL ("for now, just hardcoded to SPL and not SPL 2022" in `cpi-swap-client/src/main.rs`), but the program side already uses the interface types. Also `jup-ag/sol-swap-cpi` (pushed Apr 2, 2026). `jup-ag/jupiter-cpi` (the old crate) is archived.

**The example is not safe as a vault.** It forwards caller-supplied data and accounts and signs as the vault. Nothing ties the Jupiter instruction's source and destination to the two validated ATAs, and anyone can call it. Jupiter's `route` and `shared_accounts_route` both take a caller-chosen `destination_token_account` (IDL in the example repo, `idls/jupiter_aggregator.json`). A vault must add:

1. Caller is the owner, or the keeper while auto-follow is on and not expired.
2. `in_mint` and `out_mint` are both in the vault's recipe (plus the base stablecoin).
3. Snapshot the vault's input and output ATA balances before the CPI; after it, require input decrease ≤ `amount_in` and output increase ≥ oracle-derived minimum. Do not trust `quoted_out_amount` or `slippage_bps` inside the Jupiter data; the keeper writes those.
4. Reject any writable `remaining_account` that is a token account owned by the vault other than the declared input and output ATAs (the PDA signs the whole CPI, so a crafted route could debit a third vault account).
5. No delegate, close-authority or owner change on vault ATAs after the CPI (re-read and check, as Swig's guard does).
6. Program ID check on Jupiter; no other CPI target.
7. Rate limits (see section 7).
8. `withdraw` is owner-only and depends on nothing else: no keeper, no oracle, no pause flag.

**Jupiter instruction and account counts (measured today, read-only builds with a dummy `userPublicKey`):**

| Leg | Setting | Route | Instruction | Accounts | ALTs |
|---|---|---|---|---|---|
| USDC→SPYx $1k | default | Kipseli + Raydium CLMM | `shared_accounts_route` | 48 | 2 |
| USDC→SPYx $1k | `maxAccounts=24` | Riptide | `shared_accounts_route` | 27 | 1 |
| USDC→SPYx $1k | `maxAccounts=24`, `useSharedAccounts=false` | Riptide | `route` | 23 | 1 |
| SPYx→NVDAx | default | 4 hops | `shared_accounts_route` | 84 | 4 |
| SPYx→NVDAx | `maxAccounts=24` | Riptide ×2 | `shared_accounts_route` | 41 | 2 |
| USDC→jlUSDC $1k | any | Jupiter Lend Earn | `shared_accounts_route` | 31 | 1 |

- `maxAccounts` is a hint, not a cap (24 requested, 27 and 41 returned).
- The default stock-to-stock route (84 accounts) cannot fit a transaction at all. Route stock↔stock as two legs through USDC, or force `maxAccounts`.
- `shared_accounts_route` carries a `token2022_program` account and keeps intermediate hops in Jupiter-owned accounts, so the vault needs ATAs only for recipe mints. Price cost of `maxAccounts=24` on these legs was under 1 bp at $1k.
- Jupiter's guide says to pass `instructionVersion=V2` on `/quote` for Token-2022 fee support (https://developers.jup.ag/docs/guides/how-to-build-a-custom-swap-with-metis). xStocks have no transfer fee, and the V1 instructions above quoted fine. **[unverified]** whether V2 instructions (`route_v2`) are needed for anything here; the IDL in the example repo does not list them.
- `lite-api.jup.ag/swap/v1/quote` and `/swap-instructions` answered without an API key today.

**CPI depth.** Keeper → vault program → Jupiter → AMM → token program is already 4 levels of invocation. Do not wrap keeper rebalances in Swig or Squads (one more level). **[unverified]** whether the runtime depth limit is still 4 on mainnet. The owner's deposit and withdraw through Swig (Swig → vault program → token program) is shallow and fine.

## 3. Option B: Swig smart wallet with a restricted role

Source read: `anagrambuild/swig-wallet` at `main` (pushed Oct 1, 2026), `program/src/actions/sign_v2.rs`, `state/src/action/*.rs`, README. Program `swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB`.

What a role can enforce:

- **Program allowlist.** For every inner instruction that uses the wallet signer, the role needs `Program(program_id)`, or `ProgramCurated` (System, Token, Token-2022, Stake only), or `ProgramAll`. A role with only `Program(JUP6…)` can sign only Jupiter calls.
- **Per-mint spend caps.** After execution, the net decrease of each wallet token account is charged to `TokenLimit(mint)` (lifetime, counts down) or `TokenRecurringLimit(mint)` (per window). No matching limit and tokens left the wallet → denied. Limits are in raw token units, keyed by mint, so Token-2022 mints work.
- **Account integrity.** Wallet token accounts are hashed before the CPI and must be unchanged after it except the amount field (and Token-2022 `TransferFeeAmount.withheld`). Owner, delegate, close authority cannot be changed by the role. An xStock ATA's extensions (pausable-account, transfer-hook-account, immutable-owner) do not change during a transfer, so this should pass. **[unverified, no live test]**; the README's Token-2022 tests cover transfer-fee mints only.
- `TokenDestinationLimit(mint, destination)` exists, but when one is set for a mint every debited unit must be matched to a parsed destination; a Jupiter swap is not a plain transfer. **[inference from the call site, not tested]**: destination limits and Jupiter swaps do not combine.

What it cannot enforce:

- Where swap output goes. Jupiter's `destination_token_account` is chosen by whoever builds the instruction. A keeper role with `Program(JUP6…)` + `TokenLimit(SPYx, N)` can swap N SPYx and deliver the output to its own account. Swig counts only what left.
- Output mint allowlist, minimum output, any oracle check. None exist in the action set (`All`, `AllButManageAuthority`, `ManageAuthority`, `Program*`, `ProgramScope`, `Sol*Limit`, `Token*Limit`, `Stake*`, `SubAccount`, `CloseSwigAuthority`, `RecoveryAuthority`; https://build.onswig.com/protocol/concepts-and-permissions.md).
- Round trips. Limits only count down; tokens coming back do not refill them. A daily recurring cap sized for a full rebalance is also the daily amount a compromised keeper can take.

So Swig-only auto-follow means "the keeper can lose up to X per day", not "the keeper cannot withdraw". That is a real product (xorr-solana and others ship capped delegation), but it is not the claim in Q2.

Other facts:

- Authority types: Ed25519, Secp256k1, Secp256r1 (passkeys), session variants, and `ProgramExec` ("instruction-based authorization driven by another program"). `ProgramExec` could gate a Swig role on a guard program's instruction in the same transaction. **[unverified]**; it would still need a post-swap check, at which point the PDA vault is simpler.
- Sub-accounts are per role (`[swig_id, role_id]`), with create/toggle/withdraw instructions. Good for separating baskets inside one wallet; they do not add swap checks.
- Swig's own Jupiter recipe (https://build.onswig.com/examples/swap.md): `quote` → `swap-instructions` with `userPublicKey = swigWalletAddress`, v0 transaction with Jupiter's ALTs, compute-budget instructions outside the Swig-signed set, create ATAs in a separate transaction first, lower `maxAccounts` for Swig's overhead. Token-2022 is not mentioned.
- Audits in repo: Accretion (2025) and Halborn executive summary (Aug 2026). License AGPL-3.0 (matters only if we fork the program).
- **The program is upgradeable and changing.** Upgrade authority `8o2ZThbZ5Bky4RcPVBYjyWuzVtqfwfqPMbsboTkFf3aQ`; ProgramData last-deploy slot 452,020,847 against current slot 452,293,104, roughly 30 hours before this check. Whether that authority is a multisig is **[unverified]**.

Use for the MVP: Swig is the passkey wallet and the `owner` of each vault. The earlier note's day-1 test still stands: a $10 SPYx swap from a Swig wallet on mainnet.

## 4. Option C: Squads

- Squads v4 `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf` is immutable (ProgramData upgrade authority is `None`, verified by RPC). Best audit and immutability story of the three.
- Its delegation primitive is the spending limit: a member may transfer up to an amount of one token per period to whitelisted destinations without a vote (https://squads.xyz/blog/spending-limits). It restricts transfers, not swaps; there is no per-member program allowlist or post-swap check. A keeper swap would be a full vault transaction (create, approve, execute).
- The newer Squads Smart Account program advertises session keys and programmable policies. **[unverified]**; not read.
- Fit: hold the vault program's upgrade authority in a Squads multisig. Not the vault.

## 5. Option D (found while searching): SPL delegate, no vault

The user keeps tokens in their own wallet and `approve`s a capped amount per mint to our program's PDA. The program pulls input as delegate, swaps through Jupiter, and requires output to land in the user's own ATA, with the same checks as option A. No custody at all, tokens stay visible in the wallet (closest to Cesto's "user receives the underlying"). Costs: one approve per mint, one delegate per token account, allowances count down, and two baskets holding the same mint cannot be told apart. A competitor repo describes this pattern for xStocks (https://github.com/nickthelegend/xorr-solana, **[unverified]**, README only via search). Per-basket PDA vaults are cleaner for a product with several baskets per person.

## 6. Oracles for xStocks on Solana

| Source | What it prices | Market closed | Access |
|---|---|---|---|
| Pyth Core `Equity.US.SPY/USD` | the underlying share | Schedule is 09:30–16:00 ET weekdays; feed metadata showed `is_open: false` at 12:54 UTC today, next open 13:30 UTC. Stale outside the session | Hermes now needs an API key |
| Pyth `Crypto.SPYX/USD`, `NVDAX`, `QQQX`, `GLDX`, `TSLAX` | the token itself | Schedule is open 7 days (`O,O,O,O,O,O,O`), 200 ms channel | same |
| Pyth `Crypto.SPYX/SPY.RR` (also NVDAX, QQQX, TSLAX; none returned for GLDX) | redemption rate (the multiplier) | 24/7 | same |
| Pyth Pro extended-hours feeds | pre-market, post-market, overnight (Blue Ocean) | covers Sun–Thu overnight; still nothing on weekends | paid: US equities plan $5,000/month |
| Chainlink Data Streams, Tokenized Asset schema v10 | `price` (last trade of the underlying), `marketStatus` (0 unknown, 1 closed, 2 open), `currentMultiplier`, `newMultiplier`, `activationDateTime`, `tokenizedPrice` (CEX aggregate of the token) | `price` does not update on weekends; `tokenizedPrice` keeps updating with thin liquidity | signed report verified by CPI to Chainlink's verifier program; report fetch needs Data Streams credentials **[pricing unverified]** |
| Kamino Scope | wraps the above for Kamino Lend | see below | on-chain accounts, readable by any program **[integration unverified]** |

Sources: Pyth feed metadata from `hermes.pyth.network/v2/price_feeds` (still open); `…/v2/updates/price/latest` returned `unauthorized` without a key, matching the Pyth Core upgrade of Aug 26, 2026 ("Hermes now requires an API Key", https://docs.pyth.network/price-feeds/core/upgrade/preparing). Sessions: https://docs.pyth.network/price-feeds/core/market-hours. Extended hours moved to Pyth Pro on Jun 15, 2026: https://www.pyth.network/blog/extended-hours-us-equity-data-moves-to-pyth-pro. Chainlink v10: https://docs.chain.link/data-streams/reference/report-schema-v10 and https://docs.chain.link/data-streams/tutorials/solana-onchain-report-verification (devnet verifier `Gt9S41PtjR58CbG9JhJ3J6vxesqrNAswbWYbLNTMZA3c`; crates `chainlink_solana_data_streams`, `chainlink-data-streams-report`).

How Kamino handles it (the production reference):

- Scope has a `ChainlinkX` oracle type for xStocks v10 reports. It **suspends the price 24 hours before a multiplier activation** and needs a manual resume. v0.41.0 (Aug 31) added a Token-2022 scaled-ui-amount multiplier oracle; v0.42.0 (Sep 28) rejects zero Chainlink prices and auto-approves multiplier changes within a daily bps threshold (https://github.com/Kamino-Finance/scope/releases).
- Off-hours, Kamino accepts Chainlink's price only if it stays within a set percentage of the last market close (https://x.com/KaminoFinance/status/1944791195382681927).

Open questions:

- Whether `Crypto.SPYX/USD` is per raw token (multiplier included) or per share. **[unverified]** Check against a Jupiter quote on day 1: today 1,000 USDC bought 1.3003 raw SPYx, about $769 per raw token.
- Whether Pyth's free tier gives real-time `Crypto.*X/USD` updates and whether sponsored push accounts exist for them on Solana. **[unverified]**
- Whether a hackathon team can get Chainlink Data Streams credentials. **[unverified]** Assume no.

MVP oracle rule that is buildable: keeper posts a Pyth pull update for `Crypto.<TICKER>X/USD` (and USDC), the program requires age ≤ 60 s and confidence ≤ a set fraction of price, and computes min-out from it. When `Equity.US.<TICKER>/USD` is fresh (US session), also require the token feed to be within ~1% of share price × multiplier. Off-hours, either trade with a tighter per-leg size cap or do not auto-rebalance at all. The earlier liquidity note saw single pools print −12% and −27% in thin hours; a token-market feed can follow such prints, so "no keeper rebalances outside the US session" is the safer MVP default, and it costs nothing in the demo.

## 7. How a restricted rebalancer gets exploited, and the guardrails

| Attack | Guard |
|---|---|
| Output sent to the attacker | Program checks the vault's own output ATA delta (section 2, item 3). Swig cannot do this |
| Route through a pool the keeper controls, extract the slippage tolerance | Min-out from the oracle, not from keeper-supplied quote; tolerance ≤ 50–100 bps |
| Churn: swap back and forth, losing the tolerance each time | Leg must move the vault toward target weights (post-trade deviation < pre-trade); daily turnover cap as % of vault value; cooldown per vault |
| Debit a third vault token account inside the route | Reject other vault-owned writable token accounts in `remaining_accounts` |
| Stale or thin-market oracle price | Max age, confidence bound, session check, no trading 24 h around a multiplier activation |
| Malicious recipe update (creator adds an illiquid token they hold) | Auto-follow only within a mint allowlist the follower accepted; new mints need the follower's signature; delay between publish and keeper execution; per-version max weight change |
| Keeper key theft | Keeper can only call `rebalance_leg`; expiry on the permission; owner can revoke in one transaction; global pause that never blocks `withdraw` |
| Program bug | Deposit cap per vault during the hackathon; owner withdraw path with no dependencies |
| Upgrade authority abuse | Squads multisig or disclosed hot key; `solana-verify` build |
| Issuer pause/freeze mid-rebalance | Legs are independent; a failed leg leaves the vault valid; UI shows "paused by issuer" |

## 8. Transaction size and account limits

- v0 transactions: 1,232 bytes, address lookup tables allowed, **64 account locks per transaction** (128 gate not active; https://solana.com/docs/core/constants-reference).
- v1 transactions went live on mainnet Sep 15, 2026 (epoch 1035): 4,096 bytes, **no address lookup tables**, 64 inline addresses. Tooling: `@solana/kit` ≥ 8.0.0, web3.js 3.0.0-rc.3, Agave 4.2+ (https://solana.com/upgrades/larger-transaction-sizes; trade-off analysis https://solana.com/news/transaction-v1-and-the-alt-trade-off). Anchor client, wallet and Jupiter API support for v1 are **[unverified]**.
- Either way the binding limit is 64 accounts. One Jupiter leg is 23–48 accounts; the vault wrapper adds about 10–14 (keeper, vault, vault state, recipe, two mints, two token programs, two ATAs, oracle accounts, Jupiter program). So: one leg per transaction, `maxAccounts` around 24–30, stock↔stock as two legs via USDC.
- Use v0 + Jupiter's ALTs + one ALT of our own static accounts. Well-trodden; no reason to take v1 risk in an 11-day build.
- A rebalance is therefore a sequence of independent transactions: sells first, then buys. The vault's invariants hold after every leg; the UI shows "rebalancing 2 of 4".
- Compute: set the limit explicitly (Jupiter multi-hop plus oracle checks; the Swig example uses 150k for a simple swap). **[unverified]** actual CU for an xStock leg through the wrapper; measure on day 1.
- Pyth price-update posting takes most of a v0 transaction; expect a separate "post prices" transaction before the leg (or a Jito bundle). **[unverified]** sizes.

## 9. Open-source programs to read or reuse

- `jup-ag/jupiter-cpi-swap-example`: starting skeleton (see section 2 for what it lacks).
- `anagrambuild/swig-wallet`: `program/src/isolation/*` and `sign_v2.rs` are a good model for pre/post-CPI account integrity checks (hash everything but the balance).
- `Kamino-Finance/scope`: how to price xStocks (ChainlinkX, multiplier handling, suspension around corporate actions).
- Symmetry v3 (https://docs.symmetry.fi/): program `BASKT7aKd8n7ibpUbwLP3Wiyxyi3yoiXsxBk4Hpumate`, shared-pool vaults with a vault token, up to 100 tokens, SPL and Token-2022, keeper auctions with bounties for rebalances, time-locked intents for config changes, oracles Pyth / Raydium CLMM / Raydium CPMM / LST. License BUSL-1.1, so read, don't fork. It is the ready-made version of the "one shared pool per community index" branch of Q1; TS SDK `@symmetry-hq/sdk`. **[unverified]** whether it accepts the Pyth `Crypto.*X/USD` feeds and whether it has current audits.
- Glider on Solana: no public program source found. **[unverified]**

## 10. Audit and upgrade authority

| Program | Upgradeable | Notes (RPC, Oct 1, 2026) |
|---|---|---|
| Jupiter v6 `JUP6Lk…` | yes, authority `CvQZZ23qYDWF2RUpxYJ8y9K4skmuvYEEjH7fK58jtipQ` | last deploy slot 451,957,263, roughly 37 h before this check. A Jupiter upgrade can change behaviour under us; the post-CPI balance check is what keeps that safe |
| Swig `swigyp…` | yes, authority `8o2ZThbZ5Bky4RcPVBYjyWuzVtqfwfqPMbsboTkFf3aQ` | last deploy roughly 30 h before this check; Accretion 2025 + Halborn Aug 2026 |
| Squads v4 `SQDS4e…` | no (authority None) | immutable |
| Our vault program | our choice | unaudited in 11 days; say so in the app |

For our program: keep it small (target under ~800 lines), run the Solana MCP `program_autofixer` and a second-model review on every change, verified build, deposit cap per vault, upgrade authority disclosed (Squads multisig if time allows), and state in the UI that the owner can always withdraw without the keeper.

## 11. What this means for Q1–Q4

**Q1 (own vault vs shared pool).** Own vault per basket is buildable on Solana in the time available: one PDA + one ATA per recipe mint, Token-2022 and classic mixed. A shared pool needs share accounting and NAV pricing on every deposit and withdraw, so the oracle becomes load-bearing for custody, not just for swap bounds; that is the Symmetry design and it took them an auction system. If a shared pool is wanted for a demo, use Symmetry rather than write one.

**Q2 (auto-follow).** Sound only if enforced by a program that checks post-swap balances. The permission is three fields on the vault: keeper pubkey, expiry, limits. Swig roles cannot express it. Required guardrails are the table in section 7; the minimum set for the demo is output-to-vault check, oracle min-out, mint allowlist, toward-target rule, daily turnover cap, owner revoke, owner withdraw.

**Q3 (nesting).** With own vaults a community index is a recipe account, not a token, so nesting is recipe flattening: personal weights × index weights, merged per mint, with the vault storing which index (and version) each slice came from so an index update re-derives targets. No vault-of-vault, no share token, and no extra transactions. Cap the flattened list (for example 12–16 mints) because every mint is an ATA (rent) and a possible leg.

**Q4 (11-day MVP on Solana).** Realistic scope: `create_vault`, `deposit`, `withdraw`, `set_auto_follow`, `rebalance_leg`, `publish_recipe`/`update_recipe`; a keeper service that watches recipe versions and sends one leg per transaction; Swig as the passkey wallet that owns vaults. Day-1 mainnet tests with about $10: (a) vault PDA holds SPYx and swaps USDC→SPYx through the wrapper, (b) CU and account count for that leg, (c) Pyth update for `Crypto.SPYX/USD` with an API key and what its price unit is, (d) the same swap from a Swig wallet. If (c) fails, fall back to owner-triggered rebalances with an owner-signed max slippage and show auto-follow only during US hours against `Equity.US.*`.

## Sources

- RPC `api.mainnet-beta.solana.com` `getAccountInfo` on the mints and program accounts listed above; `getSlot` = 452,293,104.
- Jupiter: `lite-api.jup.ag/swap/v1/quote`, `/swap-instructions`, `/tokens/v2/search`; https://github.com/jup-ag/jupiter-cpi-swap-example ; https://github.com/jup-ag/sol-swap-cpi ; https://developers.jup.ag/docs/guides/how-to-build-a-custom-swap-with-metis
- Swig: https://github.com/anagrambuild/swig-wallet (README, `program/src/actions/sign_v2.rs`, `state/src/action/{token_limit,program,program_curated}.rs`, `program/src/util/token_integrity.rs`); https://build.onswig.com/llms.txt ; https://build.onswig.com/protocol/concepts-and-permissions.md ; https://build.onswig.com/examples/swap.md ; https://build.onswig.com/protocol/security-and-audits.md ; https://build.onswig.com/protocol/sessions-and-subaccounts.md
- Squads: https://github.com/Squads-Protocol/v4 ; https://squads.xyz/blog/spending-limits
- Pyth: `hermes.pyth.network/v2/price_feeds?query=…`; https://docs.pyth.network/price-feeds/core/market-hours ; https://docs.pyth.network/price-feeds/core/upgrade/preparing ; https://www.pyth.network/blog/extended-hours-us-equity-data-moves-to-pyth-pro
- Chainlink: https://docs.chain.link/data-streams/reference/report-schema-v10 ; https://docs.chain.link/data-streams/tutorials/solana-onchain-report-verification ; https://x.com/chainlink/status/1939763692301922621
- Kamino: https://github.com/Kamino-Finance/scope/releases ; https://x.com/KaminoFinance/status/1944791195382681927 ; https://gov.kamino.finance/t/kamino-is-integrating-xstocks-powered-by-the-chainlink-data-standard-to-enable-tokenized-equities-lending/792
- Solana limits: https://solana.com/upgrades/larger-transaction-sizes ; https://solana.com/news/transaction-v1-and-the-alt-trade-off ; https://solana.com/docs/core/constants-reference
- Symmetry: https://docs.symmetry.fi/
- Earlier notes: `research/solana-liquidity.md`, internal team notes
