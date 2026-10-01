# Basket app: technical design

Oct 1, 2026. For Thom, and for the Claude agents that build each piece. The product is defined in `HANDOFF-BASKET.md`; the research behind the vault rules is in `research/vaults/`. Nothing here has been run on mainnet yet, so section 9 comes first in time.

## 1. What gets built

One web app, three chains (Solana, Robinhood Chain, Base), eight MVP capabilities:

1. Sign in by connecting a wallet or creating a passkey wallet. A chain is usable once the person has funds on it.
2. Community indexes on a shelf.
3. Personal baskets from a sentence or a short form, every choice explained.
4. One-tap buy across chains, status per leg.
5. Portfolio across chains with drift.
6. One-tap rebalance.
7. Publish and follow, with auto-follow as a per-basket switch.
8. A risk sheet on every asset and basket.

Not built: bridging, shared pools, an adviser view, creator fees, fiat ramps, perps, CCIP sync, Chainlink Automation.

## 2. The pieces

One repository, TypeScript throughout except the two contracts.

| Piece | What it is | Depends on |
|---|---|---|
| `packages/core` | Pure logic, no network: recipe types, flattening, the personalization engine, the rebalance planner, the risk roll-up | nothing |
| `packages/chain-solana` | Solana adapter: holdings, prices, Jupiter quotes, transactions for the vault program | core |
| `packages/chain-evm` | EVM adapter for Base and Robinhood Chain: one codebase, a config per chain | core |
| `programs/basket` | Solana program (Anchor): vaults and the index registry | — |
| `contracts/` | Solidity (Foundry): `BasketVault`, `VaultFactory`, `IndexRegistry`. Same bytecode on both EVM chains | OpenZeppelin Contracts |
| `apps/api` | Backend: database, index metadata, profiles, the goal parser, risk sheet content | core |
| `apps/keeper` | One plain TypeScript worker: finds auto-follow vaults behind a new index version and rebalances them | core, both adapters |
| `packages/sdk`, `apps/mcp` | The agent surface: a typed SDK and an MCP server over the same logic | core, api |
| `apps/web` | The app (Next.js) | core, both adapters, api |
| `content/risk-sheets/` | One file per asset, written by Rodrigo | — |

The rule that makes parallel work possible: `core` knows nothing about chains, and each chain is reached only through the adapter interface in section 4. The web app and the keeper never call a chain directly.

## 3. Data model

**Recipe.** What a basket should hold on one chain.

```ts
type Component =
  | { kind: 'asset'; asset: AssetId; weightBps: number }
  | { kind: 'index'; recipeId: RecipeId; weightBps: number; mode: 'follow' | 'pinned'; pinnedVersion?: number };

type Recipe = {
  id: RecipeId; chain: ChainId; creator: Address;
  version: number; effectiveAt: number;        // unix seconds; trades wait until then
  components: Component[];                      // weights sum to 10_000
  kind: 'community' | 'personal';
};
```

- Community recipes contain assets only. Personal recipes may contain assets and community recipes. That gives nesting exactly one level deep, with no possible loop.
- A multi-chain index is a family: one name and description, one recipe per chain.
- `flatten(recipe)` in `core` multiplies weights through index references, merges duplicates, drops anything under 0.5% or $5, and caps the result at 15 positions. A vault only ever holds the flattened assets.

**Vault.** One per basket per chain, owned by the person's wallet. Stores: owner, the recipe it follows, the recipe version it has accepted, the auto-follow flag, and the running loss budget.

**Units.** Weights in basis points. Amounts in raw token units. Stock tokens carry a dividend multiplier; only the adapters convert between raw and displayed amounts, and the multiplier is applied exactly once.

## 4. The chain adapter

Every chain implements this. Agents building the app and the keeper code against it from day 1, using a mock adapter until the real ones land.

```ts
interface ChainAdapter {
  chain: ChainId;
  listAssets(): Promise<Asset[]>;                               // platform list: address, decimals, class, issuer, feed, liquidity floor
  getPrices(assets: AssetId[]): Promise<Price[]>;               // reference price, age, market open or closed
  getVaults(owner: Address): Promise<VaultState[]>;             // holdings (raw and displayed), value, accepted version
  getWalletHoldings(owner: Address): Promise<Holding[]>;        // for personalization
  quote(trade: Trade): Promise<Quote>;                          // expected output and cost at this size
  buildCreateVault(owner: Address, recipe: Recipe): Promise<Tx[]>;
  buildDeposit(vault: VaultId, cashAmount: bigint): Promise<Tx[]>;
  buildOwnerRebalance(vault: VaultId, trades: Trade[]): Promise<Tx[]>;   // signed by the owner
  buildWithdrawInKind(vault: VaultId): Promise<Tx[]>;
  buildSetAutoFollow(vault: VaultId, on: boolean): Promise<Tx[]>;
  buildPublishRecipe(recipe: Recipe): Promise<Tx[]>;
  buildKeeperLeg(vault: VaultId, trade: Trade): Promise<Tx>;    // signed by the keeper
  track(txId: string): Promise<TxStatus>;
}
```

## 5. The vault rules

Identical on both chain families. This is the security-critical part.

**The owner can always:** deposit cash, rebalance with their own signature and their own slippage setting, switch auto-follow on or off, and withdraw every token in kind. In-kind withdrawal calls no router and cannot be blocked by a pause, the keeper or a price feed.

**The keeper can only call one function, and the vault checks each call:**

1. Auto-follow is on for this vault, and the caller is the keeper.
2. Both tokens are in the recipe version the owner accepted, or the cash token.
3. The output is in the vault afterwards. The vault measures its own balances before and after; it ignores what the router reports.
4. The vault's value after the trade is at least its value before, minus a tolerance, using the reference price feed.
5. The trade moves the vault toward its target weights and not past them.
6. A cooldown between keeper trades, and a cap on cumulative loss over seven days.
7. The price feed is fresh and the market for that asset is open. No keeper trades on stock legs at night, on weekends, or near a multiplier change.
8. A guardian can pause the keeper path. Pausing never affects the owner's functions.

**New recipe versions.** If a new version only changes weights among assets the owner already accepted, an auto-follow vault adopts it after `effectiveAt`. If it adds an asset, the owner has to approve it once.

Starting values, not yet calibrated: tolerance 0.75% on Solana and 1.25% on EVM, loss cap 2% per seven days, cooldown one hour, publish-to-trade delay 12 hours (shorter on a demo index, and labelled as such).

**EVM (`contracts/`).** `VaultFactory` deploys a cheap clone of `BasketVault` per basket. Built on OpenZeppelin Contracts: clones, ownership, reentrancy guard, safe token transfers, pause. Swaps go through an allowlisted router (Uniswap's Universal Router on both chains; 0x where available) with an exact approval that is zeroed afterwards. Reference prices are Chainlink feeds. Cash is USDC on Base and USDG on Robinhood Chain, both 6 decimals; stock tokens are 8 decimals on Base and 18 on Robinhood Chain. On Robinhood Chain only about 36 of 195 stock tokens have a feed, so only those can be in an auto-follow recipe; the rest are owner-signed only.

**Solana (`programs/basket`).** A vault is an account owned by the program, with one token account per asset. Stock tokens are Token-2022 and yield tokens are classic SPL, so all token handling uses the interface that covers both. Swaps call Jupiter from inside the program, passing through the accounts Jupiter supplies; the program checks balances before and after. One swap leg per transaction, so a rebalance is several transactions and the app shows progress per leg; stock-to-stock goes through USDC as two legs. Off-the-shelf smart wallets (Swig, Squads) cannot do checks 3 and 4, which is why this is a custom program.

**Price reference on Solana.** Primary: Kamino Scope's onchain prices for the stock tokens, which are free, need no key, and were 32–44 seconds fresh during the US session (SPYx, QQQx, NVDAx, TSLAx, AAPLx, MSTRx; no gold). Pyth's all-hours token feeds would add gold and weekends but need a paid key ($500 a month after a 14-day trial); the team is staying on free tiers, so they are not used. Gold and weekend changes fall back to the one-tap prompt. Each asset has a source setting, so a second source can be added later; a keeper leg needs the primary under 120 seconds old. Where an asset has no free price source, there are no automatic trades on it and followers get the one-tap prompt.

**Reuse.** The program is custom, but it borrows the math and oracle helper crates from solanabr's Solana Vault Standard (MIT) and follows its naming, and takes the Token-2022 mint check and the client-generation and test tooling from solana-foundation/vault. Neither repo's vault fits as a base: both are pooled, share-token vaults run by an admin.

## 6. The index registry

- Solana: recipe accounts inside the same program.
- EVM: `IndexRegistry`, emitting `RecipePublished(id, version, hash, effectiveAt)`.
- Onchain: creator, version, component list, effective time. Off-chain in the database: name, description, copy, the family that groups per-chain recipes.
- Following is recorded onchain by the vault pointing at a recipe. Follower counts are read from vaults.
- Creator limits, enforced by the registry on every version after the first: platform-listed assets only; one new version per 24 hours; no weight moves more than 10 points; total turnover at most 20% per version and 60% per rolling week; each weight between 2% and 50%; 3 to 12 assets; a 12-hour delay before followers trade. A guardian can veto a pending version.

## 7. Personalization, risk sheets and the goal parser

**Personalization engine (`core`).** Deterministic rules, no model in the numbers.

- Inputs: goal (grow, income, protect), amount, time frame, risk comfort, holdings read from the person's wallets on all three chains, themes (community indexes to start from), country.
- Rules, each of which emits an explanation line when it fires: shift toward dollar yield as the date gets closer; cap any asset and any issuer by risk comfort; reduce what the person already holds; drop assets too costly to exit at this size (using live quotes); drop assets the person's country can't hold; enforce a minimum position size and the 15-position cap.
- Income goals get a verdict: achievable or not at today's rates, the gap, and the ways to close it.
- Output card, after Nexa: money needed today, expected return as a range, total term, cash-flow pattern, when you can get out.
- Acceptance test: three fixed test people must produce three baskets that differ in asset mix and in card shape. This test is written on day 1.

**Goal parser (`apps/api`).** A language model turns one sentence into the typed inputs above and shows them back for confirmation. It also writes the explanation text from the rule outputs. It never produces a weight or a number.

**Risk sheets.** One file per asset with fixed fields: issuer, what backs it, how you exit, issuer powers (pause, freeze, seize), who can hold it, liquidity at $1k, $10k and $50k, price feed, incidents, sources, date reviewed. The roll-up in `core` computes concentration by issuer, chain and asset class, exit cost at the person's size, and a list of flags.

## 8. Wallets, keeper, backend, screens

**Wallets.** Two paths behind one interface: connect an existing wallet (Solana wallet standard; standard EVM connectors), or create a passkey wallet that holds keys for Solana and both EVM chains. Provider: Privy, which covers passkey-only sign-up, Solana and EVM wallets, and custom EVM chains (Robinhood's docs list it for chain 4663); free under 500 monthly users. Fallback: Turnkey. A short spike with a real passkey confirms it once a Privy app exists.

**Keeper (`apps/keeper`).** Watches the registries for new versions. After `effectiveAt`, for each auto-follow vault on that recipe: plan the trades with `core`, fetch a route per leg, and submit. It is one Node process with a reconcile loop and a jobs table in Postgres, one serial submitter per chain, simulating before every send. OpenZeppelin's Relayer was checked and dropped: it cannot build the transaction format the Solana vault needs. Vaults are processed in random order with a small random delay. Results are written to the database so the app can show them. Needs paid RPC endpoints on all three chains; the public Robinhood Chain endpoint rate-limits quickly.

**Backend (`apps/api`).** Postgres. Tables: users, profiles, index families, recipe metadata, vaults (cache of onchain state), rebalance jobs, risk sheets. It caches; the chains are the source of truth.

**Screens.** Shelf; index page with its risk sheet; the fit flow; personal basket card; buy flow with a funding check per chain and a status per leg; portfolio (per chain and combined) with drift; rebalance; publish; basket settings (auto-follow switch, withdraw in kind). An "unaudited" notice and a block for US visitors, since nothing onchain enforces that.

## 8a. Agents

Every write in the adapter already returns unsigned transactions, and the vault enforces the rules, so agents fit without new machinery. One function in `core`, `prepareIntent`, backs four thin faces: a keyless REST API with an OpenAPI description, a typed SDK, an MCP server with about a dozen tools (list indexes, read a risk sheet, build a personal basket from a goal, quote, create a vault, buy, rebalance, publish, follow), and a skill file.

The rule: agents propose and the person signs, through an approval link in the app. The only delegated mode is auto-follow: an agent can publish an index, labelled as agent-run, and follower vaults bound what it can do. Paid endpoints are a later stretch.

## 9. Tests that come before the build

Run on Oct 1–2 with about $10 per chain. Each one can change the design.

| Test | If it fails |
|---|---|
| Solana: a program-owned vault buys the S&P 500 token through Jupiter. Passed on a local copy of mainnet (23 accounts, 83k compute units; the balance check rejected a redirected output). The mainnet run is in `../spikes/solana-vault-swap/README.md` | Rework the swap path before anything else |
| Solana: read Kamino Scope's price for that token from the program and compare with a Jupiter quote | Use Pyth with a key, or keeper trades wait for the one-tap prompt |
| Robinhood Chain: passed on a local fork (vault held the token; a keeper swap passed the checks for about 2 cents of gas). The $10 mainnet script is in `../spikes/evm-vault` | That chain becomes read-only in the app |
| Base: the standard local fork cannot run these tokens; a read-only simulation against mainnet passed (vault bought and withdrew the token). The $10 mainnet script is in `../spikes/evm-vault` | Read-only if the real transfer fails |
| Wallet provider: a Privy passkey wallet signs on Solana and on chain 4663 | Turnkey |
| Three test people through the personalization rules | Strengthen the rules before building screens |

## 10. Workstreams

Day 1 is one stream: freeze section 3 (types), section 4 (adapter), section 5 (vault rules) and the platform asset list, and scaffold the repository with a mock adapter. After that, these run in parallel, one agent each:

| Stream | Delivers | Done when |
|---|---|---|
| A. Core | Flatten, personalization engine, planner, risk roll-up | Unit tests pass, including the three-person test |
| B. Solana program | Vault and registry | Program tests pass; the $10 mainnet script passes; adversarial tests pass |
| C. EVM contracts | Vault, factory, registry, deploy scripts for both chains | Foundry tests pass on a Robinhood Chain fork; adversarial tests pass; deployed on both |
| D. Solana adapter | Implements the interface | Contract tests against the interface pass on mainnet with small amounts |
| E. EVM adapter | Implements the interface for both chains | Same, on both chains |
| F. Keeper | Watcher, planner loop, relayer | An index update rebalances an auto-follow vault on each chain |
| G. Backend | Database, endpoints, goal parser | Endpoint tests pass |
| H. Web app | All screens against the mock adapter, then the real ones | The eight MVP capabilities work end to end |
| I. Risk sheets | Schema, content pipeline, roll-up screens | Sheets for every launch asset render |
| K. Agent surface | REST with an OpenAPI description, typed SDK, MCP server, skill file, approval page | An outside agent builds a basket and a person approves it from a link |
| J. Verification | End-to-end scripts with real money on three chains; a security pass on both vaults | The demo script runs twice in a row without help |

Adversarial tests for streams B and C: the keeper sends output to its own account; trades through a thin pool at a bad price; churns back and forth; trades a token outside the recipe; trades while the feed is stale; and a token sent to the vault must not block withdrawal.

## 11. Timeline

- Oct 1–2: section 9 tests, interfaces frozen, repository scaffolded.
- Oct 2–7: parallel build.
- Oct 8: integration on all three chains.
- Oct 9–10: real-money rehearsals; fix; freeze features on the evening of Oct 9.
- Oct 11: videos.
- Oct 12: submit, with a buffer before the deadline.

## 12. What needs a person

- Wallets funded with small amounts on all three chains, for tests and for the demo.
- Accounts and keys: Pyth, paid RPC endpoints, the wallet provider, a database, hosting.
- Rodrigo: risk sheets for the launch assets, the launch indexes and their copy.
- The question to Colosseum about winning more than one track.
- The name.
- Who holds the upgrade keys for the two vault contracts, stated in the app.
