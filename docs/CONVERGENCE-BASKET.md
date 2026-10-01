# CONVERGENCE: from the structurer to the basket app

*Written 2026-10-01. For Rodrigo and Thom. A proposal: every verdict below is open until Rodrigo agrees.* Read with the audit (`AUDIT-BASKET.md`), the product (`HANDOFF-BASKET.md`) and the design (`DESIGN-BASKET.md`).

## Starting point

The repo is closer to the design than the two documents suggest. `apps/api`, `apps/web`, `packages/chain-solana` and `packages/chain-evm` keep their paths. `packages/engine` becomes `packages/core` with one rename, tried in a scratch copy with typecheck and tests unchanged. `risk-layer` is a fast-forward of `main`, so there is one history. Everything else in the design is additive.

Two things get replaced: custody (a token approval to a server-held key) and the Brazil-specific frame around the engine. The engine, the risk layer, the provenance rules and the execution log stay.

Code builds on upstream `risk-layer` (now `9cb2294`), because the risk sheet needs `packages/risk`. `main` stays frozen for the structurer until Rodrigo says otherwise.

## What happens to each piece

| Piece | Verdict | What changes |
|---|---|---|
| `packages/schemas` | keep | Stays the shared type leaf. Gains `Recipe`, `Component`, `Asset`, `VaultState`, `ChainAdapter`, an address type per chain. Basis points and raw units. Every API response typed |
| `packages/engine` | adapt, as `packages/core` | One mechanical rename. `feeds/` and `parser/llm.ts` move to `apps/api`, so core has no network, env or clock |
| engine `solver/` | adapt | Keep the cap-and-fill waterfall and the reason per leg. Drop the LP: it never beat the greedy fill in 2,358 random cases. Caps per asset, issuer, class and chain; start from index weights, not a yield ranking |
| engine `schedule/` | adapt | Backs the card: cash-flow pattern, return range, verdict with gap. Dollar base, correct compounding, return assumptions per asset class |
| engine `policy/` | adapt | Becomes the planner: basis points, raw units, sell before buy, two legs through cash, executable assets only |
| engine `parser/rules.ts` | adapt | New input schema, negation and amount fixes. Stays as the no-key path and as a cross-check on the model |
| engine `assets/` | adapt | The registry becomes the platform asset list keyed by chain and address. Haircuts stay for dollar-yield legs once Rodrigo supplies his rule set |
| engine BRL parts (FX feed and stresses, reserve table, Portuguese regexes) | park | Isolated behind a goal-currency parameter, not deleted |
| `packages/risk` | keep | Pure maths unchanged; decoders sit with the Solana adapter. Add a chain column; fix audit items 9 and 10 and the thin-regime rule |
| `packages/db` | keep | New tables as an additive migration after `0005`; plan and policy tables stay as history. The seed script moves out |
| chain-solana `jupiter`, `compose`, `simulate`, `rpc`, `explorer` | keep | Add timeout and backoff, a required key, a compute budget from our own simulation |
| chain-solana `sign`, `wallet` | adapt | Become the keeper's submitter and `track()`: rebroadcast, expiry by block height. Server-only entry point |
| chain-solana `positions`, `prices` | rewrite | Holdings over both token programs, multiplier applied once; reference prices from Kamino Scope with age and market state |
| chain-solana `executor`, `rebalance-executor` | replace | Vault transaction builders, one leg at a time, built just before signing |
| chain-solana `delegate` | retire | Keep `buildRevokeUnsigned` as the migration tool, and a program-aware `ata()` |
| chain-solana `kamino`, `brl-leg` | park, retire | Lending deposits do not fit one token account per asset. klend-sdk leaves the runtime path |
| `packages/chain-evm` | replace | The stub becomes the Base and Robinhood Chain adapter |
| `apps/api` | adapt | Auth, CORS allowlist, rate limits, one error handler, one database pool. Plan routes become basket routes. The rebalance trigger goes; `/risk` routes stay |
| `apps/risk-api` | keep | Rodrigo decides whether to fold it in. Its routes move to a package both apps mount |
| `apps/web` | adapt | `GoalFlow` becomes the fit flow, `PlanView` the index page and card, the monitor becomes portfolio, drift and rebalance. `ScheduleChart` and the risk charts stay. `providers.tsx` gives way to Privy. `app/embed` is parked |
| `scripts/`, `fixtures/`, `tests/`, `docs/` | keep | Collectors and launchd jobs untouched before Oct 12. Old docs get a "superseded by" line |
| `programs/basket` | new | Anchor vault and registry, grown from `spikes/solana-vault-swap` |
| `contracts/` | new | Foundry `BasketVault`, `VaultFactory`, `IndexRegistry`, from `spikes/evm-vault` |
| `packages/chain-mock` | new | The mock adapter the web app, keeper and adapter contract tests run against |
| `flatten`, personalization rules, risk roll-up, `prepareIntent` | new | In `packages/core` |
| `apps/keeper` | new | A worker with no inbound HTTP, and a jobs table |
| `packages/sdk`, `apps/mcp` | new | Typed SDK and MCP server; the only packages with a build step |
| `content/risk-sheets/` | new | One file per asset. `issuer-models.json` and the holiday calendar move here from `fixtures/risk` |
| EVM quote collectors | new | Under `scripts/risk/`, writing the same snapshot rows as the Solana collector |

## Target structure

```
apps/        api  web  keeper  mcp  risk-api
packages/    schemas  core  risk  db  chain-solana  chain-evm  chain-mock  sdk
programs/    basket              Anchor; Anchor.toml and Cargo.toml at the root
contracts/   src  test  script   Foundry
content/     risk-sheets
scripts/     verify  risk  execute   unchanged until Oct 12
tests/  fixtures/  spikes/
docs/        HANDOFF-BASKET  DESIGN-BASKET  AUDIT-BASKET  CONVERGENCE-BASKET  research/
             plus the existing uppercase files, kept as history
```

`schemas` is the leaf. `core` and `risk` depend only on it. Adapters depend on `core`. Only `api` and `keeper` touch the database. `web` and `keeper` reach a chain only through an adapter.

## Decisions for Rodrigo

- [ ] **Custody.** A program-owned vault per basket per chain replaces the token approval. For: the rules hold if the server is compromised, and stocks can rebalance without a signature each time. Against: two unaudited contracts with upgrade keys, built in eleven days, where today the tokens never leave the wallet. He ruled out a custom program on time; the spike behind the new estimate passed locally, not yet on mainnet.
- [ ] **Brazil-specific logic.** Goals and the card in dollars; the reais schedule, BRL leg, FX stresses and the G-NORA gate parked behind a currency parameter. For: one global product, and the BRL leg cannot execute today. Against: goals in reais are his differentiator and his partners' frame. Middle path: a BRL stable as one shelf asset if G-NORA passes by Oct 6.
- [ ] **Stocks.** From "high-risk only, at most 35%, zero expected return" to the core of the shelf. That needs a return range per asset class, a view the engine has so far declined to state. His rule keeping xStocks out of income profiles should survive as "no stocks in the income share".
- [ ] **Chains.** Three from day one, against Solana only. For: partner pilots may land on an EVM chain (gate EVM-S1), and one adapter interface contains the cost. Against: three mainnet rehearsals, and risk data that is Solana only, so sheets on the other two are thinner. A chain that fails its test becomes read-only.
- [ ] **Audience.** Direct to a person, with community indexes, against the partner embed. Indexes give a reason to return and something to share; they also sit uneasily with a brand that argues against menu baskets. One framing holds both: indexes are pre-cut pieces and the personal basket is assembled from them. The embed is parked, not removed.
- [ ] **Sign-in.** Privy (connect or passkey) against wallet-adapter only. It reaches people without a wallet and covers three chains; it adds a vendor and a free-tier ceiling. The API needs auth either way.
- [ ] **Units.** Basis points and raw token amounts replace float weights and dollar floats. Every weight assertion and money column changes. In return, weights sum to exactly 10,000 and an 18-decimal token can be stored.
- [ ] **Process.** Parallel streams against frozen interfaces, beside his slot plan. His rules stay: provenance, MOCK labels, deterministic engine, explorer links, no advice claim. Three lines change: `CLAUDE.md` points at the new spec, "never auto-retry" allows a retry the person starts, and commit prefixes gain an area form (`core:`, `vault:`) next to slot ids.
- [ ] **The `risk-layer` branch.** His rule keeps it out of `main` until after Oct 12, but the risk sheet is that work. Proposal: basket code sits on top of `risk-layer` and one branch becomes the submission. Merging turns the liquidity provider on wherever curves exist, which can change the high-risk demo plan; `RISK_LIQUIDITY=off` restores the old output.
- [ ] **Smaller ones.** A licence (MIT matches the code we borrow). The `engine` to `core` rename while he is still committing to engine files. Where the risk data runs for the demo. Revoking the two live approvals before the audit is public. The name, which also decides the `@colosseum/` scope.

## Pull requests

CI has never passed, so "green" starts with PR 1. PR 2 onward target a `basket` branch cut from `risk-layer`, which merges to `main` once, when Rodrigo lifts the freeze. Before every merge: `pnpm typecheck && pnpm lint && pnpm test` locally and a green run on GitHub. PRs 5 to 11 can run in parallel once PR 4 lands.

| PR | Scope | Files | True before it merges |
|---|---|---|---|
| 1. `basket-design` into `main`, draft | Documents and structure only, in his naming. The proposal, the design, the research, the audit, this blueprint, proposed rows in `GATES.md`, and one `chore:` commit for the CI setup step. "Superseded by" lines on the older docs and a closing `STATE:` entry follow once Rodrigo agrees | `docs/HANDOFF-BASKET.md`, `DESIGN-BASKET.md`, `AUDIT-BASKET.md`, `CONVERGENCE-BASKET.md`, `docs/research/`, `README.md`, `docs/PRIOR-WORK.md`, `docs/GATES.md`, `spikes/` source, `.github/workflows/ci.yml` | Rodrigo has read the checklist. No file under `apps/` or `packages/` changes. The first green run exists |
| 2. `chore:` checks | Every check runs and passes | `ci.yml` (Postgres service, migrate, build, root `tsc`), two heatmap keys, five `allowBuilds` lines, 11 type errors, `next-env.d.ts` untracked, ignore entries for build output, `undici` override, `dev` naming api and web, a test database URL | 146 tests pass on Linux. No behaviour change |
| 3. `core:` rename and purity | `engine` to `core`; feeds and the model call to `apps/api`; seed out of `db`; alias blocks removed; `now` a required input | about 30 non-doc files, the boundary test | The engine snapshot baseline is byte-identical. Rodrigo has no unmerged engine work |
| 4. `types:` interfaces | Section 3 types, `ChainAdapter`, mock adapter, new tables | `packages/schemas`, `packages/chain-mock`, `packages/db` | Both have agreed the types. Migrations have one owner |
| 5. `core:` basket logic | Flatten, personalization rules, planner, roll-up, parser fixes, verdict | `packages/core`, `fixtures/` | Three test people give three different baskets. Weights sum to 10,000. The planner is tested with a non-executable leg |
| 6. `vault:` Solana | Program, then adapter | `programs/basket`, `packages/chain-solana` | Adversarial tests pass. The $10 mainnet run is recorded in `STATE`. `delegate.ts` is out of the runtime path |
| 7. `vault:` EVM | Contracts and adapter | `contracts/`, `packages/chain-evm` | Fork and adversarial tests pass. Deployed on both chains |
| 8. `api:` and keeper | Auth, limits, typed routes, a per-leg log with guarded status changes; the keeper worker | `apps/api`, `apps/keeper` | Handler tests run on a test database. No HTTP request can make a server-held key sign |
| 9. `risk:` sheet | Audit fixes, chain column, a route for three sizes, content files, a dated dataset | `packages/risk`, `content/risk-sheets/`, `scripts/risk/` | A sheet renders for every launch asset from the repo alone |
| 10. `web:` screens | Privy, shelf, fit flow, card, buy flow, portfolio, publish, settings | `apps/web` | The MVP flows run against the mock adapter, then the real ones |
| 11. `agents:` | SDK, MCP server, skill file, approval page | `packages/sdk`, `apps/mcp` | An outside agent builds a basket and a person approves it from a link |

## What the design should change

Already solved in this repo, so reuse it:

- The parser contract, the reason per leg, the provenance columns and one log row per transaction.
- Market regimes and the holiday calendar (`packages/risk/src/time.ts`) serve the keeper's market-open rule and `getPrices`.
- Exit cost by size: the curves hold $10k and $50k as measured points and give $1k by interpolation. Adding a grid point blanks every curve above it until it has samples.
- The three-goals test exists (`tests/solver.test.ts:72`). Extend it to card shape.

Proved wrong, or missing:

- "Core depends on nothing" costs 46 import rewrites. Keep `schemas` as the leaf.
- A program-owned account as Jupiter's `userPublicKey` always fails Jupiter's own pre-simulation and gets a 1.4M compute-unit limit, so the adapter sets the compute budget itself. Keyless Jupiter allows about four calls per burst, so the key is required.
- Legs cannot share one blockhash. Build each leg just before it is signed and confirm by block height.
- The browser cannot send through the public Solana RPC. Signed transactions go through the backend or the wallet provider.
- The dividend multiplier is a schedule (current, next, effective time), and a per-share reference price differs from a per-raw-unit quote by it. SPYx's transfer hook is unset today while permanent delegate, pause and freeze are live; that belongs on the risk sheet.
- Risk-sheet liquidity needs two numbers. At $1k to $50k most Jupiter flow went through a venue the layer does not decode, so show "quoted now" beside "on the pools we can read".
- The verdict is specified for income goals only. Balance goals need it too.
- "Expected return as a range" has no input today: stocks are modelled at zero and yield rankings flip day to day. The design needs assumptions per asset class and a minimum gap before one leg displaces another.
- The keyless agent API is safe only if no HTTP request can make a server-held key sign, and personal data still needs auth and rate limits. An agent skips the person's review of the parsed form, so the parser has to fail closed on anything ambiguous.
- Keeper jobs need a unique key per vault, version and leg, with `confirmed` set only from `track()`. Chain is text with a check constraint, not a Postgres enum.
- Dollar-yield legs in a vault are yield-bearing tokens, not lending deposits. Whether Kamino Scope prices USDY and syrupUSDC is unchecked.
- Section 12 lists Pyth and paid RPC against the free-tier decision, and omits the licence and where the risk data runs.
- Pick one Solana client before the adapter stream starts: the packages use `@solana/kit` 2.3 (pinned by klend-sdk), the web uses web3.js v1, the spike uses Anchor's client.
