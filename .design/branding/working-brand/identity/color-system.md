# Color System
> Phase: identity | Brand: Tenonfi (provisional; fallback "Tenon") | Generated: 2026-10-01

**Composition strategy: monochrome (one material) with inverted sections.** Wood is the only colour. Every hue in the brand comes from one family (warm yellow-brown), and hierarchy comes from lightness. Light (daylight paper) and dark (warm black) are **peers**, not a theme and its afterthought. Marketing pages alternate between them like a joint photographed on black, then a room in daylight. Proportions on any screen are about **60% ground, 30% ink and hairline, 10% wood**. The 10% sits where it means something: interaction, the pin, the key member in a drawing.

**Why (strategy):** the category speaks in a single saturated accent (blue, violet, mint or lime). We carry identity through the **contrast of two species**, pale against dark, as in master.jpg. Sage gets a muted, structured palette. Caregiver gets warmth: never cold navy, never pure white. Positioning gets material instead of abstract.

---

## Core palette

| Role | Token | Hex | Usage | Rationale |
|---|---|---|---|---|
| Light ground | `paper` | **#F6F1E8** | Light-mode page | Unbleached daylight paper. Warm, calm, never pure white (Caregiver) |
| Light surface | `paper-raised` | **#FBF8F2** | Plan cards, popovers on light | A shade *lighter* than ground: a planed face catching light, not a shadowed card |
| Light recess | `paper-sunk` | **#EDE6DA** | Table headers, code blocks, input wells | The cut face, slightly in shadow |
| Dark ground | `black` | **#0D0B09** | Dark-mode page, Bearing, video | The black seamless of master.jpg, warmed so it isn't cool #000 |
| Dark surface | `char` | **#1A1714** | Panels on dark | |
| Dark raised | `char-2` | **#24201B** | Selected rows, popovers on dark | |
| Text on light | `ink` | **#1C1712** | Body and headings on paper | Warm black ink |
| Text on dark | `washi` | **#ECE4D6** | Body and headings on dark | Paper colour inverted, so text on dark isn't tan |
| Pale species | `hinoki` | **#E6D3B7** | **The brand colour on dark:** interactive, focus, pin, key member | Sampled from the pale tenon in master.jpg |
| Pale, shaded | `hinoki-deep` | **#C9AE86** | Secondary emphasis on dark, two-tone logo | Hinoki in shadow |
| Dark species | `hardwood` | **#7A5A3A** | **The brand colour on light:** links, primary button, pin, key member | Sampled from the hardwood face in master.jpg |
| Dark, end grain | `heartwood` | **#5A3A1E** | Pressed and active states on light, emphasis | The darkest cut face |
| Muted text | `stone` / `stone-d` | **#6E655B** / **#A49A8E** | Secondary text, captions, provenance lines | |
| Hairline | `hair` / `hair-d` | **#D9CDBB** / **#3A322A** | Rules, lattice, dimension lines, table rows | Decorative structure only. Not a control boundary |
| Member line | `member` / `member-d` | **#8C7F70** / **#7A6D5F** | Input borders, control outlines, focus-adjacent edges | Lines that must be *seen* (controls). `gsp-color` confirms they meet non-text contrast |

**The species rule:** on paper, the brand's wood is `hardwood`. On warm black, it's `hinoki`. The pin and any "key member" in a drawing are always **the species opposite the ground**, as the pale pin passes through the dark tenon in master.jpg. There is no third brand hue.

---

## Semantic colours (goal state)

Always **word + shape + colour**, never colour alone (WCAG 2.2, 1.4.1). All three are earth pigments, so they sit inside the wood palette and never read as trading-app red and green.

| State | Light | Dark | Shape | Note |
|---|---|---|---|---|
| **On track** | `forest` **#2F4A2A** | **#7FA37A** | Solid square | Yusuhara cedar forest. Deliberately not P&L green |
| **Watch** | `ochre` **#8A5A00** | **#D9A441** | Half-filled square | Earth ochre. Not Bitcoin orange or amber |
| **Off track / error** | `madder` **#A8324A** | **#E58AA0** | Square outline with a notch | Cool madder (hue ≈ 345°). Kept far from cinnabar (Teiten) and seal-red (cliché), which sit around 0–20° |
| **MOCK** | `stone` + 45° hatch | `stone-d` + hatch | Hatched | Never a colour of its own. Hatch + the word MOCK (imagery-style.md) |
| **Stale** | `stone` + hatch | `stone-d` + hatch | Hollow pin | The word "stale" + the age |
| **Info / neutral** | `ink` | `washi` | n/a | There is no blue "info" colour. Blue is the category's colour |

Validation error ("doesn't fit"): the mortise slot outlined in `madder`, plus a sentence saying what to change (voice-and-tone.md). Success never gets its own celebratory colour. "On track" is enough.

---

## Data colour

- **Heatmaps (Bearing depth by hour-of-week):** single-hue *lightness* ramp, so it is colour-blind safe and reads as wood darkening with depth. On dark: `#1A1714 → #5A3A1E → #8A6C4B → #C9AE86 → #F2E6D3`. On light it is reversed. Empty or no-sample cells are hatched, never coloured.
- **Plan legs (allocation):** up to 4 legs use `hardwood`, `hinoki-deep`, `heartwood` and `stone`, each with a direct label (never a legend-only key). With more than 4 legs, group them or use labelled hairline bars.
- **Projections (path, stress cases):** the base case is a solid `ink`/`washi` line, stress cases are dashed `stone`, and the measured past is solid. Dashed means *projected*, everywhere.
- **Never** a rainbow categorical palette, and never red/green P&L colouring.

---

## Dark mode direction

Dark is the native register for **Bearing**, the **hackathon video** and **photography** (the black seamless). Light is the native register for the **consumer plan**, **API docs** and the **embed default**. Both are complete and both are first-class.

| Light | → Dark | Note |
|---|---|---|
| `paper` #F6F1E8 | `black` #0D0B09 | UI ground. Photography may sit on true #000 inside its frame |
| `paper-raised` #FBF8F2 | `char` #1A1714 | |
| `paper-sunk` #EDE6DA | `char-2` #24201B | Recess becomes raised. That's fine, because both mean "set apart" |
| `ink` #1C1712 | `washi` #ECE4D6 | |
| `hardwood` #7A5A3A | `hinoki` #E6D3B7 | The species swap |
| `heartwood` #5A3A1E | `hinoki-deep` #C9AE86 | |
| `hair` / `member` | `hair-d` / `member-d` | |
| Focus ring: 2 px `hardwood`, 2 px offset | 2 px `hinoki`, 2 px offset | |

There is no glass, blur, glow or ambient orb in dark mode. Depth comes from the three warm layers and hairlines (minimal-dark's structure, without its effects).

---

## Partner embed (white-label)

Colour **recedes completely**: ground, text, primary and radius map to the partner's tokens. What stays: the pin glyph (in the partner's muted text colour), the hatch for MOCK, hairline structure, the disclaimer block, and the "Powered by" line in the partner's muted colour. *The joints stay. The wood becomes theirs.*

---

## Banned

Blue, indigo or violet anywhere in UI. Mint, lime, neon, gradients, glass, gold foil. Cinnabar, vermilion or seal-red. Pure #FFFFFF grounds. Amber #F59E0B. Wood-grain textures as UI backgrounds. Daylight `sky` (#CAE3F4) exists **only inside photographs**, never as a UI colour.

Technical enrichment (OKLCH scales, the full contrast matrix, `palettes.json`) is handled by `/gsp-color --enrich`.
