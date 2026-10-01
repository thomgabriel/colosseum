# Logo Directions
> Phase: identity | Brand: Tenonfi (provisional; fallback "Tenon") | Generated: 2026-10-01

Visual comparison: [logo-comparison.html](./logo-comparison.html) shows all three directions as inline SVG on paper and warm black, at 16/32/48/96 px, as lockups, as "Powered by" in a neutral partner card, as "Tenonfi Bearing", and as plain "Tenon".

**Brief for every mark:** say *cut to fit* and *every joint shown* (essence "Fit, shown"). It must be square-cut, never rounded (joinery is square, archetype.md). It must hold at favicon size, recede to a "Powered by" credit and carry "Bearing" without a second brand. It must still work if "-fi" is dropped. **No** kanji, seal-red, brush, torii, blossom, bevelled chassis, nameplate, coin, gradient or mascot.

**Energy:** technical-calm. It should feel like a draughtsman's mark, not an emblem: flat, planar, few parts, every part a real member.

---

## A. Pinned through-tenon (recommended)

**Concept.** master.jpg reduced to a side elevation in three solid members: the **rail** (left, at full depth), the **post** (vertical), and the **tenon end** coming through the far face of the post, with the **pin** as a round knock-out through it. A hairline gap is left at each shoulder so the joint lines show. Read left to right it is the product: *your goal (the post) → the plan passes through it (the tenon) → held by its source (the pin)*.

**Wordmark.** Lowercase **tenonfi** drawn from Newsreader Display Medium with slightly tightened spacing. The square symbol and the humanist serif sit side by side as two species in one lockup: hard geometry and the human voice. "fi" is drawn as a true ligature (the f's arm runs into the i like a half-lap). Deleting the ligature leaves **tenon** untouched, so the fallback costs nothing.

**Strategic rationale.**
- **Sage:** it is a diagram that explains *why it holds*. It is an elevation, not a logo-shape.
- **Caregiver:** the serif wordmark gives warmth. "tenonfi" in lowercase is a voice, not a bank.
- **Made to measure:** a through-tenon is cut for one mortise only.
- **Every joint shown:** the end grain and the pin are visible from outside. That is the reason a through-tenon was chosen over a blind one.
- **System continuity:** the tenon end with its pin *is* the provenance glyph (see below). The brand can recede until only the pin is left, and the pin is still the brand. That makes the white-label rule ("recedes to the pin") a property of the logo itself.

**Variations.**
| Variation | Spec |
|---|---|
| Primary lockup | Symbol + `tenonfi`. Symbol height = wordmark cap height × 1.25, optically centred on the x-height |
| Fallback lockup | Symbol + `tenon` (same construction, ligature removed) |
| Icon (≥ 24 px) | Full symbol: rail, post, tenon end, pin |
| Small cut (≤ 20 px, favicon, tab, "Powered by") | The rail is dropped and there is one joint line. Post + tenon end + an enlarged pin hole. Tested at 16 px (it holds) |
| Product lockup | `tenonfi Bearing`. "Bearing" in IBM Plex Sans Regular at the wordmark's x-height, in `stone`. Never a separate symbol |
| Two-species (hero only) | Members in `hardwood`, pin in `hinoki` (on dark: `hinoki-deep` members, `hinoki` pin). The pin is always the *other* wood, as in master.jpg. Only at ≥ 64 px, never in UI chrome |
| Monochrome | `ink` on paper, `hinoki` on warm black, white or black for partners and print. The pin is always a knock-out, never a third colour |

**Clear space and minimum size.** Clear space on every side = the post's width. Minimum sizes: full symbol 24 px, small cut 12 px, lockup 72 px wide, "Powered by" lockup 10 px symbol + 11 px text.

**Usage rules.**
- Don't add rounded corners, bevels, shadows, gradients or wood-grain fills to the mark. Grain belongs in photography, not in the logo.
- Don't rotate it. The post is always vertical, because load runs down.
- Don't animate the logo except with the brand's one motion: the tenon slides in along one axis, then the pin drops in (imagery-style.md).
- Never set the wordmark in caps, and never in the sans.

**Risks.** At a glance the symbol could read as a plus or a medical cross. That is mitigated by the asymmetry: the rail is short, the tenon end is long and carries the pin. The silhouette must stay asymmetric in every redraw.

---

## B. Stacked cantilever

**Concept.** The Yusuhara bridge museum: three members stacked and offset, each longer than the one below, carried on a single column. The silhouette reads as a **T**. Many small pieces carry a large load, balanced on one support (the goal).

**Wordmark.** **Tenonfi** in IBM Plex Sans SemiBold, title case. Engineered and quiet.

**Rationale.** The strongest silhouette of the three and the most "architectural". It suits Bearing very well (load capacity). It carries the Sage and the structure, but not the pin, so provenance would need a separate glyph and the embed loses its link to the logo. The stacking is a structure, not a joint, so the "made to measure" idea weakens.

**Variations.** Full (3 members + column), small cut (2 members + column), monochrome. The Bearing lockup is the same symbol.

**Risks.** At 16–24 px it reads as a **funnel or filter icon**, which is a UI metaphor that collides with product chrome. It is also close to stacked-layer and bar-chart logos.

**Disposition.** Not the logo. The stacked offset **survives as a pattern** (P2, the section divider and marketing composition; see imagery-style.md).

---

## C. The pin as full stop

**Concept.** Wordmark-led. **tenonfi** in IBM Plex Sans Medium, lowercase, closed by the provenance glyph used as a full stop: the tenon end in outline with a solid pin. *Said, and sourced.* The icon is the pin glyph alone.

**Rationale.** It is the most honest system (the brand mark and the provenance glyph are literally one shape) and the lightest "Powered by" of the three.

**Risks.** The pin alone at favicon size reads as a generic "record", "screen" or target icon, which is weak recognition. The all-sans wordmark is close to the category's grotesk look. And using the provenance glyph as the logo means every figure in the UI carries a little logo, which crosses into self-promotion. The pin should mean *source*, not *brand*.

**Disposition.** Not the logo. Its idea is kept inside A: the pin glyph is derived *from* A's tenon end, so the two are related without being identical.

---

## The provenance glyph (shared, derived from A)

The pin seen through the tenon end, drawn in line mode: an outline rectangle (3:2) with a solid round pin at its centre. It sits after every yield, price and FX figure. Size = cap height (12 px at 16 px text). Colour = the species opposite the ground (`hardwood` on paper, `hinoki` on warm black). In the embed it takes the partner's muted text colour.

| State | Drawing | Always paired with |
|---|---|---|
| Live | Solid pin | Popover: `source · fetched_at · method` |
| Stale | Hollow pin | The word **stale** + the age |
| MOCK | No pin, 45° section hatch inside the outline | The word **MOCK** |

Accessible name: "Source for 6.4%". It is keyboard-focusable, opens on Enter, and the hit area is at least 24 × 24 px.

---

## Recommendation

**Direction A.** It is the only one that puts the whole brand sentence (cut to fit, held, visible) in one asymmetric, square-cut shape. It also hands the embed a single, meaningful remnant: the pin. Next step: `/gsp-logo --enrich` draws final outlines for the symbol (2 cuts), the wordmark with and without the fi ligature, and the Bearing and Powered-by lockups.
