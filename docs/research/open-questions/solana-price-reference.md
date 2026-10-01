# Solana price reference for stock tokens

Checked Oct 1, 2026, 13:35–13:50 UTC (US session open since 13:30). Read-only: public docs, GitHub source, public mainnet RPC, Hermes metadata, Kamino public API, one Jupiter quote. Nothing signed, no account created. **[unverified]** marks anything not confirmed against a primary source or a live read.

## Answer

- **Primary: read Kamino Scope's xStock prices on chain.** Free, no key, no person needed. Measured fresh (32–44 s old) for SPYx, QQQx, NVDAx, TSLAx, AAPLx, MSTRx during the US session. No GLDx.
- **Second source / upgrade: Pyth `Crypto.<T>X/USD` pulled by the keeper.** Works on chain today in one instruction, covers GLDx and weekends, but needs a Pyth API key: 14-day trial, then $500/month.
- **Chainlink is out** for this deadline: no equity Data Feeds on Solana, and Data Streams needs a sales contact plus an allowlisted account.
- **Switchboard is out**: it announced a wind-down on Sep 19, 2026, support ended Sep 25 (https://crypto.news/a-solana-oracles-support-ends-today-who-still-relies-on-its-prices/, single source).
- Both Scope and Pyth token feeds quote **per raw token, multiplier already included**. The vault must not multiply again.

## (a) Pyth

**Feeds that exist** (from `hermes.pyth.network/v2/price_feeds`, still open without a key):

| Feed | Id | Schedule |
|---|---|---|
| Crypto.SPYX/USD | `2817b78438c769357182c04346fddaad1178c82f4048828fe0997c3c64624e14` | 7 days |
| Crypto.QQQX/USD | `178a6f73a5aede9d0d682e86b0047c9f333ed0efe5c6537ca937565219c4054d` | 7 days |
| Crypto.NVDAX/USD | `4244d07890e4610f46bbde67de8f43a4bf8b569eebe904f136b469f148503b7f` | 7 days |
| Crypto.TSLAX/USD | `47a156470288850a440df3a6ce85a55917b813a19bb5b31128a33a986566a362` | 7 days |
| Crypto.GLDX/USD | `e7d1138d0083368634087268c64b7bea0b4101a6365f83915cba9e76a8364b96` | 7 days |
| Crypto.SPYX/SPY.RR (also QQQX, NVDAX, TSLAX, AAPLX, …; none for GLDX) | `9e916cc0…811a9` | 7 days, redemption rate |
| Equity.US.SPY / QQQ / NVDA / TSLA / GLD | `19e09bb8…`, `9695e2b9…`, `b1073854…`, `16dad506…`, `e190f467…` | 09:30–16:00 ET weekdays |
| Crypto.USDC/USD | `eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a` | 7 days |

Also present: AAPLX, AMZNX, COINX, CRCLX, GOOGLX, HOODX, METAX, MSTRX.

**The Aug 26 upgrade changed the Solana programs.** New program ids (https://docs.pyth.network/price-feeds/core/upgrade/contracts):

- receiver `rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp` (was `rec5EKMG…`)
- price feed program `pyt2F414BA6dPttK6RddPZUdHfapoBN24GL5wbrPCou` (was `pythWSns…`)
- signer set is now 5 Pyth routers with a 3-of-5 quorum instead of 13-of-19 Wormhole guardians (https://docs.pyth.network/price-feeds/core/upgrade/how-it-works)

**Sponsored on mainnet? No, not for stock tokens.** Read from chain, shard 0 of the new price feed program (PDA seeds: shard as u16 LE, feed id):

| Feed | Account | Age at 13:41 UTC |
|---|---|---|
| USDC/USD | `6HAuqASbHEh4w4REJEUUUCginTLfj1kwCh215ZLtMkrT` | 13 s (sponsored, payer `9F6ApE…`) |
| SOL/USD | `7AviUf9nL62mcxNbQGKm4nKDQnPjswo6c5MX4D57HmyE` | 13 s (sponsored) |
| SPYX/USD | `27Tv3HxU34AKxZ8MgfFAA1gCbWa96msMG5BvSWAHkBfj` | 679 s |
| NVDAX/USD | `VSgf6jkwrcs9jbLuR57iN1Gk2c68vT9stZe8G6GGix2` | 679 s |
| TSLAX/USD | `G8EJV1bqPydBCFZJ2neo1hsrwp2Hwt2ZqJTLG2gotcP2` | 679 s |
| QQQX/USD | `BMcyd2UQqakGbWnNRAC67TLAFhV64dzLVeEyRHKyzmUi` | 143,451 s |
| GLDX/USD, SPYX/SPY.RR, all Equity.US.*, XAU/USD | — | no account |

SPYX, NVDAX and TSLAX are pushed by third parties (payers `4jHcKH…`, `27y3HZ…`, `FRV1hE…`) every 870 s with gaps of 6–10 hours. Not usable under a 60–120 s freshness rule, and nobody owes us those updates. The old-program accounts are days to weeks stale.

**Key tiers** (https://app.pyth.com/plans, fetched today):

- Free, $0: view-only in Pyth Terminal, no API access.
- Starter, $500/month: API key, "all crypto symbols", up to 1 s updates, no redistribution.
- Pro, from $2,500/month: all asset classes including equities.
- A free trial comes with signup (docs). The plans page carries `trialPeriodDays: 14`. **[unverified]** whether the trial needs a card, which plan it trials, and whether `Crypto.*X/USD` counts as "crypto symbols" (their asset type in feed metadata is `Crypto`, so probably yes). `Equity.US.*` almost certainly needs Pro.
- Without a key, `hermes.pyth.network`, `pyth.dourolabs.app/hermes` and `hermes-beta` all return 401 (tested). Reading price accounts on chain needs no key (upgrade FAQ).
- A trial started today ends Oct 15, three days after submission. If people use the live app after that, auto-follow on Pyth stops unless someone pays $500.

**How a program verifies a pulled update.** The keeper fetches the update from Hermes and calls `UpdatePriceFeed` on the price feed program (or `PostUpdate` on the receiver for a throwaway account). The receiver checks the 3-of-5 signatures and the Merkle proof and writes a 134-byte `PriceUpdateV2` account. Our program then checks: owner is `rec2HH…`, verification level is Full, feed id matches, `publish_time` within max age, confidence under a set fraction of price. Layout confirmed by parsing live accounts: 8 discriminator, 32 write authority, 1 verification level, 32 feed id, i64 price, u64 conf, i32 exponent, i64 publish time, i64 previous publish time, i64 EMA price, u64 EMA conf, u64 posted slot.

**Size and compute, measured from mainnet transactions:**

- One `UpdatePriceFeed`: 376 bytes of instruction data, 7 accounts, 27–36k CU, fully verified, one transaction (e.g. `5FExD6J8…`, 790-byte message).
- Two feeds in one transaction: 61k CU, about 1,080–1,150 bytes (e.g. `3rgGNnuo…`).
- So an update will not share a 1,232-byte v0 transaction with a Jupiter leg. Plan on two transactions per leg (update, then leg reading the account with a max age of about 60 s), or a Jito bundle. Version-1 transactions are already on mainnet (the public RPC returned them for transactions touching the USDC feed account); whether update plus leg fits in one is **[unverified]**.
- Using our own shard id gives fixed account addresses the program can pin. Rent is one-time, about 0.002 SOL per feed.

**SDK catch.** `pyth-solana-receiver-sdk` needs the `pro-compatible` feature for the new ids. Version 1.2.0 requires `anchor-lang ^0.32.1` and 2.0.0 requires `^1.0.2`; we are on 0.31.1. Either bump Anchor or parse the 134 bytes by hand (about 30 lines, layout above). TS side: `@pythnetwork/pyth-solana-receiver` with `PRO_COMPATIBLE_*` program ids, `@pythnetwork/hermes-client` with `accessToken` (https://docs.pyth.network/price-feeds/core/upgrade/preparing/solana).

**Price unit, settling the memo's open question.** `Crypto.SPYX/USD` was 769.31 at 13:30 UTC; a Jupiter quote at 13:45 gave 768.35 USDC per raw token; Scope showed 767.6–767.9. The share price times the 1.005715 multiplier fits; the bare share price (about 764) does not. The feed is per raw token.

## (b) Chainlink on Solana

- **Data Feeds:** Chainlink's own directory lists 13 feeds on Solana mainnet, all crypto or exchange rates, no equities, ETFs or gold (https://reference-data-directory.vercel.app/feeds-solana-mainnet.json). One is useful elsewhere: `SYRUPUSDC-USDC Exchange Rate`.
- **Data Streams:** this is what Kamino uses for xStocks (schema v10: price, market status, multipliers). On-chain verification requires "an allowlisted account in the Data Streams Access Controller (contact us to get started)", and report fetching needs API credentials from the same sales contact (https://docs.chain.link/data-streams/tutorials/solana-onchain-report-verification). No self-serve or trial found. Pricing **[unverified]**.
- For a two-person team with 11 days: ask if you like (https://chain.link/contact?ref_id=datastreams), don't plan on it.

## (c) Kamino Scope

**Another program can read it.** Scope prices sit in a plain account owned by the Scope program `HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ`. For Kamino's xStocks market (`5wJeMrUYECGq41fxRESKALVcHnNX26TAWy4W98yULsua`) every reserve points at the same prices account, read from the reserve configs on chain:

- prices account `3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH`, mappings `4zh6bmb77qX2CL7t5AJYCqa6YqFafbz3QJNeFvZjLowg`
- entry `i` is at byte `8 + 32 + 56*i`: u64 value, u64 exponent, u64 last-updated slot, u64 unix timestamp, 24 bytes generic

| Token | Price index | 1h TWAP index | Price at 13:47 UTC | Age |
|---|---|---|---|---|
| SPYx | 344 | 279 | 767.94 | 44 s |
| QQQx | 347 | 281 | 744.33 | 44 s |
| NVDAx | 332 | 269 | 231.59 | 44 s |
| TSLAx | 338 | 273 | 357.49 | 44 s |
| AAPLx | 317 | 259 | 333.17 | 44 s |
| MSTRx | 335 | 271 | 158.78 | 44 s |

The market also lists GOOGLx, HOODx, CRCLx, METAx (indices not read). No GLDx. All six entries are type `CappedFloored` (read from the mappings account), a composite that by Kamino's own posts sits over its Chainlink xStock source (inference, the chain was not walked). The reserves' max price age is 300 s.

**Terms.** There are none for third-party readers.

- The code is BUSL-1.1 with no production-use grant, including the `scope-types` crate (https://github.com/Kamino-Finance/scope/blob/master/LICENSE). Do not depend on that crate; read the 56 bytes by hand. Reading a public account is not use of their code, but that is my reading, not legal advice.
- The index-to-token mapping is not stored on chain (README), so Kamino can remap an index. Pin `(prices account, index)` per asset in our config, make it admin-updatable, and re-derive it from the Kamino reserve in the keeper before each run.
- Scope suspends an xStock price for 24 hours before a multiplier change and resumes by hand (release notes). For us that is the wanted behaviour: stale price, no keeper trade.
- **[unverified]** how fresh entries are pre-market, overnight and at weekends. One read on Saturday settles it.

## (d) Alternatives

- **DEX time-weighted price from the main pool.** Needs our own accumulator account and a cranker, and the earlier liquidity note saw single pools print −12% and −27% in thin hours. More to build than (a) or (c) and weaker. Scope's own 1h TWAP entries (indices above) give the same thing for free if a smoothing check is wanted. Skip.
- **Keeper's quote bounded by a second source.** With no oracle at all, the only second source is one we sign ourselves: the backend signs `{mint, price, time}` with a key separate from the keeper's, and the program checks it through the Ed25519 instruction. It is quick to build but the "untrusted keeper" claim becomes "trust the team's price key". Last resort only.

## Recommendation

**Primary: Scope.** Per asset, the program stores a price source `{ScopeEntry(account, index) | PythFeed(account, feed id)}` and an optional second source. A keeper leg requires the primary to be at most 120 s old and, if a second source is configured and fresh, the two to agree within 1%. Cash is valued from the sponsored Pyth USDC/USD account, which needs no key. No multiplier is applied on chain.

**Fallback and upgrade: Pyth `Crypto.<T>X/USD`** through our own shard's price feed accounts, updated by the keeper just before each leg. It adds GLDx, weekends, and independence from Kamino's config.

What auto-follow can do on Solana:

| Setup | Auto-follow covers | Limits |
|---|---|---|
| Scope only (no person needed) | SPYx, QQQx, NVDAx, TSLAx and the other Kamino-listed xStocks, whenever the Scope entry is fresh; confirmed for the US regular session | GLDx is one-tap only. Hours outside the regular session unconfirmed. Stops if Kamino remaps or suspends, which fails closed |
| Scope + Pyth key | The above with a cross-check, plus GLDx on Pyth alone, plus weekends on Pyth alone | Off-hours the Pyth token feed follows thin pools, so use a smaller per-leg cap or keep off-hours off. Two transactions per leg. $500/month after the trial |
| Pyth key only | All five tokens, all hours | Same off-hours caveat; dies when the key lapses |
| Neither | Nothing automatic. Followers get the one-tap prompt and sign with their own slippage | — |

For agents using the app: have `getPrices` return the source, price, age and whether a keeper leg would pass right now, so an integrating agent can check before it asks for a rebalance.

## Steps for a person

1. Decide whether a 14-day Pyth trial that may convert to $500/month is acceptable. If yes, sign up at https://pythdata.app/signup, take the trial on the plan that includes crypto symbols, and create one API key for the keeper. Then confirm with one call that `Crypto.SPYX/USD` and `Crypto.GLDX/USD` return data: `curl -H "Authorization: Bearer $PYTH_API_KEY" "https://pyth.dourolabs.app/hermes/v2/updates/price/latest?ids[]=2817b784…"`.
2. Optional: tell Kamino (Discord or the Scope repo) that the vault reads their xStocks Scope entries, and ask about off-hours behaviour.
3. Optional: email data@dourolabs.xyz asking for an extension of the trial.
4. On Saturday Oct 3, have an agent re-read the six Scope entries and record their age.

Nothing else here needs a person. An agent can build and test the Scope read against a mainnet-forked local validator today.
