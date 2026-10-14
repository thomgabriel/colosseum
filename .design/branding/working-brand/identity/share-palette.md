# Share palette
> Phase: identity | Brand: Tenonfi | Added 2026-10-13 on `WEIGHTS-RING` (docs/GATES.md, Thom)

The colours of what a vault or a portfolio holds: one ring, or two bars before and after ([composition.md](../patterns/components/composition.md)). It replaces the plan-leg ramp (honey, honey-deep, wood-deep, muted) for holdings. That ramp kept every holding within one brown family, so two neighbours read as one and a fifth holding had to repeat the first (Thom, Oct 13: "the colours are muddy"). The plan-leg ramp stays for `<PlanLegs>` itself and Bearing's series.

**Why these hues.** Honey is first, so the largest holding of most vaults carries the brand. The others come from the daylight photograph the direction colours were drawn from (forest, water, heather and the darker timber), and stay away from what already means something: no leaf, clay or madder (direction), no chalk or other blue (a line), no violet. A holding is an identity, not a direction, so it never wears a direction colour.

## Tokens

The order is chosen so the first neighbours differ in hue (orange, plum, teal, brown), which is what a ring of three or four holdings shows (Oct 13: pine beside lagoon read as one teal). Assigned in the order the holdings come, never by size, so a holding keeps its colour in both bars of a comparison and while its share changes. Past the sixth holding every other one takes `rest`; each is still its own segment and its own row. Cash takes `cash` wherever it comes.

| Slot | Name | Light (on white) | Dark (on night-2) | Token |
|---|---|---|---|---|
| 1 | honey | `#F5A83A` | `#F5A83A` | `--tf-share-1` |
| 2 | plum | `#803668` | `#9F4D86` | `--tf-share-2` |
| 3 | lagoon | `#33A6A0` | `#5FBDB7` | `--tf-share-3` |
| 4 | bronze | `#975C17` | `#AF7033` | `--tf-share-4` |
| 5 | heather | `#CD7AA2` | `#DF93B5` | `--tf-share-5` |
| 6 | pine | `#12695C` | `#218373` | `--tf-share-6` |
| 7+ | rest | `#9A9DAD` (neutral 400) | `#6E7282` (neutral 500) | `--tf-share-rest` |
| cash | cash | `#C9C4B9` (neutral 300) | `#4B4F5E` (neutral 600) | `--tf-share-cash` |

The values are in `patterns/working-brand.yml` (`tokens.scales.share-*`) and `apps/web/app/globals.css`; `components/ui/tokens.test.ts` fails when they differ. In the partner embed the brand recedes: the eight become shades of the partner's text colour.

## Validation

Run with the data-viz validator (OKLab ΔE ×100, Machado 2009 at severity 1.0) on the slots in order with the ring's wrap from the last back to the first, white `#FFFFFF` and night-2 `#13151C` as surfaces:

| | Light | Dark |
|---|---|---|
| Worst adjacent CVD ΔE (target ≥ 8) | 15.0 | 13.8 |
| Worst adjacent normal-vision ΔE (floor 15) | 20.2 | 19.2 |
| Honey against every slot (the wrap at any count), normal vision | 17.0 | 17.0 |
| Worst of all pairs, normal vision | 17.1 | 16.9 |
| Contrast below 3:1 on the surface | honey 1.99, lagoon 2.96 | none |

Four things are knowingly so, and why:

- **Lightness band.** Honey sits at L 0.79, above both bands. It is the brand colour and is not moved; in dark mode lagoon and heather sit at L 0.74 and 0.75 for the same reason the night ground is darker than the validator's default.
- **Chroma floor.** Pine and lagoon are at C 0.08 to 0.10: teal has no more chroma than that at these lightnesses in sRGB. They read as teal, not grey.
- **Hue.** Lagoon is held at 190° in OKLCH: from 200° to 330° is blue or violet, which the brand gives to chalk alone (`components/ui/forbidden.test.ts` fails on it).
- **Contrast on white.** Honey and lagoon are under 3:1 on a white card. The relief the method requires is there: every share is written in the list beside the picture, the ring is a labelled image, and the 2.5px ground gap separates every pair.

## Rules

- The share palette is the only categorical set. It is for what a vault or a portfolio holds; nothing else takes it.
- Text never takes a share colour: names and figures stay in the text tokens; a ring of the colour around each logo carries the identity. Native token colours stay on the logos and never tint a segment (STYLE.md rule 6).
- Deltas in a comparison are signed and coloured by direction (leaf, madder, muted), as everywhere.
- A sample holding is hatched, never a lighter fill.
