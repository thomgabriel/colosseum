# Nested baskets and legal framing (2026-10-01)

Read-only research. Not legal advice; it is a map of where the lines are so the demo doesn't cross them by accident and the pitch can name the licensed partners a real launch needs. Tags: [primary] = read in the source document today, [search] = search-result summary of the source, not opened, [memory] = not checked today, [inference] = our reasoning.

## TL;DR

- Everyone who nests a basket picks one of two models. Hold the inner product's token (Set v1, Index Coop BED holding DPI, fund-of-funds) or look through to the underlying (M1 pies). Holding the token stacks fees and makes the outer product depend on the inner one staying alive. Look-through costs more positions and more trades but has no fee-on-fee and no wrapper risk.
- Our vaults hold only underlying assets, so nesting is a compile step, not an on-chain feature: resolve references, multiply weights down each path, merge duplicates, apply the user's limits, hand the keeper one flat target. No contract work on any chain.
- MVP rule: two tiers. Community indexes contain assets only. Personal baskets may reference community indexes. That removes cycles by construction and is the same answer regulators reached for funds (SEC three-tier ban, UCITS 10% cascade rule).
- Legally, own vaults remove the "fund" problem and leave the "manager" problem. ESMA, the FCA and (for crypto) ESMA's MiCA Q&A all say the same thing: if trades execute automatically with no client action per trade, it is portfolio management, and ESMA names "auto-follow" buttons as the mandate. Client-set limits and a veto window don't change that.
- Separate accounts that all follow one model are not automatically safe in the US either. Rule 3a-4 exists because identical model-managed accounts can be a de facto investment company; the safe harbor turns on individual restrictions, direct ownership and the right to withdraw. Our per-vault limits and exclusions are the features that matter here.
- A creator fee is the trigger in Brazil (CVM: habitual + paid copy trade = securities analysis, credential required) and the conflict in the EU (payments to copied traders can be inducements). Demo without live creator fees.
- The personal basket is its own legal problem. A basket built from someone's goal, horizon and risk is a personal recommendation. Call it a tool the user drives, and name an adviser partner for launch.

---

## Part 1. Nested baskets

### 1.1 How others do it

| Product | What the outer basket holds | Weights | Updates | Fees | Limits |
|---|---|---|---|---|---|
| M1 Finance pies | Look-through. A slice can be a stock, ETF or another pie; the account holds the underlying securities | Each pie sums to 100%; effective weight is the product down the tree | Editing a custom pie "will update everywhere that Pie is used"; deposits, withdrawals and rebalancing "flow through your Pie structure" | No pie-level fee | 100 slices per pie, about 500 positions per portfolio [search]; no documented depth limit |
| Set Protocol v1 | Inner token. A Rebalancing Set is composed of a single base Set | Outer holds units of base Set; base Set holds components | Rebalance swaps one base Set for another by auction | Per layer | Issuance is two steps: mint the base Set from components, then mint the outer Set from it |
| Index Coop BED | Inner token. BED = BTC, ETH and DPI in equal weights; it holds the DPI token, not DPI's constituents | 1/3 each at the outer layer; DPI's own methodology inside | Each layer rebalances on its own schedule | Stacked: BED 0.25% streaming plus DPI 0.95% [search] on the DPI third, about 0.57%/yr all-in | Both BED and DPI now sit under "legacy products" in Index Coop's docs |
| Reserve Index DTFs (Folio) | Any ERC-20, so a DTF share can technically be a component [inference]; docs are silent on nesting and describe no look-through | Governance-set basket | Dutch auctions swap surplus for deficit tokens | TVL fee plus mint fee per DTF; a nested DTF would stack them [inference] | Up to about 50 tokens on Ethereum, 100 on Base [search] |
| US fund of funds (Rule 12d1-4) | Inner fund's shares | NAV-based | Independent per fund | Adviser must evaluate complexity and aggregate fees and find they are not duplicative | Three-tier structures generally prohibited; acquired fund may put up to 10% in other funds |
| UCITS fund of funds | Inner fund's units | NAV-based | Independent per fund | No entry/exit fees on same-manager funds; prospectus must disclose max management fees at both levels | Target fund may hold at most 10% in other funds (anti-cascade); max 10% (up to 20%) in any one fund |

Sources: M1 help [primary] https://help.m1.com/en/articles/9332122-creating-and-adding-custom-pies-to-your-m1-portfolio ; M1 limits [search] https://quantroutine.com/brokers/m1-finance/ ; Set v1 wiki [search] https://github-wiki-see.page/m/SetProtocol/set-protocol-contracts/wiki/Rebalancing-Set-Issuance-Details ; BED [primary] https://docs.indexcoop.com/index-coop-community-handbook/products/legacy-products/bankless-bed-index-bed ; DPI fee [search] https://docs.indexcoop.com/index-coop-community-handbook/products/legacy-products/defi-pulse-index-dpi ; Reserve [primary] https://docs.reserve.org/core-components/index-dtfs/overview and [search] https://metalamp.io/magazine/article/reserve-finance ; SEC 12d1-4 [search] https://www.sec.gov/newsroom/press-releases/2020-247 ; UCITS Art. 50 and 55 [search] https://www.esma.europa.eu/publications-and-data/interactive-single-rulebook/ucits/article-50 , https://www.esma.europa.eu/publications-and-data/interactive-single-rulebook/ucits/article-55

Not verified: whether M1 has a hard nesting depth (the help page says only "no strict limit to the number of custom Pies"); whether any live Reserve DTF holds another DTF.

### 1.2 What breaks in each model

Holding the inner token:
- Fee on fee. BED holders paid both streaming fees. Fund law treats this as the central harm (duplicative-fee finding in the US, both-level fee disclosure in UCITS).
- Wrapper dependency. The outer product needs the inner token to stay mintable, redeemable and liquid. When the inner product is retired the outer one is stranded.
- Multi-step issuance. Set v1 needed the base Set minted before the outer Set, so every entry and exit pays twice in gas and slippage.
- Opaque exposure. The outer layer doesn't see overlap (ETH held directly and again inside an inner index).
- Not available to us anyway: there is no basket token in an own-vault design.

Look-through (our model):
- Position count grows multiplicatively. M1 caps at 100 slices and about 500 positions for this reason.
- Dust. A 2% slice of a 20% sleeve is 0.4% of the vault; on a $500 basket that is a $2 swap that costs more than it is worth.
- Thundering herd. One child update produces trades in every parent vault at once. GLDx has $0.88M of DEX liquidity and costs 10.7 bps at $10k (solana-liquidity.md), so many vaults rebalancing in the same minute move the price against the last ones.
- No sleeve accounting. SPYx held directly and SPYx held via an index are the same tokens in the same account. Sleeves are targets, not sub-accounts, so "performance of the nested index inside my basket" is a computed number, not a balance.
- A child edit is now a trade instruction for strangers' vaults. Nesting widens the blast radius of a creator who front-runs their own update.

### 1.3 Recommended rule set (recipes; vaults hold only underlying)

Data model
1. A recipe component is either an asset `{chain, token, weight}` or a reference `{recipeId, weight, mode}` where mode is `follow` (track new versions) or `pinned@version`.
2. Every publish creates an immutable version (content hash). Nothing is edited in place and nothing is deleted. A creator can retire an index; parents then freeze on the last version and the user is told.

Tiers and cycles
3. Two tiers for the MVP. Community indexes contain assets only. Personal baskets may reference community indexes and assets. Depth is 1, cycles are impossible, and no graph check is needed.
4. If index-of-index is added later: give each recipe a tier number and allow references only to a strictly lower tier, max depth 3. A plain cycle check at publish time is not enough, because with `follow` references a later edit to a child can close a loop that didn't exist when the parent was published.

Flattening
5. Effective weight of an asset = sum over all paths of the product of weights on the path. Merge duplicates. Example: personal = 50% Index A, 30% SPYx, 20% jlUSDC; Index A = 40% NVDAx, 30% SPYx, 30% GLDx. Flat target = SPYx 45%, NVDAx 20%, jlUSDC 20%, GLDx 15%.
6. Work in value terms (USD), not token units. xStocks carry a scaled-UI multiplier and Robinhood tokens an ERC-8056 multiplier; convert at the end.
7. Use at least 1e6 precision for the products and round with largest-remainder so the vector sums to exactly 100%.
8. Keep provenance per leaf: `{asset, weight, sources:[{recipeId, version, share}]}`. The UI needs it ("45% SPYx: 30% direct, 15% via Index A") and fees need it.

User overrides (applied after flattening, and they always win)
9. Eligibility filter per user and chain. An ineligible leaf is dropped and the sleeve renormalised, with a visible notice. Refuse the reference if more than a set share (say 25%) of the index is ineligible.
10. Exclusions and caps: assets the user never wants, max weight per asset. If a cap binds, redistribute pro rata across the rest.
11. Minimum position: drop leaves below a floor (0.5% or $5) and renormalise; cap flattened positions per vault (about 15 to 20) so a rebalance fits in a few transactions.

Chains
12. A vault is one chain. A reference resolves only against the index's components on that chain. MVP: an index is published per chain and can be nested only into a basket on the same chain. A cross-chain equivalence table (SPYx on Solana, SPY token on Robinhood Chain) is a later feature.

Cascade
13. When a child publishes a new version, recompute the flat target for every vault that follows it and diff against current holdings. One net rebalance per vault. Never trade layer by layer.
14. The update applies automatically only if the vault has auto-follow on and the diff passes the vault's own guardrails: assets already approved, turnover per update under a cap, per-asset weight cap, price check against a reference, slippage cap, cooldown. Otherwise it waits for the user.
15. New assets are the hard case. Changing weights among already-approved assets can be automatic. An asset the vault has never held needs either a fresh user approval or membership in a platform-vetted list the user opted into. On Solana this is mechanical: Swig roles cap spend per mint, so a new mint needs a role update the user signs.
16. Delay and stagger. A new version becomes actionable by keepers after a delay (for example 1 hour) and vaults are processed in randomised batches with a per-batch price-impact cap. Limit creators to one version per day and cap turnover per version.
17. Drift band: skip any leg under 1% of vault value or $5.

Fees
18. One platform fee per vault. A creator fee accrues only on that creator's sleeve (weight share times vault value). No fee on fee. Show one all-in cost number, the way funds show acquired-fund fees.

What to say about it
19. "Your basket includes the AI Leaders index at 30%. We hold its tokens directly in your vault; when its author updates it, your target updates too." The user never holds an index token because none exists.

### 1.4 What this means for the build

Nesting is an off-chain pure function `flatten(recipe, versions, userConstraints, chain) -> target[]` plus a provenance record. It can be unit-tested in isolation and is identical for Solana, Base and Robinhood Chain. The keeper and the vault never learn that nesting exists. That makes depth-1 nesting a one-day item, not a per-chain feature.

---

## Part 2. Legal framing

### 2.1 The test regulators use for automatic copying

EU, ESMA supervisory briefing on copy trading (ESMA35-42-1428, 30 March 2023, non-binding) [primary]:
- Automatic execution with no client action per trade is portfolio management (paras 12, 28, 36). If the client must act before each transaction it can be investment advice or order transmission/execution instead (para 29).
- Footnote 22: "'autocopy' or 'auto-follow' online buttons ... effectively are the mandates to the firm".
- A veto window doesn't help: if the trade executes once a time limit passes, client intervention isn't necessary, so it is portfolio management. Client-set limits (leverage, stop-loss, closing positions) don't change it either (para 33). "An ex-ante bulk approval (a blank check) or stop loss limit orders are not considered interventions on a transaction basis."
- A single firm with a direct link to copied traders is "highly unlikely" to be execution-only (para 31).
- Trades shared on social media and then copied manually can still be investment advice by the person sharing (para 30).
- Copied traders: the firm must ensure knowledge, competence, minimum experience and honest conduct (paras 71 to 72); they may count as "experts" under market-abuse rules with conflict-of-interest disclosure duties (para 74).
- Payments to copied traders: may be remuneration or inducements; commission-based systems get specific attention under Art. 24(8) and 24(9) MiFID II (paras 63 to 68).
- Marketing: fair, clear, not misleading; past performance must not be the most prominent element and should cover 5 years or complete 12-month periods; future-performance information must not be based on simulated past performance (section 2.3.1).
https://www.esma.europa.eu/sites/default/files/2023-03/ESMA35-42-1428_Supervisory_Briefing_on_Copy_Trading.pdf

EU, crypto-assets: ESMA_QA_2463 (answered 7 April 2025) applies the same analysis under MiCA, case by case, pointing to the 2012 Q&A and sections 2.1 and 2.2 of the briefing [primary]. So crypto-only baskets fall under MiCA (portfolio management of crypto-assets) and tokenized stocks under MiFID II. https://www.esma.europa.eu/publications-data/questions-answers/2463

UK, FCA "Copy trading" page (first published 12 May 2015, last updated 27 July 2026) [primary]: automated copy trading is portfolio management and needs that authorisation, with suitability, conduct and periodic-reporting duties. "Where no automatic order execution occurs because client action is required before executing each transaction, the activity will not amount to portfolio management." https://www.fca.org.uk/firms/copy-trading

Brazil, CVM Ofício-Circular nº 3/2025/CVM/SIN (1 July 2025) [primary]:
- Copytrade replicates a trader's operations automatically in the follower's own account. When offered commercially it is an implicit investment recommendation.
- Habitual activity plus any remuneration tied to the strategy (joining fee, monthly, annual) is professional securities analysis and needs prior credentialing as Analista de Valores Mobiliários (APIMEC, Resolução CVM 20/2021).
- Platforms should ensure every copied trader is a credentialed analyst.
- The copied analyst's own operations must run "exclusivamente em ambiente simulador" because of the analyst trading blackout in art. 13, III and IV.
- Risk warnings must be prominent; past returns don't indicate future returns. Non-compliance "pode acarretar sanções".
- The circular does not address portfolio management. Separately, Resolução CVM 21 reserves professional portfolio administration to CVM-authorised persons [search], so a keeper trading a Brazilian's securities at a third party's direction plausibly lands there [inference].
- Scope is valores mobiliários. Tokenized stocks are securities; SOL or BTC are not, and fall under the BCB VASP regime [memory, see pain-points/brazil-edge.md].
https://conteudo.cvm.gov.br/export/sites/cvm/legislacao/oficios-circulares/sin/anexos/oc-sin-0325.pdf

US, SEC:
- An investment adviser is someone in the business of advising others on securities for compensation. The publisher's exclusion (Lowe v. SEC, 1985) covers impersonal, bona fide publications of general and regular circulation; it does not cover advice attuned to a specific portfolio or client [search]. https://supreme.justia.com/cases/federal/us/472/181/
- A published recipe with no execution authority sits near the publisher side. Automatic trading in the user's account on the creator's changes is discretionary authority [inference].
- In 2022 the SEC asked whether index providers and model portfolio providers are advisers (Release IA-6050). No final rule found [search; current status unverified]. https://www.sec.gov/files/rules/other/2022/ia-6050.pdf
- Performance fees are allowed only for "qualified clients" (Rule 205-3; thresholds raised to $1.4M under management or $2.7M net worth from 29 June 2026) [search]. https://www.dorsey.com/newsresources/publications/client-alerts/2026/5/sec-increases-threshold
- The stock tokens we use exclude US persons anyway, so the practical US rule is: block US users from stock-token baskets.

### 2.2 Pooled vehicle with shares versus separate accounts following a model

| | Shared pool, followers hold shares | Own vault per person following a recipe |
|---|---|---|
| What the user owns | A share token: a new instrument issued by the pool | The underlying tokens directly |
| Fund regime | Yes. US: investment company and a securities offering. EU: collective investment undertaking (AIF/UCITS). UK: collective investment scheme. Brazil: investment fund or collective investment contract [memory for UK and Brazil] | No new instrument, so no fund or issuer regime by default |
| Service regime | Fund manager licence | Still applies when trading is automatic: portfolio management (EU/UK), discretionary advice (US), analysis and likely management (Brazil) |
| Individualisation | None; everyone gets the same thing | Per-vault limits, exclusions, pause, withdraw |
| Issuer controls on stock tokens | One holder; a freeze or transfer-policy block hits everyone | Each holder is assessed alone |

Separate accounts are not a free pass in the US. Rule 3a-4 is a non-exclusive safe harbor from investment-company status for discretionary programs, and it exists because many accounts run identically on one model can be a de facto fund [primary for the rule text; search for the rationale]. Its conditions map onto product features:
- Managed on the client's situation and objectives and "in accordance with any reasonable restrictions imposed by the client" → exclusions and caps per vault.
- Client can designate securities "that should not be purchased" → asset blocklist.
- Statement at least quarterly of all account activity → activity log per vault.
- Client can withdraw securities or cash, vote, get confirmations, and proceed directly against the issuer → self-custody vault, withdraw any time, no commingling.
- Periodic contact to update the client's situation → re-run the questionnaire.
https://www.law.cornell.edu/cfr/text/17/270.3a-4 ; rationale https://www.kitces.com/blog/rule-3a-4-of-the-investment-company-act-are-robo-advisors-a-registered-investment-adviser-ria-or-an-unregistered-investment-company/

So: own vaults remove the fund problem and keep the manager problem. Manual follow (the user signs every rebalance) removes most of the manager problem too, leaving advice or plain execution.

### 2.3 What a creator fee changes

- Brazil: remuneration plus habituality is the explicit trigger for the analyst credential (circular, section 2). An unpaid creator sharing a recipe is a weaker case [inference].
- EU: a fee routed to copied traders can be an inducement. Firms doing portfolio management generally can't accept and keep third-party payments (Art. 24(8), cited in para 68), and copied traders paid by the firm may fall under remuneration rules or be treated as outsourced providers who need their own authorisation (paras 22, 64, 73).
- US: compensation is one of the elements of adviser status; a performance-based fee restricts the audience to qualified clients; a per-trade fee looks like broker compensation [memory].
- Incentives, in rising order of trouble: no fee, flat subscription for content, fee on followers' assets, performance fee, fee per rebalance (pays the creator to churn).
- With or without a fee, a creator who holds or pre-buys what they add has a conflict. CVM says analysts should avoid recommending assets where they'd benefit from created demand and liquidity (circular, section 6, II).

For the demo: no live creator fee. If shown, label it as planned and conditional on a licensed partner.

### 2.4 The personal basket

A basket generated from a person's goal, amount, horizon, risk and holdings is a personal recommendation: investment advice under MiFID II, individualized advice outside the publisher's exclusion in the US, and consultoria (Resolução CVM 19 [memory]) in Brazil. Robo-advisers in the US are registered advisers [search] https://www.willkie.com/~/media/Files/Publications/2017/03/SEC_Division_of_Investment_Management_Issues_Guidance_Update_for_Robo_Advisers.pdf . For a hackathon it is fine as software the user drives and edits; for a launch it needs an adviser licence or partner in each market.

### 2.5 Demo wording

Use
- "recipe", "basket", "community index", "publish", "follow"
- "your vault, your tokens", "withdraw any time"
- "you approve each rebalance" (default) and "auto-follow rule: you set the limits, you can turn it off" (opt-in)
- "the keeper can only swap between assets you approved, within your limits, and can never withdraw"
- "simulated backtest" in small type, behind the live record since publish; "past performance does not indicate future results"
- "tokens that track the price of X; not shares; issuer can pause or freeze; not available to US persons"
- "built from your inputs; you can edit everything" for personal baskets
- "one all-in cost"

Avoid
- "fund", "ETF", "shares", "units", "NAV per share", "AUM", "manager", "managed for you", "we invest for you"
- "copy trading", "mirror", "signals"
- "advice", "advisor", "recommended for you", "suitable for you", "safe"
- "returns", "yield" as a promise, "guaranteed", "passive income", headline backtest percentages (Cesto's +23,918% is the cautionary example)
- "buy Apple stock", "own shares of"
- "S&P 500" or "Nasdaq-100" as the name of a community index (index trademarks [memory])
- "available worldwide"
- creator earnings as a growth hook ("earn from your followers")

### 2.6 Where a licensed partner is needed for a real launch

1. Auto-follow on tokenized stocks for EU or UK users: an investment firm with portfolio-management permission. Crypto-only auto-follow in the EU: a MiCA CASP authorised for portfolio management.
2. Personal baskets: investment-advice permission (EU/UK), a registered adviser (US), a consultor (Brazil).
3. Paid creators: credentialed analysts in Brazil; authorised or tied persons in the EU; advisers in the US.
4. Offering tokenized foreign stocks to Brazilian retail: can be an irregular public offering [memory, brazil-edge.md]; needs local counsel and probably a local distributor.
5. Any pooled product later: a fund manager and a registered fund.
6. Eligibility screening (US-person block, issuer transfer policies): a KYC or attestation provider.

A hackathon demo with the team's own funds and no public solicitation doesn't trigger any of this. The point is to make design choices that survive it and to put one honest compliance slide in the pitch.

---

## Design implications for Q1 to Q4

- Q1: own vault per basket per chain. It avoids issuing a share token (the fund trigger), keeps the user as direct owner, and makes the Rule 3a-4-style individual features real. A shared pool would need a fund wrapper everywhere and concentrates freeze risk.
- Q2: auto-follow is technically sound but is the exact feature regulators classify as portfolio management. Ship manual follow as default (notify, one-tap user-signed rebalance), auto-follow as opt-in with limits, delay and revocation. Weight changes among approved assets can be automatic; new assets need the user.
- Q3: nest by reference and flatten. Two tiers, depth 1, same chain, per-sleeve creator fee, one net rebalance.
- Q4: flatten is an off-chain pure function shared by all chains, about a day of work. No creator fees live. Geo and eligibility notice in the UI. Backtests labelled simulated and not the headline.

## Open risks

- Whether a permissionless keeper executing a deterministic "match the recipe" rule counts as a "firm" providing portfolio management is untested. ESMA's 2012 Q&A treats automatic execution of third-party signals as portfolio management by whoever executes; assume the operator of the keeper is that party until counsel says otherwise.
- The CVM circular covers the analyst angle only; how CVM would treat an automated on-chain keeper under Resolução 21 is inference.
- UK collective-investment-scheme and Brazilian fund definitions were not re-read today.
- M1's nesting depth limit and Reserve DTF nesting behaviour are unverified.
- The thundering-herd cost of a popular index update on thin Solana pools (GLDx, QQQx above $50k) is unmeasured.
- Swig per-mint limits mean every new asset in a followed index needs a user signature; that makes "fully automatic" follow impossible for new assets on Solana unless the role is pre-authorised for a vetted list. Untested.
