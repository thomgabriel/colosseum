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
