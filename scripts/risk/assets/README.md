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
| `minter` | the mint authority read on chain is this address (named so that no key in the table reads as a credential to the secret scanner) |
| `program` | the token program read on chain is `spl` or `token2022` |
| `nameEndsWith` | the name the chain answers ends with this text |
| `listedIn` | the token is on today's shelf that way (`structurer_registry`, `deploy_record`, `tracked_stock`), or `any`, or `none` |

**What the builder derives**, the lowest layer of `decidedBy`, only for a token of a stock issuer's rule (`xstocks`, `ondo-global-markets`, `backpack-securities`): `underlying`, the chain's symbol less the issuer's suffix (`x`, `on`; Backpack's symbol is the ticker); `category`, `tokenized_stock` or the fund category the tracked list's class table names for the underlying (`CLASS_BY_UNDERLYING`: SPY and QQQ `tokenized_etf`, GLD `tokenized_gold`, SLV and USO `tokenized_commodity`, SGOV `treasury_fund_open` with the engine's leg types of SGOV). No other fund among the issuers' tokens is told apart: no read gives a token's kind.

**Context.** `id`: the tracked list's, else the shelf fixture's, else `solana:<slug of the chain's symbol>` (`+` as plus, `*` as star); two rows on one slug each take the first six characters of their address. `listedIn`: by mint in the structurer's registry; as the model of a test-network token (`modelOf`, matched to the one named mint that answers that symbol); a tracked stock. A tracked stock's row names its tracked row and reads its pools and oracle there (`in_tracked_row`). `oracle`: a Scope entry of the Scope table, else a one-entry Scope chain of a Kamino reserve of the lending import; else `no_scope_entry`. A Pyth feed the launch-shelf seed names goes in `unverifiedOracles`, never read. `pools`: the registry file's pools that hold the mint on either side, else `no_registered_pool`; that registry was built for the stock tokens, so the count is the pools a token shares with a stock token. `attributes`: an xStock's row of `content/stocks/solana.json`, by symbol.

**Status rules**, which the verdicts follow: `listed` where `listedIn` is not empty; a stock token outside the cut `candidate`, "outside the 80% cut" (DA16); dollar yield by the research note's verdict (add, add with caution: `candidate`; hold: `held_out`; out: `held_out` or `excluded` by its reason), `verdictSource` naming the note and section; a dollar-yield token the research has not screened `held_out`; permissioned funds `held_out` (DA4); another currency `held_out` (USD-ONLY, DA7); crypto `candidate` (DA6); a maturity or no class `held_out`; defunct, exploit-linked or not the asset it claims `excluded`. Leg types come from the note and are held to `packages/engine/src/personal/leg-types.ts` by the shelf fixture's symbol: a difference stops the run.

**What the list states** (`stated`): the scope and enumeration with their counts; how identity, ids, rules, derived fields, status, leg types, oracle and pools are read; what the xStocks and Ondo tokens are on chain (their programs, authorities, metadata hosts and extension sets, counted); the verified tokens that are not rows, by reason, with the ones carrying a class tag listed for review; the mints other sources name that are not rows; DefiLlama's stablecoins with no row; the issuer pages' answers; what is not enumerated (BRS, memecoins, Base, the Kamino deposit tokens no listing names, PUMP and MET).

### The run of 2026-10-11 (reads from 02:26 UTC)

2,055 rows, from 2,066 mints read at slots of the run's 21 calls. By category: tokenized_stock 1,841, liquid_staking 147, stablecoin_usd 9, lending_deposit 8, fixed_maturity 6, governance 5, private_credit 5, tokenized_commodity 5, treasury_fund_open 5, tokenized_etf 4, basis_strategy 3, stablecoin_other 3, tokenized_gold 3, wrapped_btc 3, stablecoin_synthetic 2, treasury_fund_permissioned 2, other 2, native 1, wrapped_eth 1. By status: candidate 1,995, held_out 22, excluded 14, listed 24 (the 18 tracked stocks, USDC, USDT, USDY, syrupUSDC, jlUSDC, PAXG). By class: stock 1,841, crypto 157, dollar_yield 29, cash 14, commodity 5, etf 4, gold 3, none 2. Decided by: xstocks 1,321, ondo-global-markets 449, backpack-securities 74, lst 147, prestocks 10, jupiter-deprecated 1, on-todays-shelf 24, a verdict of its own 57; the builder derived the underlying and category of 1,844. Null reasons: `oracle` no_scope_entry 2,030 (in_tracked_row 18); `pools` no_registered_pool 1,964 (in_tracked_row 18); `access` not_read 2,013; `mintRedeem` not_read 2,044; `issuer` not_read_per_token 144; `legTypes` not_screened_by_the_research 3 and not_read 3; `authorities.permanentDelegate` none 643, `freeze` none 174, `mint` none 6.

Reads: Jupiter 3,933 tokens, 1 call, 0.4 s; risk_lending_pools 41 rows, 1 call, 0.0 s; DefiLlama 73 stablecoins and 56 protocols, 1 call each, 1.2 s and 2.5 s; 48 issuer mints on 33 pages, 33 calls, 6.9 s, every page answering with its mint in the HTML; 2,067 mint accounts, 21 calls, 3.5 s; 200 Metaplex accounts, 3 calls, 0.4 s; the pool registry's 5,951 pools, a file. No errors.

What the reads say of the stock issuers: the 1,321 tokens Jupiter tags `xstocks` are all Token-2022 with one mint authority (`7pt9…aCj`), one freeze authority, one permanent delegate and one metadata update authority, their metadata on `xstocks-metadata.backed.fi`, and Backed's product pages print their mints: Backed's xStocks. The 449 tagged `ondo` share one mint authority (`9foM…UxD`), two freeze authorities (390 with USDY's), no permanent delegate, and their metadata on `app.ondo.finance`: Ondo Global Markets. Every one of both starts new accounts initialised (not frozen), is not paused, and sets no transfer-hook program.

| File | What it is |
|---|---|
| `solana.ts` | The builder's reads (all the I/O) |
| `solana-list.ts` | The list from the reads: rules, context, ids, what is stated. No I/O |
| `solana.verdicts.json` | The reviewed rules and verdicts |
| `solana.issuer-mints.json` | The mints the issuers' own pages print, fetched again on each run |
| `freeze-solana.ts` | `pnpm risk:freeze-assets-solana`: the reads into `fixtures/risk/assets/` |
| `fixtures/risk/assets/solana-reads-20261011T0226Z.json.gz` | The frozen reads of the committed list (521 KB) |
| `tests/risk-assets-solana.test.ts` | Rebuilds the committed list from them with no network; the decoders on frozen accounts; the refusals |
