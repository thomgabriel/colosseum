# Messaging
> Phase: strategy | Brand: working-brand ([Name] TBD, see naming.md) | Generated: 2026-10-01

**Swap test (applies to every line here):** replace [Name] with Ondo, Glider, Wealthfront, Betterment, Nexa or Gauntlet. If the line still works, it's too generic and must be rewritten. Every line below has been checked against this.

---

## 1. Core message

> **No product fits everyone. So [Name] cuts a portfolio to fit your one goal, and leaves every joint in plain sight.**

The core message always carries **both halves**: *made to measure* (fit to one goal) **and** *every joint shown* (source, after-risk value, exit, every move logged). A surface that only has room for one line uses the tagline. The tagline holds both halves too.

### Manifesto line (brand line, video close, site footer)
> **"No product fits everyone. So we cut each one to fit — and leave every joint in plain sight."**

Founder's line, kept as written. It passes the swap test: Ondo, Glider and Wealthfront all sell products meant to fit everyone.

### Short manifesto (site / video voice-over, about 90 words)
> Finance sells menus. A rate. A model portfolio. A strategy someone else designed, and you fit yourself to it.
> We start the other way round. You tell us what you're reaching for: an amount, a date, a way out. We measure, cut a portfolio for that one goal, and show you every joint: where each yield comes from, what it's really worth after risk, how fast you can get out.
> Then we keep it true. When something moves, you'll hear it from us early, with the reason and the receipt.
> No product fits everyone. So we cut each one to fit.

---

## 2. Supporting messages and proof points

### SM1: Made to measure: one goal, one portfolio
> **You bring the goal. The portfolio is cut for it, not picked from a menu.**

| Proof point | Status |
|---|---|
| Goals are stated in plain language and turned into an explicit, editable constraint sheet (amount, date, income, exit window, risk profile) that the user confirms | Shipped (parser + zod-validated `ConstraintSheet`) |
| A deterministic solver builds the portfolio from the constraints across dollar yield, treasuries, credit, tokenized stocks, commodities and cash. The same inputs always give the same plan | Shipped (engine) |
| Rules are enforced in the asset registry, not in a prompt. For example, tokenized stocks are never used for income goals | Shipped and tested |
| If a goal can't be met as set, the user is told why and shown the closest fit | Product behaviour (validation and solver output) |

*Never say:* "personalised AI portfolios", "bespoke", "tailored strategies". These are interchangeable claims. Always say **made to measure for your goal**.

### SM2: Every joint shown: you can see why it holds
> **Every number shows where it came from. Every yield shows what it's worth after risk. Every plan shows how fast you can get out.**

| Proof point | Status |
|---|---|
| Every yield, price and FX figure carries source · fetched_at · method (the pin) | Shipped rule, enforced by test (no hard-coded yields outside fixtures) |
| Quoted yields are cut by credit-aware haircuts. We show the quoted and the used figure. The founder's prior analytics found on-chain yield/volume figures overstated by 2–5.6x | Shipped (risk sheet per leg). The 2–5.6x figure is from prior work and must be cited as such |
| Exit capacity is measured, not assumed: depth by size and hour of week, recorded continuously since Sept 2026 | Shipped (depth snapshot cron); dataset is growing |
| Stress cases are shown next to the base case, month by month | Shipped (path + stress) |
| Anything mocked is labelled MOCK, in the UI and in the API (`"provenance": "mock"`) | Shipped rule |

### SM3: Kept true, in your own wallet
> **It runs as a policy in your wallet, re-trues as things move, and tells you early, with the reason and the receipt.**

| Proof point | Status |
|---|---|
| Execution goes into the user's own wallet (self-custody). We never hold funds | Shipped (Solana mainnet, real transactions) |
| Every mainnet transaction is logged with its explorer link and shown in the UI | Shipped (`executions` table) |
| Rebalances happen to keep *the goal* on track, never to chase rate. Each carries a "because" | Policy behaviour |
| The agent proposes and explains. The language model only parses goals. The solver, not the model, decides | Shipped architecture |
| Not licensed advice. The disclaimer appears on the plan and in the API docs | Shipped (single `DISCLAIMER` constant) |

---

## 3. Elevator pitch (30 seconds)

> Everyone with dollars gets offered a menu: a rate, a model portfolio, an "earn 5%" button. None of them answers the real question: *will my goal land, what could break it, and how fast can I get out?*
>
> [Name] is an agent that starts from your goal instead. You say what you're reaching for, say "this amount by June 2028, with a week's access to cash". It confirms the details with you, then cuts a portfolio for that one goal across dollar yield, treasuries, credit and tokenized assets. Every number shows its source, every yield shows what it's worth after risk, every plan shows the exit. It runs in your own wallet and re-trues as things move.
>
> Not a menu. Made to measure, with every joint shown.

**10-second version:** "[Name] builds a portfolio for your one goal, made to measure, and shows every joint: where each yield comes from, what it's worth after risk, and how fast you can get out."

---

## 4. Tagline directions

| # | Tagline | Rationale | Risk |
|---|---|---|---|
| **A (recommended)** | **Made to measure. Every joint shown.** | Holds both halves of the positioning in five words. The second sentence is the brand's distinctive claim and passes the swap test (no competitor shows its joints). It doubles as a visual instruction for the identity: the exploded view | "Joint" has a cannabis meaning in EN. In context ("every joint shown") the joinery reading dominates. Test with 5 EN speakers. Fallback: A2 |
| A2 (fallback for A) | **Made to measure. Nothing hidden.** | Same structure, no ambiguity, echoes the brand promise | Less distinctive ("nothing hidden" is closer to generic transparency claims) |
| B | **Cut for your goal. Open to every question.** | More Caregiver: speaks to the person and invites scrutiny | Longer. "Cut" can read as "reduced" out of context |
| C | **It holds. And you can see why.** | Pure Sage × Caregiver: reassurance plus the reason. Strong as a video end line or plan-view sub-line | Doesn't say "made to measure", so it can never be used alone. Pair it with the manifesto |

**Localised tagline A:**
- **PT:** "Sob medida. Cada encaixe à vista." (*encaixe* = fit/joint, no ambiguity in PT)
- **ES:** "A la medida. Cada ensamble a la vista." (*ensamble* = joinery joint; avoids *mortaja*)

---

## 5. Audience mapping

| Audience | Primary motivation | Key message | Supporting points (order) | Tone shift | Proof to show | Channel |
|---|---|---|---|---|---|---|
| **Mariana 1a**, crypto-native diversifier | Put idle stables to work in RWAs without becoming a PM, *and* see everything | "Tell it what you want. It builds the portfolio for that, in your wallet, with every number's source." | SM2 → SM3 → SM1 | Slightly drier and more technical. Receipts over reassurance | Explorer links, real mainnet transactions, pin popovers, haircut vs quoted, measured exit | X/Crypto Twitter, Telegram/Discord, Colosseum demo |
| **Mariana 1b**, life-goal saver | Know if *her* goal will land, without learning DeFi | "Your apartment fund, on track for June 2028, and if that changes, you'll hear it early." | SM1 → SM3 → SM2 | Warmest. Plain words, the goal by its name, dates over percentages | On-track statement, stress case in plain words, "access to cash" | Partner app (embed), word of mouth, financial creators |
| **Rafael**, neobank / fintech Head of Product | A differentiated earn feature that compliance can defend and that won't embarrass his app | "Replace the rate button with a plan for what each user is saving for, under your brand, with every figure's source." | SM1 (as differentiation) → SM2 (as compliance) → white-label | Professional, concise, docs-first. ROI in user outcomes, never rate | OpenAPI at `/docs`, MOCK labelling, disclaimer boundary, deterministic solver, embed demo in partner skin | Partner intros (Chainless, Picnic LOIs), API docs, demo calls |
| **Priya**, risk lead at a lending protocol / curator | Auditable liquidity numbers she can set parameters from and cite in governance | "[Name] Bearing measures how much of your collateral can really be sold, at what cost, at what hour, versioned, sample-counted, method in the open." | Measurement → method → neutrality disclosure | Instrument register: units, n=, versions, no adjectives | Hour-of-week depth heatmap, method doc, raw sample access, version history | Governance forums, risk research posts, direct outreach |
| **Colosseum judges** (Oct 2026) | Is it real, is it novel, will it matter on Solana? | "Live on mainnet: an agent that builds a portfolio for one goal and shows every joint, plus a liquidity dataset no one can backfill." | Live proof → novelty (fit + visible) → Bearing as a second market | Confident, specific, no hype | Mainnet transactions with explorer links, solver determinism, Bearing heatmap, LOIs | Submission video, demo, deck |

### Objection handling (short answers)
| Objection | Answer |
|---|---|
| "Isn't this just a robo-advisor?" | Robo-advisors put a goal label on a model portfolio. We solve the portfolio from the goal, and we show the after-risk yield, the sources and the exit. |
| "Can an AI agent be trusted with money?" | The language model only reads your goal and writes it down for you to confirm. A deterministic solver builds the plan. Everything runs in your wallet, and every move is logged with its transaction. |
| "What return will I get?" | We don't promise returns. We show what your plan is built on, what it's worth after risk, what happens if rates fall, and we tell you early if your date moves. |
| "You earn fees on portfolios, so how is Bearing neutral?" | Bearing is never paid by, and never curates for, the protocols it measures. The method and samples are public, so you can check the numbers without trusting us. |
| "Is this financial advice?" | No. It's a tool that builds and explains a plan from the goal you set. The disclaimer is on every plan. |

---

## 6. Narrative arc (video and deck)

| Beat | Content | Visual cue (for identity phase) |
|---|---|---|
| **Setup** | Everyone with dollars is handed a menu: rates, model portfolios, an "earn" button | A rack of identical pre-cut parts |
| **Tension** | None of them answers *will my goal land, what could break it, how fast can I get out?*, and the parts that decide it (haircut, depth, exit cost) are hidden | Pieces that don't fit, gaps showing |
| **Resolution** | [Name] measures the goal, cuts a portfolio for it, shows every joint, and keeps it true in your wallet | Two species apart, they slide, lock, the pin goes in. Cut to the plan's exploded view |
| **Transformation** | "Your apartment fund is on track for June 2028." Seen, at ease, in control | The locked joint, light passing through. End card: tagline A |

---

## 7. Claims guardrails (non-negotiable)
- No return, rate or outcome claims. "Up to" is banned.
- Any number in marketing is either a real figure with its pin (source · fetched_at · method) or marked **illustrative**. No unlabelled example yields.
- MOCK is always labelled, including in the video and screenshots.
- "Not licensed advice" appears on every plan view and in API docs, rendered from the constant.
- Prior-work statistics (2–5.6x overstatement) are cited as the founder's prior analytics, not as a [Name] product measurement.
- Brazil and LatAm partners may be named as partners. They are never the frame of the brand.
