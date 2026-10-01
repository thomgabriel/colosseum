# HANDOFF: Basket app (proposal)

*Written 2026-10-01 by Thom. Companion to `HANDOFF-IDEA1.md` (the structurer) and `HANDOFF-RISK.md` (the liquidity and risk layer). This is a proposal for where the product goes next; nothing here is decided until Rodrigo agrees. Technical design: `DESIGN-BASKET.md`. How it maps onto the code in this repo: `CONVERGENCE-BASKET.md`. Review of the current code: `AUDIT-BASKET.md`. Research behind it: `research/`.*

Working name not chosen.

Position so far (Thom's side):

- Team: Thom and Rodrigo.
- Two parts: community indexes, and personal baskets built by hyperpersonalization.
- No adviser view.
- Solana, Robinhood Chain and Base, all three from day one.
- Sign-in by connecting a wallet or creating a passkey wallet. The person funds each chain they want to use; no bridging inside the app.
- Built in parallel by many Claude agents from one clear design.
- A risk sheet on every asset and basket is part of the MVP.

## The product

An app where you hold baskets of different assets (stocks, gold, dollar yield, crypto) across Solana, Robinhood Chain and Base, bought in one tap and kept in balance.

**Community indexes.** Public baskets created by the community, in the spirit of Cesto: a name, a point of view, what's inside, who made it and how many follow it. Anyone can publish one. Followers hold the same assets in their own wallets, and when the creator updates the index, followers are prompted to rebalance.

**Personal baskets.** A basket built for one person. You say what you want in a sentence or a short form, connect your wallets, and the app builds a basket that fits you and explains every choice. You can also take any community index and have it fitted to you.

## What a person does

1. **Browse the community indexes.**
2. **Follow one as is, or fit it:** answer a few things or type one sentence (goal, how much, for how long, how much risk), and connect your wallets so the app sees what you already hold.
3. **See your version,** with a line explaining each change ("less Nvidia because you already hold $4k of it", "20% in dollar yield because you need the money in 18 months").
4. **Buy in one tap.** The app places the trades on each chain and the assets land in your own wallets.
5. **Stay in balance.** The app shows drift and what a rebalance would trade. You approve with one tap.
6. **Publish** your basket as a community index for others to follow.

## Hyperpersonalization: what changes the basket

Each input has to change the basket visibly. If it doesn't, it's a template.

| Input | What it changes |
|---|---|
| Goal: grow, earn income, or protect | The mix between stocks, dollar yield and gold, and what the main chart shows |
| Amount | Which assets are allowed (some are too illiquid at larger sizes) |
| Time frame | How much sits in dollar yield, and how it shifts as the date gets closer |
| Risk comfort | Caps per asset and per issuer |
| What you already hold | The basket fills gaps and avoids doubling up |
| Themes you believe in | Which community indexes it starts from |
| Where you live | Which assets you can legally hold |

When a goal can't be met at today's rates, the app says so and shows the gap and the ways to close it. It never pretends a goal works.

## What to take from Nexa

Nexa Finance does hyperpersonalized investments in Brazil, off-chain. Three things carry over:

1. **The input.** One sentence about the goal. Nexa turns it into criteria for risk, term, cash flow and liquidity; so does this app.
2. **The output.** Nexa's product page shows five things: money needed today, expected return, total term, cash-flow pattern, and when you can get out. A personal basket's card should show the same five, so two people's baskets look different at a glance.
3. **The line.** "A product built for one client used to need R$10 million. Now it starts at R$100." That is the clearest way to explain hyperpersonalization in one line.

Nexa's own shelf is Brazilian credit; it lists the S&P 500, gold and US Treasuries as planned, not live. This app's shelf is those global assets, onchain, in the person's own wallet.

## Vaults

Decided from the research in `research/vaults/decision-memo.md`:

- **Your own vault per basket, per chain.** Only you can deposit or withdraw. A community index is a public, versioned recipe that follower vaults copy. There are no shared pools.
- **Baskets inside baskets, one level deep.** A personal basket can point at community indexes; the vault holds only the underlying assets. Community indexes hold assets only, so loops are impossible. Each index lives on one chain; a multi-chain index is a set of per-chain recipes under one name.
- **The vault checks every automatic trade itself:** only assets in the recipe, what was bought must land back in the vault, the price must be close to a reference price, losses are capped per week, and you can always switch auto-follow off and withdraw your tokens directly.
- **The vault is our own small contract:** one program on Solana and one Solidity contract shared by Base and Robinhood Chain, built on OpenZeppelin's audited contract library where possible. Both are unaudited, and the app says so. There is no deposit cap.
- **The keeper** that triggers automatic rebalances is a small service the team runs. Because the vault checks every trade, the keeper does not have to be trusted.

## Chains and assets

| Chain | What it brings |
|---|---|
| Solana | Stock tokens (S&P 500, Nasdaq-100, Nvidia, Tesla), gold, dollar yield at 4–5% |
| Robinhood Chain | 195 stock tokens, bought with the USDG stablecoin on Uniswap and 1inch |
| Base | 10 Coinbase stock tokens (Nvidia, Apple, Meta, Google, Amazon, Microsoft, Tesla, SpaceX and two more), dollar yield |

Checked on Solana (Oct 1): baskets of $1k–$50k trade at low cost in the main stock tokens (about 0.07% for a $50k S&P 500 leg). Gold only works up to about $10k per basket. Details in `research/solana-liquidity.md`.

Not yet checked: liquidity on Robinhood Chain and Base, and whether a normal wallet in Brazil can hold their stock tokens. Stock tokens on both exist on mainnet only, so development and tests use a few real dollars.

## How it is not Cesto

| | Cesto | This app |
|---|---|---|
| Chains | Solana | Solana, Robinhood Chain, Base |
| Public baskets | Pre-made themes plus custom | Community indexes anyone can publish and follow |
| Personal | Same basket for everyone | A basket built for each person, every choice explained |
| Rebalancing | Opt-in, when the curator publishes a new version | On drift, and when a followed index changes |
| Risk | A one-year backtest | A sourced risk sheet per asset, rolled up for every basket |

Robinhood Chain already has four index products and its official example app is a basket factory, so there the personal baskets and the cross-chain part are what stand out.

## Tracks

Solana and Superteam Brasil, as in the current README. Robinhood Chain and Base as well if one project may enter more than one ecosystem track; that question is already open in `GATES.md`.

## The MVP submission

What Colosseum's form needs: a live app, a public GitHub repo, a 2–3 minute pitch video, a technical demo video of 3 minutes or less, team backgrounds, the chains and tools used, a go-to-market plan, and disclosure of prior work.

What must work live on mainnet, with real small amounts. These nine things are the MVP:

1. **Sign in two ways.** Connect your own wallet, or create a new wallet with just a passkey (no seed phrase) that works on Solana, Robinhood Chain and Base.
   - A chain becomes usable once you have funds on it: the app shows what each chain needs, and creates your vault there when the money arrives. The app does not bridge for you.
2. **Community indexes.** At least 6 on the shelf with real assets, at least 2 spanning more than one chain.
3. **Personal basket.** A sentence or a short form produces a basket with a line explaining each choice. Three test profiles must give three visibly different baskets.
4. **One-tap buy.** One confirmation places real swaps on all three chains, with a status per leg and a retry if one fails.
5. **Portfolio.** Holdings read across the three chains, valued correctly (stock tokens carry dividend multipliers), with drift from target.
6. **Rebalance.** One tap trades back to target on every chain.
7. **Publish and follow.** Publish an index with its version recorded onchain, follow it from a second account, update it, and the follower is prompted to rebalance.
   - **Auto-follow** is a switch per basket, off by default: when the followed index changes, the vault rebalances with no action from the follower. It is part of the MVP and goes live on each chain once that chain's price-check test passes, Solana first.
8. **Risk sheet.** Every asset has a short, sourced sheet: who issues it, what backs it, how you get out, what could go wrong. Every community index and personal basket shows the roll-up: what it holds, where the risk concentrates, and what it costs to exit at your size. The exit cost comes from the liquidity and risk layer (`packages/risk`); the per-asset content follows the existing risk-sheet rules; the app computes the roll-up.
9. **Built for agents.** An API, an SDK, an MCP server and a skill file over the same logic. Agents propose and the person approves from a link; an agent can also publish an index that others follow.

After the MVP, in this order:

- Community and gamification: creator profiles, follower counts and rankings, badges, creator fees.
- Publish an index once and sync it to all three chains with Chainlink CCIP.
- A "protected" basket type with a floor on your principal at a chosen date.

Out: an adviser view, fiat on-ramps, tax, perps or leverage, Brazilian credit assets.

## The 3-minute demo

1. **Three people, three baskets (60s).** Three people type three goals. Three visibly different personal baskets appear, each choice explained.
2. **One tap, three chains (40s).** One of them buys. Legs settle on Solana, Robinhood Chain and Base, and the assets sit in their own wallets.
3. **The community shelf (35s).** Browse the indexes, follow one, then fit it to yourself and watch it change.
4. **It stays in balance (25s).** A creator updates an index and a follower rebalances with one tap.
5. **Why us (20s).** Thom and Rodrigo built a tokenized-credit platform together. Nexa proved people want products built for them; this does it on public rails with global assets.

## How it gets built

- Day 1: freeze the interfaces: the basket format, the personalization rules, and one chain-adapter contract every chain implements (read holdings, quote, build trades, track them).
- Days 2–6: parallel build, one Claude per piece: Solana adapter, EVM adapter (Base and Robinhood Chain share it), personalization engine, onchain index registry, backend, the app screens.
- Day 7: integration.
- Days 8–9: real-money rehearsals on all three chains.
- Days 10–11: videos and submission.

What agents can't do, and what therefore sets the pace: funding and testing real wallets on mainnet, recording the videos, and deciding the name and voice.

## Tests for the first two days

1. Solana: buy and sell $10 of an S&P 500 token and a dollar-yield token from the wallet type the app will use.
2. Robinhood Chain and Base: buy $10 of a stock token on each from a normal wallet, and measure what $1k and $10k would cost. If a chain refuses the wallet or is too thin, it shows read-only.
3. Build personal baskets for three made-up people with the real rules. If the three look alike, the inputs need more teeth before anything else gets built.

## Risks

- **"Cesto with more chains."** The personal basket has to be obvious in the first minute of the demo.
- **Building a basket for one person can count as investment advice.** Keep it as software the person controls and show the reasoning for every choice.
- **Stock tokens can be paused or frozen by their issuers** and exclude US persons. Eligibility for a wallet in Brazil on the two EVM chains is unconfirmed.

## Decided on Oct 1 (second pass)

- The app is not for US persons, and the terms say so. There is no location block and no banner.
- When a creator adds a new asset to an index, each follower approves it with a tap.
- An index update takes effect for followers 12 hours after it is published.
- On Robinhood Chain, only the stock tokens with a price feed (about 36 of 195) can be in an auto-follow index. The rest are one-tap only.
- The team holds the upgrade keys for the vault contracts for now, one disclosed key per chain, and the app says so.
- Prior work will be disclosed in the submission.
- Launch shelf direction: the S&P 500 or another big index, a few themes in the spirit of Cesto's, and indexes that are only possible with Base's and Robinhood Chain's stock tokens. (A Solana meme index was in this list; it was dropped from the MVP on the fourth pass.)

## Approved on Oct 1 (third pass)

Details in `research/open-questions/`.

- **Free tiers only.** No paid data plans. On Solana the price reference is Kamino's free onchain prices, so automatic rebalances cover the main stock tokens during US market hours; gold and weekend changes get the one-tap prompt.
- **Name:** not chosen. Candidates are shared privately and go into the brand strategy phase.
- **Launch shelf:** The 500 (Solana, Robinhood Chain), The Seven (all three chains), Chips & Agents (Base only), Sand to Server (Robinhood Chain only), Storm Cellar (Solana, Robinhood Chain), and two optional ones, Crypto in a Suit and Home Team. Names, copy and weights are drafts. The meme index (Trench Survivors) is researched but not in the MVP.
- **Creator limits:** no weight moves more than 10 points per update; at most 20% turnover per update and 60% per week; one update per 24 hours; each weight between 2% and 50%; 3 to 12 assets.
- **Wallets:** Privy for sign-in (connect a wallet or create one with a passkey), Turnkey as fallback.

## Decided on Oct 1 (fourth pass, after Rodrigo's status)

- Vaults stay: one vault per basket per chain, in place of the token approval to a server key in Rodrigo's build.
- Community indexes stay. The MVP shelf is serious assets only: no meme index.
- The work lands on a new branch in this repo, with a pull request to `main`.
- Thom and Rodrigo are both on the team, in the prior-work note and in the registration.
- Rodrigo's structurer is the personal-basket engine and his liquidity and risk layer is the source for the risk sheet. See `CONVERGENCE-BASKET.md`.

## Still open

1. Pick the name.
2. Run the $10 mainnet tests on the three chains (`../spikes/`), and create the Privy app.
3. Whether one project can win more than one track (open in `GATES.md`).
4. The README describes the earlier idea. Update it once the direction is agreed.
5. Where the risk data runs for the demo: a hosted collector or a dated snapshot. Rodrigo's collectors run on his Mac on a free RPC week.
