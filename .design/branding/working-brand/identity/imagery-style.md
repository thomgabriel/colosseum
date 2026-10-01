# Imagery Style
> Phase: identity | Brand: Tenonfi (provisional; fallback "Tenon") | Generated: 2026-10-01

**Principle (archetype.md):** joinery means *you can see how it works*. A beautiful image that explains nothing fails the brand. There are three image modes, each with one job:

| Mode | Job | Where |
|---|---|---|
| **Material**: photographs and 3D renders of real joints | *It holds*: material truth, warmth, craft | Marketing, video, social, consumer hero, partner deck |
| **Drawing**: 2D exploded views and orthographic line drawings | *Here's why it holds*: structural truth | Product UI, docs, explanations, video overlays |
| **Structure**: lattice patterns | *It's measured*: grid, rhythm, waiting states | Layout, dividers, loading, Bearing |

**Note on the mood board:** discover/ said "no 3D renders". The founder has since asked for them, and that wins, with one condition: **renders must be material-real** (real species, real end grain, real light, real joint geometry). If a render could be mistaken for a crypto 3D asset (glass, chrome, floating, glowing, impossible geometry), it fails.

---

## 1. The joint set: five joints, five jobs

Each joint stands for one thing and appears only in that role. If a joint has no product meaning, it doesn't ship.

| # | Joint | Role in the brand | Product moment |
|---|---|---|---|
| **J1** | **Pinned through-tenon** (mortise, tenon and pin, *komisen*). The governing image | **The logo, the plan, provenance.** The **mortise** is the goal's shape (the constraint sheet). The **tenon** is the plan cut to fit it. The **pin** is the source that holds each number | Goal → plan → lock. The pin glyph on every figure |
| **J2** | **Half-lap cross** (the kumiko crossing: two members notched halfway so they lie flush) | **Structure and measurement.** The unit cell of every lattice pattern | Layout grid, Bearing heatmap, loading state |
| **J3** | **Sliding dovetail, dropped in** (*ari-otoshi*: drops in from above and lifts out along the same single axis) | **The exit plan.** The way out is designed before the piece goes in, and it is the way in reversed | "Access to cash" panel, exit-plan drawing, the proof line in the video |
| **J4** | **Keyed scarf splice** (*kanawa tsugi*: two lengths spliced end to end and locked by a driven key, traditionally used to replace a decayed section while the building stands) | **Rebalance (re-true).** One section is replaced while the structure keeps carrying load | Activity log hero, rebalance explanation, video beat "re-true" |
| **J5** | **Bracket set** (*masugumi / tokyō*: stacked blocks and arms carrying the eaves) | **Bearing.** Load passing through many small pieces. Capacity is measured, not assumed | Bearing hero, Bearing docs cover, risk deck |

**Not in the set:** decorative furniture dovetails (a woodworking cliché), puzzle boxes, jigsaws, LEGO studs, screws, nails, glue, and any joint we can't name and explain in one sentence.

---

## 2. Material mode: photography and 3D

### Photography (real joints)
- **Subject:** J1–J4 as physical samples in two species, shown **apart** a moment before they lock and **locked**, with cut faces and end grain sharp. Secondary subjects are daylight timber interiors where the structure **frames a view** (photo9 logic: the plan frames the person's goal). Hands are allowed only when measuring, fitting or sliding a piece. Never faces, phones, handshakes, piggy banks or couples.
- **Light:** one warm, raking key light from upper left with deep falloff, on **black seamless**. Or overcast daylight on **paper** (an unbleached card sweep).
- **Lens:** short telephoto or macro, with the plane of focus on the cut and the pin.
- **Grade:** neutral-warm. Wood stays wood-coloured. No teal-orange, no added saturation, no vignettes, no grain overlays.
- **Licensing:** master.jpg, the Kuma photographs and the temple brackets are **mood only, not for use**. Shipped photography is either our own or licensed with the licence on file.

### 3D look (Blender / Cycles)
| Element | Spec |
|---|---|
| **Species** | Pale: **hinoki** (or spruce or cypress), with fine straight grain and a satin, slightly translucent face. Dark: a warm mid-brown hardwood (**keyaki/zelkova, cherry or sapele**) with visible open grain. The **pin is always the other species** from the member it passes through |
| **Surfaces** | Planed faces satin (not gloss, no lacquer). **End grain shows growth rings and is mapped separately**, never stretched side grain. Edges broken by 0.3–0.5 mm, never chamfered into a bevelled-chassis look |
| **Proportions** | Taken from real joinery: posts about 45 × 45 mm, rails 45 × 60, tenon about a third of rail thickness, pin about 9 mm. Real tolerances, no gaps when locked |
| **Light** | As in master.jpg: one warm key (about 3,200–3,600 K) at upper left, about 45° azimuth and 50° elevation, medium-soft. Fill about 3 stops under, neutral, from camera right. No rim light, no coloured lights, no glow, no bloom |
| **Ground** | **Black:** world black, no floor visible, pieces float only as much as master.jpg does (cropped so support isn't a question). **Paper:** a #F6F1E8-toned sweep, overhead overcast softbox, soft contact shadows |
| **Camera** | 3/4 from above: about 30° elevation, 30–40° azimuth, 85–100 mm equivalent (low distortion). Orthographic for technical stills. Depth of field shallow but the whole joint readable; focus on the pin |
| **Motion** | **Single axis, one piece at a time.** A piece slides along its own axis, decelerates and **seats**. Then the pin (or key) enters. No bounce, no overshoot, no spin, no orbiting camera. The camera is static or pushes in no more than 5% over a shot |
| **Colour management** | AgX (or Filmic), medium-high contrast. Black reads as #000 in the frame. Where it sits in UI, the frame's surround is `black` #0D0B09 |
| **Never** | Glass, chrome, metal fasteners, glossy plastic look, floating debris, particles, depth fog, coins, logos embossed into the wood, kanji branding marks |

**Image provenance (our own rule applied to ourselves):** renders are credited as renders. A render is never captioned or implied to be a photograph. Generative-AI images may be used for **internal concepting only, never shipped**: they invent impossible joints, and they would break "every joint shown".

---

## 3. Drawing mode: 2D exploded views and orthographic drawings

| Convention | Rule |
|---|---|
| **Projection** | Axonometric (30°) for marketing and video. Orthographic (flat elevation or plan) inside the product |
| **Line weights** (at 1×, non-scaling) | **1.5 px** cut or outline of the key member · **1 px** visible edges · **0.5 px** (or 1 px in `hair`) secondary edges, grid and dimension lines · **dashed 4/2** hidden edges *and projections* |
| **Colour** | Lines in `ink` / `washi`. The **key member** (the leg being explained, the tenon) is drawn in the species opposite the ground: `hardwood` on paper, `hinoki` on black. Flat fills allowed in the two species only. No gradients, no shading, no grain |
| **Assembly axis** | A dash-dot centre line along the axis each piece moves on. Exploded pieces sit apart along it by 1–1.5× member thickness |
| **Dimension lines** | Hairline, with 45° tick terminators (architect's ticks, not arrowheads), extension lines with a 2 px gap from the object, value in **Plex Mono** above the line. Dimensions = **constraints**: amount, date, exit window ("≤ 7 days") |
| **Callouts** | Square tags (not circles; joinery is square) with a number, a leader line, and in the product: leg name · weight · pin glyph |
| **Section hatch** | 45°, hairline, 3–4 px pitch. **Reserved: means MOCK** (and, with the word "stale", stale data). It is never used for decoration and never used to show a real section |
| **Dashed** | Means **projected** (future path, stress case, estimated odds). Solid means measured or live |
| **The pin glyph** | The provenance mark (logo-directions.md). Every figure in a drawing that is a yield, price or FX carries it |

**Iconography direction (no library chosen here):** a 24 px grid, 1.5 px line, square caps and joins, 0 radius, drawn from orthographic joinery logic. Icons are few and plain. The pin glyph is not an icon and is never reused for anything else.

---

## 4. The assembly story, mapped to the product flow

One motion vocabulary everywhere: pieces move on one axis, seat, then the pin goes in. It runs in UI (2D, fast), in video (3D, slow) and in drawings (static, exploded).

| Step | Product | Joint / image | UI motion (2D) | Video (3D) |
|---|---|---|---|---|
| 1 **Goal** | Constraint sheet confirmed | J1 **mortise** drawn empty, with dimension lines for amount, date and exit window | Dimension lines draw in (200 ms each, staggered) | The empty mortise in the post, lit, waiting |
| 2 **Pieces cut** | Solver returns legs | Tenons appear exploded on their axes, one per leg, with numbered square callouts | Legs fade in at exploded positions (160 ms, 60 ms stagger) | Each leg piece seen apart, cut faces sharp |
| 3 **Lock** | Plan accepted, executing | Tenons slide in and seat. The **pin** goes in = sources attached | Slide 280–360 ms, `cubic-bezier(0.2,0,0,1)`, last 2–4 px slowest; pin follows after 100–140 ms over 160 ms | H2 (below) |
| 4 **Exit plan visible** | "Access to cash" shown before investing | J3 **ari-otoshi** with its lift-out path as a dashed dimension: "out ≤ 7 days · cost ≤ 0.5%" (illustrative) | The lift-out path draws upward, dashed | The dovetail lifts out cleanly and drops back |
| 5 **Re-true on rebalance** | Activity: "I moved…" | J4 **kanawa tsugi**: one section slides out, the re-cut section slides in, the key is driven | One leg slides out, a new leg slides in, the log line appears with its explorer link | The splice assembled, key driven last |

- **"Why this plan?"** reverses step 3 (pieces part 12–24 px on their axes, callouts fade in) and closes back to locked.
- **Reduced motion:** every slide becomes a 120 ms crossfade, and the pin appears without travel.
- **Never:** confetti, counting-up figures, parallax wood, looping ambient motion, spring physics.
- **Plain words in the UI:** the pictures carry the metaphor. Labels say "Building your plan", "Rebalanced", "Access to cash", never "cutting", "re-truing" or "joints" (voice-and-tone.md).

---

## 5. Pattern system: kumiko and Kuma as structure

Five patterns, each with one job. Every pattern is drawn in hairline (`hair` / `hair-d`) only, never in a brand species, so it stays structure and never becomes ornament.

| ID | Pattern | Source | Job | Densities |
|---|---|---|---|---|
| **P1** | **Square kumiko lattice** (orthogonal half-lap grid, J2) | Kumiko square grid; GC Prostho in elevation | **Layout grid made visible** | **Coarse:** cell = 1 column of the 12-col grid. Section-level backgrounds on marketing and docs. **Medium:** 24 px cell for loading and empty states only. **Fine (8 px): print and video only**, never on screen (moiré) |
| **P2** | **Stacked offset** (members stepped by one unit) | Yusuhara cantilever; photo9 | **Section divider and marketing composition.** Three hairlines, each extending one step further, end a section. Hero blocks are offset by one column | One size: step = 1 grid column (marketing), 8 px (docs) |
| **P3** | **Receding 3D grid** (axonometric lattice in depth) | GC Prostho museum | **Atmosphere for Bearing and the video:** the Bearing landing hero, video interstitials, deck covers | One density per composition; at least 40% of the frame left empty |
| **P4** | **Section hatch** (45°) | Technical drawing | **MOCK and stale only** | 3–4 px pitch at UI scale |
| **P5** | **Bracket set** | Tokyō | **Bearing imagery only** (photo or render). Never drawn as a repeat pattern | n/a |

### Allowed and forbidden

| Surface | P1 coarse | P1 medium | P2 | P3 | P4 |
|---|---|---|---|---|---|
| Marketing site | Yes (section grounds) | No | Yes | Bearing page only | Only on MOCK |
| Consumer plan / goal card | No | Loading only | No | No | On MOCK fields |
| API docs | Yes (page margins only) | No | Yes (section ends) | No | On MOCK examples |
| Partner embed | **No** | **No** | **No** | **No** | **Yes, always** (the one pattern that survives white-labelling) |
| Bearing dashboard | No (the heatmap *is* P1, as data) | Loading only | No | Landing only | No-sample cells |
| Video / social | Yes | Yes | Yes | Yes | On any MOCK figure |

**Hard rules**
1. **Never behind numbers, text blocks, form fields, charts, the provenance popover or the disclaimer.** A pattern stops at least one grid unit from any figure.
2. **Only P4 is diagonal**, so the hatch keeps its meaning. No diagonal kumiko (asanoha, etc.).
3. **Banned motifs:** asanoha (hemp leaf), kikkō (hexagon, which also reads as crypto hex), seigaiha (waves), shippō, sakura, any family crest, wood-grain wallpaper.
4. **Patterns don't move**, except the P1-medium loading state and video.
5. Density is chosen per surface from the table above. It is never scaled up for "more texture".

### Loading state: "the lattice assembles"
A 3 × 3 P1 cell. Four horizontal members slide in along their axes, then four verticals drop into the half-laps, 240 ms each with a 60 ms stagger. Hold 400 ms, crossfade out, repeat. It shows only for waits over 400 ms, and the label carries the meaning ("Building your plan…"). Reduced motion: the static lattice plus the label.

---

## 6. Production for Oct 4: what to make, and how

**Tools, decided.**
- **Blender (Cycles):** hero stills and the assembly animation. The geometry is boxes, booleans and one cylinder (about 3 hours to model J1). Use CC0 wood textures (Poly Haven or ambientCG), with separate end-grain maps.
- **SVG (hand-drawn in Figma or code):** the logo, the pin glyph, patterns, every 2D exploded drawing and the UI motion (CSS transforms on SVG groups, so it is accessible and reduced-motion friendly).
- **Spline: no.** Its default look is glossy and toy-like, it adds runtime weight, and the category uses it.
- **three.js in-app: not before Oct 9.** Pre-rendered WebM/MP4 loops with poster frames cover the landing hero. Revisit after the hackathon.
- **Photography:** order a two-species joint sample now. If it arrives before Oct 10, shoot H1 for real (one lamp, black velvet, tripod, an afternoon) and use the photo where the render was. If it doesn't, the renders ship.

### Hero assets (make in this order)

**H1: "The Open Joint" still (Blender).** *Video end card, landing hero, X header, deck cover.*
Two members of J1, a hardwood rail and a hinoki post, apart by about 15 mm along the tenon's axis, a moment before lock. The hinoki pin is already through the tenon end (master.jpg logic, as our own model). Black ground, key light from upper left, 3/4 view from above, 85 mm, focus on the pin and the tenon end grain. Delivered at 3:2 (3600 × 2400), 1:1, 16:9 and 9:16, plus a paper-ground variant. The composition leaves the left third empty for a serif line.
*Brief line:* "Two species of wood, cut for each other, shown apart a moment before they lock. The pin is visible. Nothing else in frame."

**H2: "Lock" animation (Blender, 6 s, 24 fps, 1080p and 4K).** *Video resolution beat, landing loop.*
0.0–1.0 s hold apart (H1 framing) → 1.0–2.4 s the rail slides on one axis about 60 mm into the post, with the last 4 mm slowest, and **seats** (no bounce) → 2.6–3.3 s the pin slides down its own axis into the tenon end → 3.3–6.0 s hold, light unchanged. Static camera or a push-in under 3%. Loop version: crossfade from the last frame to the first over 0.5 s. No sound design that implies a click or a lock-ding; the soundtrack carries it.

**H3: "Your plan, exploded" (SVG, axonometric for video, orthographic for product).** *In-app "Why this plan?", video overlay, docs.*
The goal as the **post with an empty mortise**, with a dimension line "$40,000 · June 2028" and an exit dimension "≤ 7 days" (illustrative). Three **tenons** as legs on their assembly axes with square callouts: ① USDY · 42% ⊡, ② Kamino USDC · 38% ⊡, ③ Cash · 20% ⊡ (illustrative weights; the ⊡ placeholder stands for the pin glyph). One leg drawn with **section hatch + MOCK** to show the convention. The J3 lift-out path dashed. The key member in `hardwood` (paper) or `hinoki` (black). Built as SVG groups so the in-app version animates steps 1–3 of §4.

**H4: "Bearing" frame (SVG + one render).** *Bearing landing, risk deck, the video's Bearing beat.*
(a) The hour-of-week **depth heatmap as a P1 lattice**: 24 × 7 cells on `black`, the lightness ramp from color-system.md, no-sample cells hatched, axis labels in Plex Mono, every cell's value reachable with its pin. (b) A **J5 bracket-set render** (Blender, hinoki, same light as H1) behind a P3 receding grid, for the Bearing title card only.

**Next (Oct 5–10, before the video lock), as 2D SVG animations:** **H5** J3 exit lift-out and **H6** J4 re-true splice, both following §4.

Technical enrichment (SVG asset specs, export sizes, CSS motion tokens) is handled by `/gsp-visuals --imagery --enrich`.
