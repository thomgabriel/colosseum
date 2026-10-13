# PROMPT (build): the asset universe of Solana and Robinhood Chain, every class, and the pipeline that keeps its data

> Written 2026-10-10 by Rodrigo's session. Run it in a fresh Claude Code session started in the main checkout, `~/Documents/Colosseum`, so the hooks load, and work in a new worktree cut from `origin/staging` (the main checkout sits on an old docs branch). It builds the data layer only: which assets exist on each chain and what is known about each, kept current by jobs. Which of them a plan may hold stays Rodrigo's decision (section 8).

---

## The prompt

You build the asset universe of Tenonfi on two chains, Solana and Robinhood Chain, and the pipeline that ingests its data. "Universe" means every token of the classes the product knows (tokenized stocks and funds, gold and commodities, dollar yield in its four leg types, stablecoins and cash, crypto, and the other real-world assets such as tokenized funds and non-dollar bonds), whether or not a plan may hold it, each with a status and a reason. "Pipeline" means scripts and scheduled jobs that read identity, supply, price, pool liquidity, protocol TVL, volume and yield for every row, with `source`, `fetched_at`, `method` and `provenance` on every figure, into the database the product reads, and the backfill that takes each series as far back as its source goes (section 6.4). The dataset is for analysis and decision support: Bearing's facts, the engine's calibration, and what the model may state by reference (`FIGURES-BY-REFERENCE`). The model never reads a row to set a weight (`CLAUDE.md`). Act as the orchestrator in `.claude/rules/orchestration.md`: delegate bounded pieces, run at most two implementation agents at once, review every diff yourself, and get each pull request reviewed by an agent that did not write it.

### 1. Read first

1. `CLAUDE.md` and `.claude/rules/orchestration.md`. Every rule there binds; the ones this work meets most are the provenance rule, "no hard-coded APYs" (`tests/no-yield-literals.test.ts`), the Oct 12 rule on the collectors, and "never read `.env`".
2. `docs/GATES.md`, these rows above all: `UNIVERSE`, `EVM-ROWS`, `EXIT-SOURCE`, `ORACLE-VS-DEX`, `PRICE-JOB`, `JOBS-RELOAD-OCT6`, `VOLUME-DEXSCREENER`, `GOLD-PAXG`, `PROTECT-NO-STOCKS`, `ANY-COMPOSITION`, `USD-ONLY`, `ENG-DEVNET-EXIT-TWIN`, `BYREAL` and `BYREAL-D4`, `BASE`, `SHOW`, `SPEND`, `COUNTRY-REMOVED`, `G-NORA`.
3. `docs/risk/PLAN-UNIVERSE.md` in full: section 2 (what is known), section 4 (decisions DU1 to DU8: the money that counts, where a list lives, pools the vault cannot reach, no second oracle, where the loop runs, no `chain` column, funds ranked with stocks, trades not quotes), section 5 (what that plan left out: "a yield or exchange-rate reading for treasury and dollar-yield tokens" is this prompt's work) and section 6 (status per item). Then `docs/risk/PROMPT-BUILD-UNIVERSE.md`, whose standing constraints this prompt repeats and extends.
4. `docs/risk/PLAN-RISK.md` decisions D4 (a venue is read only after its decoder passes validation), D18 (oracle and pool price kept apart), D20 (a stablecoin at par is a recorded decision, never an assumption) and D22 (the price job); `docs/risk/PLAN-ANALYTICS.md` section 5 (the methodology the API serves word for word).
5. The research that already screened the dollar-yield class: `docs/vault/research/yield-shelf/solana.md` and `robinhood.md` (sections 1, 4, 5 and 7 above all: the verdicts, what was left out and why, what waits on Rodrigo, and the rollout table), `comparison.md`, `TEMPLATE.md`, and the two input lists under `inputs/`. The launch-shelf proposal of Oct 1, `docs/vault/research/open-questions/launch-shelf.md` and `launch-shelf.seed.json`, never approved as written, and `docs/vault/research/solana-liquidity.md`.
6. `docs/vault/DESIGN-VAULT.md` section 2 (the layout table and the import rules `tests/boundaries.test.ts` enforces; a new folder under `packages/` or `apps/` needs a row in both), section 4 (the data model) and section 7 (how dollar yield is filled, with leg types and caps). `docs/DATA-MODEL.md` for the structurer's and the risk layer's tables.
7. `docs/vault/STATE-VAULT.md`: rows RISK-4, RISK-5, SHELF-YIELD, SHELF-YIELD-SOL, SHELF-YIELD-RH, ENG-DEVNET-YIELD and ENG-DEVNET-EXIT, and who holds the migration token (the last migration on `staging` is `0020_vault_numbers.sql`).
8. Code, as files, not summaries. It is what you extend, and most of it is reused, not rebuilt:
   - The stock universe: `scripts/risk/universe/README.md`, `build.ts`, `list.ts`, `robinhood.json`, `solana.json`; `packages/schemas/src/universe.ts` (`TrackedAsset`, `AssetList`); `packages/risk/src/universe.ts` (`trackedSet`); `tests/risk-universe-list.test.ts`.
   - How each chain's tokens are enumerated today: `scripts/risk/discover-pools.ts` (Jupiter's verified list, tag `xstocks`, then DexScreener pairs) and `scripts/risk/build-registry.ts` on Solana; `scripts/risk-evm/registry.ts` (`REGISTRY_URL`, the issuer's registry `https://api.robinhood.com/rhj/assets`, each address confirmed on chain), `universe.ts`, `discovery.ts`, `discover.ts`, `cut.ts`, `pareto.ts`, `feeds.ts` and `oracles.ts` (Chainlink's directory), `oracle.ts` and `listed.ts` on Robinhood Chain; `scripts/risk-evm/README.md` first.
   - The shelf as the product holds it: `packages/schemas/src/basket-asset.ts` (`AssetClass`: stock, etf, gold, commodity, dollar_yield, crypto, cash; `PriceKind`; `currency` on a cash token), `packages/schemas/src/asset.ts` (the structurer's `Asset`, `YieldObservation`), `packages/engine/src/assets/registry.ts` (`REGISTRY`, nine rows), `packages/engine/src/personal/registry.ts` (eligibility by class), `leg-types.ts` (`LEG_TYPES`: rate, credit, basis, market_deposit), `testing.ts` and `packages/engine/src/personal/fixtures/shelves/solana-yield.json` and `robinhood-yield.json` (one `BasketAsset` per screened token, with the verdict and what was not verified), `fixtures/risk/launch-shelf-tiers.json`.
   - How rows reach the database: `scripts/seed-assets.ts`, `seed-evm.ts`, `seed-models.ts` (`assets`), `scripts/solana/basket-assets.ts` and `deploymentAssets` in `packages/chain-solana/src/vault/deployment.ts` and `packages/chain-evm/src/vault/deployment.ts` (`basket_assets`, from the deploy records under `deployments/`), `tests/seed-evm.test.ts`, `tests/seed-models.test.ts`.
   - Prices: `packages/risk/src/prices/observation.ts` (`PriceSourceId`: `pool_mid`, `kamino_scope`, `jupiter_lend_oracle`, `external:<name>`), `resolve.ts`, `reference.ts`, `liveness.ts`; `scripts/risk/prices/job.ts`, `lib.ts`, `db.ts`, `import.ts`, `validate.ts`, `install-job.sh`; the tables `risk_price_observations` and `risk_reference_prices` in `packages/db/src/risk-schema.ts`, and `price_observations` in `basket-schema.ts`.
   - Yields: `packages/engine/src/feeds/yields.ts` (`fetchKaminoUsdc`, `fetchRealised30d`, `fetchAggregator`), `haircuts.ts`; `scripts/feeds/refresh.ts`, `refresh-models.ts`, `model-rounds.ts` (SGOV's rate from its Chainlink rounds); `apps/api/src/model-yields.ts`; the table `yield_observations`.
   - Liquidity and TVL: `risk_pools` (`tvl_usd`, `discovery_liquidity_usd`, `discovery_volume24h_usd`, `exit_path`, `tier`), `risk_asset_snapshots`, `risk_depth_curves`, `risk_lending_pools`; `apps/api/src/liquidity.ts`, `plan-inputs.ts`, `model-exits.ts`; `apps/api/src/routes/risk.ts` (what `GET /risk/assets` answers: `poolTvlUsd`, `pools`, `capacityAtTau`); `apps/web/features/bearing/dex.ts`.
   - The job pattern you copy: `scripts/risk/prices/install-job.sh` and `scripts/risk/jobs/`, `scripts/risk/raw-arrays/` (a job added beside the collectors without touching them). `scripts/risk/collector/`, `scripts/launchd/` and `scripts/depth-snapshot.mjs` are read only until Oct 12 and are not what you edit after it either: new readers are new files.
   - The sourced content per chain: `content/stocks/<chain>.json` (attributes of the tracked stocks, read by `apps/api/src/stock-attributes.ts`) and `content/themes/<chain>/`. The universe does not repeat them: a stock row points at its tracked row and its attributes row.
   - `fixtures/README.md`, `fixtures/risk/universe/`, `fixtures/risk-evm/`: how a real read is frozen for a test.

### 2. What exists, in one table

| Class | Solana | Robinhood Chain | Where |
|---|---|---|---|
| Stocks and funds | 18 tracked (the 80% rule), 869 pools, 10 with a Scope oracle; the full xStocks list is read from Jupiter at discovery and not kept as a list | 30 tracked of the issuer's 195 tokens, 427 pools, 24 with a Chainlink feed; the 195 are in `data/risk-evm/universe-robinhood-<stamp>.json` on Rodrigo's machine, not committed | `scripts/risk/universe/`, gate `UNIVERSE` |
| Gold, commodities | GLDx tracked; PAXG decided as the product's gold (`GOLD-PAXG`), not in any list | GLD, SLV, USO tracked, class from the list's table (DU7) | same |
| Dollar yield | 24 candidates screened Oct 6: 7 "add" or "add with caution", the rest held or out, each with the filter that decided; fixture rows only | 8 candidates screened: 2 to add with caution, 3 for Rodrigo, 3 out | `docs/vault/research/yield-shelf/`, `packages/engine/src/personal/fixtures/shelves/` |
| Stablecoins and cash | USDC and USDT in the structurer's registry; the rest named in the screening's exclusions (PYUSD, USX, USDG) and nowhere else | USDG and USDe named as the chain's dollars in the screening; "USDC" there is a junk pool | `packages/engine/src/assets/registry.ts`, the notes' section 4 |
| Crypto | SOL, JitoSOL, cbBTC, JUP and others in the Oct 1 proposal, never approved; nothing read since | wstETH, weETH named and left out of the yield screening | `launch-shelf.seed.json`, `fixtures/risk/launch-shelf-tiers.json` |
| Other RWA | The permissioned funds named as excluded (BUIDL, OUSG, BENJI, USTB, VBILL, USYC, WTGXX, ACRED); Etherfuse bonds in four currencies screened and held out | None deployed, by the screening | the notes' sections 3 and 4 |
| Prices | Pool mid, Scope and Jupiter Lend oracles for the tracked stocks and the lending assets; one reference price per asset and hour (RISK-4); the hourly job reads Solana rows only | The Chainlink answer beside the pool price, each hour (RU.7), in `risk_price_observations` | `scripts/risk/prices/`, `scripts/risk-evm/oracle.ts` |
| Yields | Nine registry rows through `pnpm feeds:refresh`; jlUSDC and SGOV through `feeds:refresh-models` | SGOV only | `scripts/feeds/` |
| Pool TVL, volume | Every registered pool at registry build, DexScreener's 24 h volume at discovery | In the cut files, not in the database (DU6) | `risk_pools`, `data/risk-evm/` |
| Supply, holders, protocol TVL, AUM, token standard and authorities | Nothing systematic. Decimals and the token program are read where a token is listed; Token-2022 extensions are known for xStocks and PAXG from reads recorded in `GATES.md` | Nothing systematic | |

So: the stock class is done and stays as it is; the dollar-yield class is screened but not read; the other classes are not enumerated; and no table holds token-level facts over time. This prompt fills those three gaps.

### 3. Where the work happens

Cut every branch from `origin/staging`. Use your own worktrees under `~/Documents/`; do not touch the worktrees already there (`Colosseum-ru*`, `-byreal`, `-shelf-*`, `-try`, `-engine` and the rest), and never the one at `.claude/worktrees/risk-analytics`, from which the Robinhood collector loop runs. Its files are under `~/Documents/Colosseum-data/risk-evm` (`RISK_EVM_DIR`); the Solana collectors' cache is under `~/.colosseum/risk` (`RISK_HOME`); both are read only for you. Scripts that need a node read `SOLANA_RPC_URL` through `dotenv`: run them with `DOTENV_CONFIG_PATH=~/Documents/Colosseum/.env` so a worktree does not fall back to the public endpoint, and never open that file yourself.

| Branch | What it holds | PR into |
|---|---|---|
| `universe/assets-plan` | `docs/risk/PLAN-ASSETS.md` (section 4) and the schema of a universe row (section 5), with its tests; the categories and their mapping to `AssetClass` | `staging` |
| `universe/assets-solana` | The Solana enumeration and list, from reads; its fixtures and tests | `universe/assets-plan` |
| `universe/assets-robinhood` | The same for Robinhood Chain | `universe/assets-plan` |
| `universe/assets-metrics` | The metrics table, the readers, the import and the job installers (section 6) | `universe/assets-plan`, after the two lists exist |

The two chains are separate tracks and run in parallel once the plan branch is pushed. Open each pull request as a draft with `/open-pr` when its checks pass, stacked on the one below it; do not wait for a merge to keep building. Push only what is verified.

### 4. The plan document, first

Before any list is written, `docs/risk/PLAN-ASSETS.md`, in the shape of `PLAN-UNIVERSE.md` and no longer than it: a summary; what we know now, with evidence (section 2 above, checked against the code on the day); the steps, each with its check; a decisions table with the defaults of section 8 and their status; what is not in the plan; a status section you keep as you go, one row per step with the counts and the commands. Add a row for it in `docs/README.md` under `risk/`, and a ledger row in `docs/vault/STATE-VAULT.md` under a new prefix, `ASSET-` (`ASSET-1` the plan, the schema and the two lists; `ASSET-2` the metrics and the jobs), with the check each row is proven by. Gate rows go in `docs/GATES.md` under a heading "Decided on <date> (the orchestrator; pending Rodrigo)", as the Oct 6 entries did: you propose, he decides. Record what you chose in the status section as "stated, not chosen", the way RU.12 did.

### 5. The universe row

One file per chain, generated by a command and committed, as the stock list is (DU2): `scripts/risk/assets/<chain>.json`, built by `pnpm risk:assets <chain>` from the reads of section 5.2, validated by a zod schema `UniverseAsset` and `UniverseList` in a new file under `packages/schemas/src/`, additive, importing nothing outside the package. The stock list is not changed: a stock row of the new list names its row in `scripts/risk/universe/<chain>.json` by `id` and copies nothing it holds.

#### 5.1 The fields

Identity, read on chain: `id` (`chain:slug`, in the form of `BasketAsset.id`), `chain`, `address`, `symbol` and `name` as the chain answers them, `decimals`, `standard` (`spl`, `token2022`, `erc20`, `erc4626`, or another named one), `extensions` (Token-2022 extensions by name; on EVM whether the contract is an upgradeable proxy, pausable, or holds a blacklist, each as read from the code or the verified source, else `null` with a reason), `authorities` (mint, freeze and permanent delegate on Solana; owner or admin on EVM; `null` where none, with the read that says so).

What it is, from the issuer and the research, each with a source: `issuer`, `issuerKind` (a regulated fund manager, a bank, a DeFi protocol, a stablecoin issuer, a bridge), `underlying` (in the form the shelf uses: `NVDA` for NVDAx), `category` (the fine category of section 5.3), `cls` (an `AssetClass`, or `null` with `clsReason` when none fits), `legTypes` for a dollar-yield token (the four of `leg-types.ts`, with the source each was read from; a token with no reading has `null`, never a guess), `currency` where it is not dollars, `yieldMechanism` (`accruing_price`, `rebasing`, `exchange_rate`, `distribution`, `none`, or `null` with a reason), `access` (`open`, `permissioned`, `front_end_geo_blocked`), `mintRedeem` (the primary path, whether it needs KYC, the minimum, the time, as published; `null` with a reason), `oracle` (as `TrackedOracle` where there is a Scope entry or a Chainlink feed; a Pyth feed is recorded as `unverified` and never read, DU4; else `null` with a reason).

Where it stands: `status`, one of `listed` (on today's shelf: the structurer's registry, a deploy record's model, or a tracked stock), `candidate` (passes the research filters, not decided), `held_out` (a research verdict or a gate holds it out: `USD-ONLY`, a permissioned fund, a missing leg type), `excluded` (defunct, exploit-linked, a junk contract, not the asset it claims), with `statusReason`, and `verdictSource` naming the note and section where a verdict exists. `pools` (how many pools the chain's registry or cut knows for it, and the file), `sources` (`[{ url, title, readOn }]`, at least one per row), `unverified` (what the row says that was not read on a source, as the fixture shelves do), and `source`, `fetchedAt`, `method`, `provenance` on the row.

Nothing in the row is a price, a TVL or a yield. Those are observations, in the table of section 6, so a figure never sits in a committed file older than the hour it was read.

#### 5.2 How a chain is enumerated

The lists are generated from reads, never typed. The verdict columns (`status`, `statusReason`, `category`, `legTypes`, `access`, `mintRedeem`) come from a reviewed table in `scripts/risk/assets/<chain>.verdicts.json` whose every row names its source; the command refuses a verdict row for an address it did not read.

Solana, in this order, each read recorded with its calls and duration: Jupiter's verified token list (`https://lite-api.jup.ag/tokens/v2/tag?query=verified`, the call `discover-pools.ts` makes) with every tag it carries, so stocks, LSTs and the rest come from one read; the Kamino and Jupiter Lend reserves the lending import already knows (`risk_lending_pools`), whose collateral and debt tokens name dollar tokens and LSTs; the two screening notes and their inputs for the dollar-yield class and the permissioned funds; DefiLlama's public lists for stablecoins and for protocols on Solana in the RWA and yield categories, as a source of names only; the issuers' own pages for the rest. Names to start from, none a fact until its mint is read and an issuer page names it: the xStocks and PAXG and GLDx; USDC, USDT, PYUSD, USDG, FDUSD, USDe and sUSDe, EURC, AUSD, USD1, USDS and sUSDS; USDY, OUSG, BUIDL, BENJI, USTB, USYC, VBILL, WTGXX, ACRED, kUSDC and the other Kamino and Jupiter Lend deposit tokens, syrupUSDC, jlUSDC, PST, PRIME, AUTO, wYLDS, ONyc, USD\*, eUSX, oTFY, the Etherfuse bonds; SOL and the LSTs Jupiter tags (JitoSOL, mSOL, bSOL, jupSOL, INF, bbSOL), cbBTC, wBTC, zBTC, tBTC, WETH; the governance tokens the Oct 1 proposal named (JUP, RAY, JTO, PYTH, KMNO). Memecoins are not enumerated (the Oct 1 note: no meme index in the MVP); say so in the plan.

Robinhood Chain, in this order: the issuer's registry, every row, not only the cut, with the chain's `decimals()` and `symbol()` beside the registry's and the registry's `status`, `isin` and `multiplier` kept (as `scripts/risk-evm/registry.ts` reads them); the Chainlink directory for the feeds; the dollar tokens and yield tokens of the screening note (USDG, USDe, USDT, WETH and ETH as gas, wstETH, weETH, steakUSDG, syrupUSDG, spUSDG, PT-USDG-25MAR2027, rUSDG, mGLO, syrupUSDC); DexScreener's pairs for the chain (its slug is `robinhood` in `scripts/risk-evm/config.ts`) as a source of names of what else trades there, each confirmed on chain before it is a row. The venues that are not Uniswap (Alandale, Giga, Ramses, Ekubo, PancakeSwap) stay unread (D4, `BYREAL-D4`); their tokens may be rows, their pools are counted from DexScreener's listing and marked as not confirmed.

Base is not enumerated (`BASE`).

#### 5.3 Categories

Propose the fine categories in the plan and map each to an `AssetClass` or to none, for Rodrigo to confirm (DA1). A starting table, to be checked against what the reads find:

| Category | `cls` | Examples |
|---|---|---|
| `tokenized_stock`, `tokenized_etf` | `stock`, `etf` | NVDAx, SPY |
| `tokenized_gold`, `tokenized_commodity` | `gold`, `commodity` | PAXG, GLDx, SLV, USO |
| `treasury_fund_open`, `treasury_fund_permissioned` | `dollar_yield` with `rate`; permissioned ones `cls` set and `status: held_out` | USDY, SGOV; BUIDL, OUSG |
| `lending_deposit` | `dollar_yield` with `market_deposit` | kUSDC, jlUSDC, steakUSDG |
| `private_credit`, `basis_strategy` | `dollar_yield` with `credit` or `basis` | syrupUSDC, sUSDe |
| `fixed_maturity` | `dollar_yield`, `held_out` (the engine models no maturity) | PT-USDG, Etherfuse bonds |
| `stablecoin_usd` | `cash` | USDC, USDT, USDG, PYUSD |
| `stablecoin_other` | `cash` with `currency` | EURC |
| `native`, `liquid_staking`, `wrapped_btc`, `wrapped_eth`, `governance` | `crypto` | SOL, JitoSOL, cbBTC, WETH, JUP |
| `lp_share`, `yield_claim` | none: `clsReason` says the vault cannot hold it | Uniswap positions, Pendle YT |

### 6. The metrics and the jobs

#### 6.1 Two narrow tables, one migration

Two new tables in `packages/db/src/risk-schema.ts`, by one migration. `asset_observations`: `chain`, `address`, `metric`, `value` (double, nullable), `unit` (`usd`, `tokens`, `fraction`, `count`), `null_reason`, `observed_at` (the time the state refers to: block time, or the source's own stamp), `detail` (jsonb: the parts a derived figure was made of, the pools summed, the window of a realised yield), `method_version`, and the four provenance columns; primary key `(chain, address, metric, source, observed_at)`. One table for every metric, so a new metric is a new `metric` value and not a migration. `market_bars`: one hour of one pool, or of one asset across its pools, built from the swap history (section 6.4) and, going forward, from the collectors: `chain`, `address`, `pool` (`asset` for the row across pools), `hour`, open, high, low and close in the quote and in dollars, VWAP, `swaps`, `buy_swaps`, `sell_swaps`, `volume_usd`, `unpriced_swaps`, `detail` (the pools of an asset row and each one's share), `method_version` and the provenance columns; primary key `(chain, address, pool, hour, method_version)`. `risk_pool_flow` stays what it is (windowed aggregates per pool); the bars are the time series it never held. Before you generate the migration (`0021`), check the ledger and the open pull requests for another holder of the migration token; if one exists, stop that slice and say so, and build the readers to a file in the meantime. `tests/db-schema.test.ts` and `docs/DATA-MODEL.md` say what tables exist: update both, and section 4 of `DESIGN-VAULT.md` if it lists the table.

Prices do not go in this table. A price is a `PriceObservation` to `risk_price_observations` (`priceSource` `external:<name>` for an aggregator, `pool_mid` for a pool, `kamino_scope`, and for a Chainlink answer the id `scripts/risk-evm/oracle-import.ts` already writes, since RU.7's rows land in that table through it), and the hourly resolver writes the reference price. Yields of the structurer's registry rows keep going to `yield_observations` through `feeds:refresh`; a yield read for any other row goes to `asset_observations` as metric `yield_<method>` until Rodrigo decides which rows join the registry (DA5). Exit cost is not read here: it is Bearing's collectors', and a row's exit figure is read from `risk_depth_curves` as the API already does.

#### 6.2 The metrics, each with its method

| Metric | Means | Read | Cadence |
|---|---|---|---|
| `supply_total` | Tokens in existence on this chain | `getTokenSupply` on Solana; `totalSupply()` at a pinned block on EVM | hourly |
| `supply_issuer` | What the issuer says is outstanding, where published | The issuer's page or API, named per row | daily |
| `holders_top20_share` | The share of supply in the twenty largest accounts | `getTokenLargestAccounts` on Solana; `null` with reason `no_free_indexer` on EVM unless one is found and recorded | daily |
| `price_usd` | Per whole token, by source | As section 6.1; never blended across sources (D18); a stablecoin is never set at par by this work (D20) | hourly |
| `pool_tvl_usd` | The dollars in the pools the chain's registry or cut knows for the token | Solana: `risk_pools.tvl_usd` summed, with the pools in `detail`; Robinhood Chain: from the newest cut file, with its stamp; a token with no registered pool is `null`, reason `no_registered_pool` | hourly where read, else at each registry build |
| `dex_volume_24h_usd` | DexScreener's figure, under its own name (`VOLUME-DEXSCREENER`) | One GET per token | daily |
| `protocol_tvl_usd` | What the protocol behind a yield token holds, in its own terms | The protocol's API (Kamino, Morpho, Maple, Jupiter Lend) or DefiLlama's protocol TVL, named per row | hourly |
| `exchange_rate` | Tokens of underlying per share, for an exchange-rate token | `convertToAssets(1e<decimals>)` on an ERC-4626; the reserve's exchange rate on Kamino; the multiplier for SGOV | hourly |
| `yield_realised_30d`, `yield_quoted` | As `fetchRealised30d` and the protocol APIs do it today, haircut by the registry's rules where the row is a registry row | The methods of the two notes' rollout tables (section 7 of each), one per token, named in the row | hourly |

A missing fact is `null` with a reason, never zero. A figure a free source does not give is left missing and listed in the plan's status; a source that needs a key or a payment is not used, and its name goes in the decisions table for Rodrigo.

#### 6.3 The readers and the jobs

Pure code in `packages/risk/src/assets/` (no I/O, no clock; it takes reads and returns rows), I/O in `scripts/risk/assets/` (Solana) and `scripts/risk-evm/` (Robinhood Chain, as the universe items did), one import command that upserts the rows and prints the counts, and one installer per chain in the pattern of `scripts/risk/prices/install-job.sh`: a new launchd bundle beside the collectors' that edits none of their files and reloads none of their jobs (`PRICE-JOB`). You write the installer and its dry run; Rodrigo installs it. Every run appends a line to a run log with its calls, duration and errors per token, as `data/risk-evm/runs.jsonl` does. Files go under `data/` and are not committed; fixtures are real reads frozen under `fixtures/risk/assets/` and `fixtures/risk-evm/`, and no test calls the network.

#### 6.4 History: how far back, and at what grain

Rodrigo's rule (2026-10-10): forward from now, store everything at the finest grain the source gives, for good. The backfill is bounded to the windows the analyses use, by series (the limits below, his decision the same day: "we can always expand later"), since these markets are young and change by multiples in months, and the one expensive fetch, per-swap history on Solana, buys little beyond a quarter. Three layers, all kept, and every row says which it came from.

1. **Raw events on disk**, compressed per pool or token and day under `data/`, the way `scripts/risk/history-full.ts` and `scripts/risk-evm/history.ts` already write them: every swap, every liquidity event, every mint and burn, every oracle round, with a manifest per pool or token (window covered, counts, the completeness checks that passed or failed). Not in Postgres.
2. **Hourly bars in Postgres** (`market_bars`), built from layer 1 for the past and from the collectors forward. Daily figures are derived from the hours, not stored twice.
3. **Facts over time** in `asset_observations` and `risk_price_observations`: supply at every change from the mint and burn series, holders on EVM from the transfer set, each oracle round as a price observation under its source, realised yield from the bar closes, protocol TVL where an API publishes history.

What each source allows, measured by the work before this:

| Source | Past state | Past events | Measured |
|---|---|---|---|
| Robinhood Chain, public RPC | None: a block's state is gone within minutes (`scripts/risk-evm/README.md`) | `eth_getLogs` for the chain's whole life, 100,000 blocks a window, halved when refused | RU.14: 30 days of 427 pools in about 90 minutes, 15.4M swaps, 6.3 GB of day files, four waits for rate |
| Solana, the RPC the risk scripts use | A recent snapshot plus a backward replay (`packages/risk/src/replay.ts`) | `getSignaturesForAddress` and `getTransaction`, served back to at least 2025-04-15 (the lending history: 1.6M transactions over 515 days) | Step 5b: 45M signatures walked in 35 minutes, 24.8M transactions fetched at about 495 a second, 5 to 8 GB per 28 days of 34 pools |
| Chainlink feeds on Robinhood Chain | Every round since each feed's first phase, by `getRoundData` through Multicall3 | | RU.5 and RU.7 read the proxies; the history is one more loop over round ids |
| Kamino's Scope on Solana | Per refresh since 2025-07, from klend's logs, already extracted (`scripts/risk/prices/extract.ts`) | | RISK-4 |
| Our own collectors | 5-minute pool state on Solana since 2026-10-01, hourly on Robinhood Chain since 2026-10-02 | | the only fine-grained state there is; it cannot be recovered for earlier dates except by replay |
| DefiLlama coins, CoinGecko without a key, the protocols' APIs | Daily back to a token's listing; hourly only for recent windows; verify each limit on the day | | `fetchRealised30d` reads one |

The limits, set on 2026-10-10 and open to widening later:

| Series | Depth | Why that far |
|---|---|---|
| Robinhood Chain events: swaps, liquidity events, transfers at the zero address | Each pool's and token's first block | Hours of logs; it costs little and gives supply and holders since launch |
| Solana swaps and liquidity events, per transaction, for the pools of the tracked stocks and of every listed or candidate token | 90 days, rolling | Exit cost, depth and routing are read by hour-of-week regime, one sample per cell per week: about 13 weeks is where they settle, and older liquidity says little about today's |
| The same pools, older than 90 days | Back to inception, sampled: a fixed number of swaps per hour, the walk `scripts/risk/history-backfill.ts` already does | Hourly bars and cost-per-trade estimates at a small fraction of the fetch |
| Prices: oracle rounds, Scope from the klend logs, aggregator series | Whole life, hourly where the source has it, else daily | Cheap, and backtests of plans need at least a year of prices |
| Yields, supply, protocol TVL, holders on EVM | Whole life, daily | Cheap; adoption and rate questions are asked "since launch" |
| Pool state (depth curves, concentration) | Oct 1, 2026 forward from the collectors; on Solana the replay of `packages/risk/src/replay.ts` for the 90-day window only, wherever a pool's events pass the completeness checks (three pools failed them over 28 days; a failed replay is `null`, never a curve) | State cannot be read in the past; the replay is only as good as the events under it |
| Pool state on Robinhood Chain before Oct 2 | Not rebuilt | A v3 and v4 replay does not exist: a later step, not this prompt (DA13) |
| The mints of USDC and USDT | Not walked | Billions of transactions; their supply comes from the external daily series, said so |

A question about one past event outside a window is answered by fetching that window on demand: the walkers are windowed and resumable, and the plan says how.

The order, since the backfill runs for days and is not on the Oct 12 path: (1) Robinhood Chain logs for the whole life of every pool and token of the list, swaps first, then transfers at the zero address, then liquidity events; (2) every Chainlink round; (3) Solana: count first (`history-full-measure.ts walk` style), then fetch every swap and liquidity event of the pools of the tracked stocks and of every listed or candidate token over the last 90 days, newest day first so a stopped run still leaves a usable window, and then the sampled walk from day 91 back to each pool's first transaction; (4) the mints of the listed and candidate tokens on Solana, whole life; (5) the external daily series for every row. Each step records its window, counts, errors, bytes and duration in the plan's status before the next starts, and the bars of the 28 days both chains already hold are built and checked against `risk_pool_flow`'s windows before anything older is fetched.

### 7. Standing constraints, and why

- **Read-only on mainnet.** `eth_call`, `getAccountInfo`, `getTokenSupply`, `getTokenLargestAccounts`, public GETs. No transaction is built, signed or sent; no key is read. Never read `.env` or anything under `secrets/`.
- **Do not disturb what is running.** The Solana launchd jobs and the Robinhood loop collect data that cannot be collected again. Do not stop, reload or re-install any of them, write nothing under `~/.colosseum/` or `~/Documents/Colosseum-data/`, and do not edit `scripts/launchd/`, `scripts/risk/collector/` or `scripts/depth-snapshot.mjs`.
- **Additive only.** The vault work reads `LiquidityProvider`, the `/risk/*` routes, `basket_assets`, `assets`, and the stock lists. Keep their shape. The stock lists and `TrackedAsset` do not change. New fields are optional; new behaviour sits behind a new command.
- **Provenance.** Every figure carries `source`, `fetched_at`, `method` and `provenance`; the lists carry them on every row. No price, fee, supply or yield literal outside `fixtures/`; `tests/no-yield-literals.test.ts` must stay green. A verdict is a decision with a source, never a figure.
- **Oracle and pool price are kept apart** (`ORACLE-VS-DEX`), and an aggregator's price is a third thing with its own name, never the reference by itself.
- **Layout.** `packages/schemas` imports nothing; `packages/risk` imports only `schemas` and never `engine`; a new folder under `packages/` or `apps/` needs a row in the layout table and in `tests/boundaries.test.ts`. No new library reads `process.env`.
- **RPC and API manners.** Use the existing clients and their backoff (`scripts/risk-evm/rpc.ts`, `rpc()` on Solana). Batch with Multicall3 and `getMultipleAccounts`. Record calls and duration. If a free endpoint refuses a range or a rate, narrow it and say so; do not hammer it.
- **Tests come with the code**, on frozen fixtures, and a failed check is a finding: do not widen a tolerance or weaken a test to pass it. `pnpm verify` runs alone (other sessions' tests make `assess-bounds` time out; `--maxWorkers=4` before calling it a failure), and the tests need `pnpm db:up`.
- **Git.** Stage your own files by path; never `git add -A`. Nothing under `data/` is committed. No `Co-Authored-By` line. Gitleaks scans every commit: a made-up address or key in a test trips it, so use the real public addresses you read or a low-entropy placeholder. Do not push an unverified branch, and do not merge anything.
- **Money, keys and deploys** are a person's. Installing a job, a change to live data, a paid source, a deploy: stop and ask, and keep building what does not depend on it.

### 8. Decisions for Rodrigo, with the default you proceed on

| # | Question | Default | Stop? |
|---|---|---|---|
| DA1 | The fine categories and their mapping to `AssetClass` | The table of section 5.3, amended by what the reads find, recorded in the plan | no |
| DA2 | Where the all-class list lives | `scripts/risk/assets/<chain>.json`, generated and committed; the stock list unchanged beside it | no |
| DA3 | One narrow `asset_observations` table, by migration `0021` | Yes, if the migration token is free; else readers to files and the table in a later slice | stop if the token is held |
| DA4 | Permissioned funds (BUIDL, OUSG, BENJI, USTB, USYC, VBILL, WTGXX, ACRED) | In the list, `held_out`, metrics read where public; never on a shelf, since a vault cannot be put on an allowlist | no |
| DA5 | Which screened dollar-yield tokens join the structurer's registry and get a `yield_observations` reading | None by this work; the readings go to `asset_observations` until he decides, by `/decide` under `UNIVERSE`, from the notes' section 5 | no |
| DA6 | Crypto: the native token, LSTs, wrapped BTC and ETH, governance tokens | Enumerated and read, class `crypto`, status `candidate`; memecoins not enumerated | no |
| DA7 | Non-dollar assets (EURC, the Etherfuse bonds) | Enumerated with `currency`, status `held_out` under `USD-ONLY` | no |
| DA8 | Free sources accepted as `external:<name>` | DefiLlama, DexScreener, CoinGecko's free endpoint without a key, the issuers' and protocols' public APIs, Jupiter's lite API, Chainlink's directory; nothing that needs a key | stop before any paid or keyed source |
| DA9 | Cadence and where the jobs run | As section 6.2; on Rodrigo's machine beside the other jobs (DU5), installed by him | the install is his |
| DA10 | A `chain` column | Not on the existing tables (DU6); the new tables have one from the start | no |
| DA11 | How far back | Decided by Rodrigo, 2026-10-10: the table of section 6.4. Whole life where it is cheap (Robinhood Chain events, prices, yields, supply, holders); 90 days of per-swap history on Solana, sampled back to inception beyond that; state from Oct 1 with the Solana replay over the 90 days. Open to widening later | no |
| DA12 | The grain kept | Raw events on disk, hourly bars in Postgres, facts at every change; per-swap rows in Postgres only for the reference pools of the shelf, and only if he asks | no |
| DA13 | Pool state on Robinhood Chain before Oct 2 | Not rebuilt by this work; a v3 and v4 replay is listed as a later step with its cost | no |
| DA14 | Disk and RPC budget | Count before fetching; stop and report if the measured plan exceeds 100 GB on disk or the RPC starts refusing; a keyed indexer (Helius DAS, Dune, an archive node) is DA8's question | stop at the limit |
| DA15 | USDC and USDT supply history | External daily series only; their mints are not walked | no |

### 9. Done means

- Both lists exist, validate, and are committed with the command that made them; the plan's status says how many rows per chain, per category and per status, and how many rows carry each `null` with its reason.
- Each row has at least one source and its identity fields were read on chain; a test holds the committed list to its frozen inputs, as `tests/risk-universe-list.test.ts` does.
- The metrics import writes rows for every row of both lists into the local database, with the counts printed, and a dry run of each job completes with no write.
- The backfill of section 6.4 is counted before it is fetched, the 28 days both chains already hold are turned into bars and checked against `risk_pool_flow`, and the plan's status says per chain how far back each series reaches, with counts, bytes and the checks that failed.
- `pnpm verify` passes locally and on GitHub for each pull request; no test weakened or skipped; `tests/no-yield-literals.test.ts` and `tests/boundaries.test.ts` green.
- The ledger rows `ASSET-1` and `ASSET-2` carry the evidence; `docs/README.md`, `docs/DATA-MODEL.md` and `GATES.md` say the new things; the plan's decisions table says what was chosen and what waits on Rodrigo.
- Each pull request reviewed by `/review-pr` or an agent that did not write it, with the findings fixed or answered.

### 10. Report, at the end

Delivered outcome; the counts (rows per chain, class and status; metrics read, missing with reasons; per series, the first date reached on each chain, the rows, the bytes on disk); verification evidence (the commands and their output, the pull request links); what could not be verified and why; the decisions waiting on Rodrigo, each with its default and what would change it; and the two things only he does, in one line each: install the jobs, and `/decide` the shelf.
