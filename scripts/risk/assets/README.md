# The asset universe, one file per chain

`pnpm risk:assets <chain>` (`docs/risk/PLAN-ASSETS.md` AS.2 and AS.3, gate `ASSET-UNIVERSE`, decision DA2) writes `solana.json` and `robinhood.json` in this folder: every token of the classes the product knows on that chain, whether or not a plan may hold it, each with a status and its reason. They are generated and committed, as the stock lists in `scripts/risk/universe/` are, and those stock lists are not changed: a tracked stock's row here names its row there (`tracked`) and copies neither its pools nor its oracle.

```sh
pnpm risk:assets solana      # the Solana builder, scripts/risk/assets/solana.ts
pnpm risk:assets robinhood   # the Robinhood Chain builder, scripts/risk-evm/assets.ts
```

## How a list is made

- **`build.ts`** loads the chain's builder (each exports `buildList(args: string[]): Promise<{ list, lines? }>`), validates what it returns with `UniverseList` (`packages/schemas/src/asset-universe.ts`), checks that every verdict of `<chain>.verdicts.json` names a row of the list, writes `<chain>.json`, formats it, and prints the counts per category, status, class, deciding layer and null reason and each read's calls and seconds. A list that does not validate, or a verdict for an address that is not a row, writes nothing.
- **The builder** reads the chain and its listings and decides which verdict rules each token matches. It never types a verdict.
- **The verdicts** are `<chain>.verdicts.json` (schema `UniverseVerdicts`), reviewed by hand: `rules` for every token a listing names in one way, each with its sources, and `verdicts` for one address each. The builder refuses a verdict for an address it did not read (`unreadVerdicts`), and the command checks it again on the list.
- **A row** is joined by `universeRow` in `packages/risk/src/assets/universe.ts`: the identity read on chain, the context from the chain's own files (pools, oracle, shelf, tracked row), and the verdict fields, taken in this order with the later winning: what the builder derived by a method it states, each matching rule in the table's order (each once), the token's own verdict; the row's `decidedBy` names the layers. The class is always the category's (`CATEGORY_CLASS`). A field no layer sets stops the run, naming the token and the field.
- **What the schema refuses besides missing reasons:** a status that offers what the plan holds out (a permissioned token, a token with a maturity or in another currency, a token with no class, a dollar-yield token with no leg type: these are `held_out` or `excluded`); a tracked stock without its tracked row, or any other row pointing at one; a standard, a symbol source, an authority or the issuer registry of the other chain; an EVM implementation without a proxy.

Nothing in a row is a price, a TVL, a supply or a yield: those are observations with their own time (AS.4 and AS.5).

## Files

| File | What it is |
|---|---|
| `build.ts` | The command |
| `solana.ts`, `solana.verdicts.json`, `solana.json` | The Solana builder, its verdicts, its list (AS.2) |
| `robinhood.verdicts.json`, `robinhood.json` | Robinhood Chain's verdicts and list; its builder is `scripts/risk-evm/assets.ts` (AS.3) |

## Solana

```sh
DOTENV_CONFIG_PATH=<main checkout>/.env pnpm risk:assets solana \
  --registry <main checkout>/data/risk/registry-20261001T0139.json \
  --reads-dir <main checkout>/data/assets/solana     # live: reads, saves them, writes solana.json
pnpm risk:assets solana --from <solana-reads-<stamp>.json[.gz]>   # rebuild from saved reads, no network
pnpm risk:freeze-assets-solana <solana-reads-<stamp>.json>        # freeze them for the test
```

The builder is `solana.ts` (all I/O) and `solana-list.ts` (the list from the reads; no I/O, no clock). The byte decoders are `packages/risk/src/assets/spl-mint.ts` (`decodeMint`, `decodeMetaplexMetadata`, `solanaIdentity`), tested on frozen mainnet accounts. `SOLANA_RPC_URL` loads through dotenv; without it the scripts fall back to the public RPC.

**Inputs, in the prompt's order (5.2), each read recorded in `list.reads` with its calls, seconds, rows and errors.** Jupiter's verified list, live (`lite-api.jup.ag/tokens/v2/tag?query=verified`), every tag kept and cut to id, symbol and tags; `risk_lending_pools` in the local Postgres (one read-only `SELECT`), whose mints and debt mints name dollar tokens and the reserves' Scope chains; the research note `docs/vault/research/yield-shelf/solana.md` (every full address in backticks) and its shelf fixture; DefiLlama's stablecoins and protocols on Solana in the RWA and yield categories, as names only; the issuers' pages of `solana.issuer-mints.json`, each fetched again and searched for the mint it is said to print. Read as files: the tracked list, the structurer's registry, `deployments/solana-devnet.json`, the Scope table, `content/stocks/solana.json`, the launch-shelf seed, the engine's leg types and the pool registry `data/risk/registry-20261001T0139.json`. Then every candidate's mint by `getMultipleAccounts` (100 a call, the slot kept per call) and, for each mint that holds no metadata of its own, its Metaplex metadata account at the derived address. A Jupiter token is a candidate when it carries a tag a rule asks for or has a verdict; every address another source names is a candidate.

**How a rule's `match` is read** (`MATCH_KEYS` in `solana-list.ts`); every key must hold, and an unknown key stops the run:

| Key | Holds when |
|---|---|
| `jupiterTag` | Jupiter's verified list carries the tag for the token |
| `minter` | the mint authority read on chain is this address |
| `freezeAuthority`, `permanentDelegate` | that authority, read on chain, is this address |
| `program` | the token program read on chain is `spl` or `token2022` |
| `nameEndsWith` | the name the chain answers ends with this text |
| `nameKind` | what the name method (`kindOfName`) reads in a stock issuer's token's name: `stock`, `equity_etf`, `gold_fund`, `commodity_fund`, `treasury_fund`, `bond_fund`, `crypto_fund`, `leveraged_etf` |
| `listedIn` | the token is on today's shelf that way (`structurer_registry`, `deploy_record`, `tracked_stock`), or `any`, or `none` |

The stock issuers' rules rest on keys read on chain: one mint authority for xStocks and for Ondo, one freeze authority and permanent delegate for Backpack's tokens. The `lst` rule rests on Jupiter's tag alone, as no key read on chain is shared by the stake pools. A stock issuer's rule is matched first, so the name method can read the ticker; then every rule is matched. A token Jupiter tags `deprecated` is not a row, nor one whose rules leave a verdict field unset; both are named in `stated.rules`.

**What the builder derives**, the lowest layer of `decidedBy`, only for a token of a stock issuer's rule (`xstocks`, `ondo-global-markets`, `backpack-securities`): `underlying`, the chain's symbol less the issuer's suffix (`x`, `on`; Backpack's symbol is the ticker); `category`, from what the name the chain answers says the token is (`kindOfName` in `solana-list.ts`, tested on real names). The tracked list's class table (`CLASS_BY_UNDERLYING`: SPY and QQQ funds of shares, GLD gold, SLV and USO commodities, SGOV Treasuries) wins where it names the ticker. Otherwise a name with no fund word (ETF, ETN, Fund, Index, a fund-only sponsor such as iShares, SPDR or Vanguard, an index such as S&P 500 or Russell 2000) is a stock; a fund is, in this order, leveraged or inverse (2x, 3x, Bull, Bear, UltraPro, ProShares Ultra or Short), of crypto assets, of gold, of another commodity (miners, services and producers are shares, not the metal), of Treasuries or government bonds, of other bonds or income, else of shares. Categories: a stock `tokenized_stock`, a fund of shares `tokenized_etf`, gold `tokenized_gold`, a commodity `tokenized_commodity`, Treasuries `treasury_fund_open` with no leg type (`not_screened_on_solana`), a leveraged, crypto or bond fund `tokenized_etf`. The rules `stock-issuer-*` hold out every fund that is not screened. A name without a fund word is a stock whatever the token is (JPSTx, a short-bond fund, is one).

**Context.** `id`: the tracked list's, else the shelf fixture's, else `solana:<slug of the chain's symbol>` (`+` as plus, `*` as star); two rows on one slug each take the first six characters of their address. `listedIn`: by mint in the structurer's registry; as the model of a test-network token (`modelOf`, matched to the one named mint that answers that symbol); a tracked stock. A tracked stock's row names its tracked row and reads its pools and oracle there (`in_tracked_row`). `oracle`: a Scope entry of the Scope table, else a one-entry Scope chain of a Kamino reserve of the lending import; `no_scope_entry` where a reserve of the import holds the token and names no chain, `scope_not_read` where none does (the import holds only the xStocks markets). A Pyth feed the launch-shelf seed names goes in `unverifiedOracles`, never read. `pools`: the registry file's pools that hold the mint on either side, else `no_registered_pool`; that registry was built for the stock tokens, so the count is the pools a token shares with a stock token. `attributes`: an xStock's row of `content/stocks/solana.json`, by symbol.

**Status rules**, which the verdicts follow: `listed` where `listedIn` is not empty; a stock token outside the cut that names the tracked stocks `candidate` (DA16); a fund among them that is not screened (Treasuries, bonds, crypto, leveraged or inverse) `held_out`; dollar yield by the research note's verdict (add, add with caution: `candidate`; hold: `held_out`; out: `held_out` or `excluded` by its reason), `verdictSource` naming the note and section; a dollar-yield token the research has not screened `held_out`; permissioned funds `held_out` (DA4); another currency `held_out` (USD-ONLY, DA7); crypto `candidate` (DA6); a maturity or no class `held_out`; defunct, exploit-linked or not the asset it claims `excluded`. Leg types come from the note and are held to `packages/engine/src/personal/leg-types.ts` by the shelf fixture's symbol: a difference stops the run.

**`access`** is set only where a source says it: `permissioned` (an allowlist or terms that bar the holder: the permissioned funds, eUSX), `front_end_geo_blocked` (the issuer bars countries from minting or buying: USDY, the Etherfuse tokens, ONyc), else `null`, `not_read`.

**What the list states** (`stated`): the scope and enumeration with their counts; how identity, ids, rules, derived fields, status, leg types, oracle and pools are read; what the xStocks and Ondo tokens are on chain (their programs, authorities, metadata hosts and extension sets, counted); the verified tokens that are not rows, by reason, with the ones carrying a class tag listed for review; the mints other sources name that are not rows; DefiLlama's stablecoins with no row; the issuer pages' answers; what is not enumerated (BRS, memecoins, Base, the Kamino deposit tokens no listing names, PUMP and MET).

### The crypto selection (Rodrigo, 2026-10-11)

Beyond SOL, the LSTs and the named wrapped and governance tokens, the list takes every token of Jupiter's verified list that is **tagged `major` or `strict`, or traded at least $50,000 on Jupiter in the 24 hours before the read** (`SELECTION_FLOOR_USD`; its `stats24h` buy and sell volume picks a token and is dropped: the saved Jupiter row holds `selected` only). Each picked token is a row with a verdict of its own, or is listed in `solana.left-out.json` with its reason and where it was read; a token Jupiter tags meme, launchpad or moonshot is counted by the builder. A new row's mint is named by CoinGecko's coin list (`api.coingecko.com/api/v3/coins/list?include_platform=true`, one keyless call each run, the row citing the coin's page; a row whose coin the list no longer names for that mint says so in `unverified`) or by an issuer's page, and it is read on chain like every other row: the builder reads every address of the verdict table. Categories: a coin of another chain `wrapped_btc`, `wrapped_eth` or `wrapped_other` with the coin's ticker as `underlying`; a staking token `liquid_staking`; a protocol, network or product token `governance` with the project as issuer (`issuerKind` `defi_protocol` for any project, `bridge` where the bridge issues the Solana token); a stablecoin no research note has screened held out; a pool share or a leveraged token `other`, held out. A memecoin, whose project is no protocol, chain or product by CoinGecko's meme category or a review of its name and CoinGecko's, is not a row; nor is a project no page read confirms (`project_not_confirmed`), nor a token no source names (`no_source_names_the_mint`).

### The run of 2026-10-11 (reads from 15:27 UTC)

2,213 rows, from the mints read at the slots of the run's 23 calls. By category: tokenized_stock 1,668, tokenized_etf 155, liquid_staking 148, governance 128, tokenized_commodity 16, stablecoin_usd 14, treasury_fund_open 13, wrapped_other 10, stablecoin_synthetic 9, lending_deposit 8, wrapped_btc 8, tokenized_gold 7, fixed_maturity 6, other 6, private_credit 5, stablecoin_other 4, basis_strategy 3, wrapped_eth 2, treasury_fund_permissioned 2, native 1. By status: candidate 2,075, held_out 97, listed 24, excluded 17. By class: stock 1,668, crypto 297, etf 155, dollar_yield 37, cash 27, commodity 16, gold 7, none 6. Decided by: xstocks 1,321, ondo-global-markets 449, backpack-securities 74, stock-issuer-treasury-fund 10, stock-issuer-bond-fund 22, stock-issuer-crypto-fund 3, stock-issuer-leveraged-etf 23, prestocks 10, lst 146, on-todays-shelf 24, a verdict of its own 216 (159 of them from the crypto selection). The selection picked 573 tokens: 262 are rows; 197 are tagged meme or launchpad by Jupiter, 39 more are memecoins by review, 17 projects are not confirmed, 53 have no source naming the mint, 3 are stock tokens no rule takes, 2 are of no class.

Reads: Jupiter 3,933 tokens, 1 call, 0.4 s; risk_lending_pools 41 rows, 1 call, 0.0 s; DefiLlama 73 stablecoins and 56 protocols, 1 call each, 1.3 s and 2.6 s; 49 issuer mints on 33 pages, 33 calls, 7.6 s, every page answering with its mint in the HTML; CoinGecko's coin list, 1 call, 0.1 s; 2,224 mint accounts, 23 calls, 4.4 s; 332 Metaplex accounts, 4 calls, 0.6 s; the pool registry's 5,951 pools, a file. No errors.

What the reads say of the stock issuers: the 1,321 tokens Jupiter tags `xstocks` are all Token-2022 with one mint authority (`7pt9…aCj`), one freeze authority, one permanent delegate and one metadata update authority, their metadata on `xstocks-metadata.backed.fi`, and Backed's product pages print their mints: Backed's xStocks. The 449 tagged `ondo` share one mint authority (`9foM…UxD`), two freeze authorities (390 with USDY's), no permanent delegate, and their metadata on `app.ondo.finance`: Ondo Global Markets. Every one of both starts new accounts initialised (not frozen), is not paused, and sets no transfer-hook program. By the name method, 1,658 of the issuers' tokens are stocks and 186 funds (107 of shares, 23 leveraged or inverse, 22 of bonds, 16 of commodities, 10 of Treasuries, 5 of gold, 3 of crypto assets).

The list is over biome's 4 MiB limit; `biome.json` raises it for `scripts/risk/assets/*.json` alone (an override).

| File | What it is |
|---|---|
| `solana.ts` | The builder's reads (all the I/O) |
| `solana-list.ts` | The list from the reads: rules, context, ids, what is stated. No I/O |
| `solana.verdicts.json` | The reviewed rules and verdicts |
| `solana.issuer-mints.json` | The mints the issuers' own pages print, fetched again on each run |
| `solana.left-out.json` | The tokens the crypto selection picks that are not rows, each with its reason and source (reviewed) |
| `solana-repo.ts` | The repository's files the list reads, frozen with the reads and held to the files by the test |
| `freeze-solana.ts` | `pnpm risk:freeze-assets-solana`: the reads into `fixtures/risk/assets/` |
| `fixtures/risk/assets/solana-reads-20261011T1527Z.json.gz` | The frozen reads of the committed list (593 KB) |
| `tests/risk-assets-solana.test.ts` | Rebuilds the committed list from them with no network; the decoders on frozen accounts; the refusals |
