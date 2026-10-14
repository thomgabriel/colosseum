# Sample marking (gate MOCK-QUIET)
> Type: custom | Components: `SampleTag` (the card's tag, drawn by `Card mock` and `GoalCard mock`), `SampleNote` (a panel's quiet line), the hatched pin / `<SampleGlyph>` | Gate: `MOCK-QUIET` (Thom, 2026-10-06, docs/GATES.md) | Revised 2026-10-08 (honey on night); 2026-10-13 (Thom: the card's hatched edge and foot line become one tag). File name kept for links; the plate it once described is gone.

**The rule.** No boxed MOCK beside a figure, anywhere: landing, plan, buy and funding cards, risk, charts, embed, Bearing. A card whose figures are sample or from a test network **says so once**, in **one quiet tag in its top-right corner**: "Sample figures" or "Test network" ("Números de exemplo", "Rede de teste"); "sample rates, not live" on the landing's cases. A card has no hatched edge and no foot line (Thom, Oct 13: "i also dont like this part of the card"). A sample figure keeps its **hatched pin**, or a small **hatched glyph** where it has no pin, named "sample figure" for screen readers. Live figures keep their pin. Sample is never shown as live. The buy card's line on a test network reads "Test network · <chain> · not live". The word MOCK stays as the API value (`"provenance": "mock"`) and as the name of the state in the documents; it never appears as a label in the UI.

The P4 hatch is still a word, not a texture: it means *not finished*, and it appears only for **sample** and **stale**. Text never sits on hatch strokes.

## Anatomy

```
┌──────────────────────────────────────────────────────────┐
│ Kamino USDC                       Solana  [Sample figures] │  ← the tag, after the header's meta
│ 5.20% ⊡▨                                                   │  ← the figure with its hatched pin
└──────────────────────────────────────────────────────────┘
```

Two parts, together, always:
1. **The tag** `SampleTag` (`components/ui/internal/mock-parts.tsx`), drawn by the card itself (`Card mock`, `GoalCard mock`): the house kit's `Plate` (`PLATE` in `components/ui/Panel.tsx`, the portfolio overview's pill, the house style, Thom, Oct 13), with the hook a panel's `Plate` has, `data-ui="sample-tag"`, so a card and a kit panel carry one mark: Inter 500, `text-caption` (12px / 16px), `--foreground` on `--honey-tint`, a 1px `--primary` edge at 60%, a pill, `px-2.5 py-0.5`. No icon, sentence case. One per card that holds figures; a card with none (a sign-in card, a form) has no tag. One per card, in its top-right corner: at the right of the header's row, after the meta, when the card opens with a `CardHeader`; otherwise in a line of its own at the top right, tucked into the content's top padding. Its words are its screen-reader name. Wording by context:
   - app, plan, risk, charts, Bearing: "Sample figures";
   - test network (`"provenance": "sandbox"`): "Test network" / "Rede de teste";
   - never "MOCK", never "demo", never a status hue, never chalk.

   Lines that stay as text inside the card, never on a hatch: the buy card on a test network, "Test network · Solana · not live" (gates `BUY-STEPS`, `DEPOSIT-IN-PLACE`); the landing's cases, "sample rates, not live"; a whole mocked panel or the embed, the quiet line `SampleNote` (Inter 400, `text-sample-line`, muted).
3. **The figure's mark**: every sample yield, price or FX figure keeps the hatched pin ([provenance-pin.md](./provenance-pin.md) sample state, `aria-label="Source for 5.20%, sample figure"`). A sample figure that carries no pin (a count, an amount with no source line) gets the 12 × 12 hatched glyph `<SampleGlyph>` (`viewBox 0 0 12 12`, outline `rx 2` in `--tf-pin-outline`, 45° hatch at 3px pitch in `--tf-hatch`, `role="img" aria-label="sample figure"`).

## Placements

| Placement | Treatment |
|---|---|
| `card` (goal card, plan panel, buy / funding card, vault card) | one quiet tag in the top-right corner, figures with hatched pins; no hatched edge, no foot line (Oct 13) |
| Bearing tile | 6px hatched left edge + the line in the b-meta slot ([bearing-heatmap-tile.md](./bearing-heatmap-tile.md)) |
| `frame` (whole mocked panel or showcase case) | outer 1px border at the card radius (10px), 8px hatched margin, inner solid `--card` surface; the line in the pane foot ("sample rates, not live") |
| `row` (table row / plan leg) | 6px hatched band at the row's left edge; the row's figures keep the hatched pin; the status cell carries the line |
| `inline` (a figure alone, e.g. in prose) | hatched pin or hatched glyph only; the nearest card carries the line |
| `code` (API docs example) | hatched gutter + `"provenance": "mock"` (or `"sandbox"`) highlighted; the caption says "Sample response" |
| Embed | same shape in `--embed-muted` on `--embed-bg`: a card's tag or the shell's line in `e-small`, hatched pins |

## States

There is no hover, active or dismiss state. The tag and the line are not interactive. If the whole view is a simulation (landing showcase, simulator), each card carries its own tag; a page-level notice does not replace per-card tags. A stale plate or tile uses the 6px hatched band with "stale · 3 h" (a stale figure inline uses the hollow pin, not an edge).

## Accessibility

- The tag is real text, read by screen readers, once per card. The hatched pin and glyph carry `aria-label="sample figure"` (or ", sample figure, test network" on the pin's button), so a figure is never announced as live.
- Ink on the honey tint, the overview plate's own pair: about 15.2:1 by day (#15161C on #F7EAD6) and 13.6:1 by night (#F3F1EC on #2D2318), so the tag passes AA at 12px. Ink on muted-l strokes is about 3.2:1, which is why text never sits on the hatch.
- Hatch is `aria-hidden` (CSS background). Forced-colors: the hatch disappears, a band becomes a 1px dashed `CanvasText` rule, and the tag keeps its border and words.

## Enforcement

A DOM test in `apps/web` fails if:
- an element with `.tf-hatch` has no words in the same component subtree (a card's tag, a panel's line, a glyph's name, or a stale line): **hatch never without its words** (`components/ui/test/hatch.ts`);
- any API payload with `provenance !== "live"` renders a figure without a hatched pin or `<SampleGlyph>`, or a card without its tag; a live card renders with one (`Card.test.ts` and the screens' tests);
- `provenance === "sandbox"` renders without the words "Test network" (or "Rede de teste");
- **any element's text content is exactly "MOCK"** (gate MOCK-QUIET).

## Code hint

```tsx
// a screen hands the words; the card draws the tag (components/ui/Card.tsx)
<Card mock={provenance !== 'live'} mockLabels={{ announce: provenance === 'sandbox' ? t.shell.testNetworkLine : t.shell.mockAnnounce }}>
  <CardHeader title="Kamino USDC" meta="Solana" />   {/* the tag sits after the meta */}
  <CardBody>…</CardBody>
</Card>

// the tag (components/ui/internal/mock-parts.tsx)
<span data-ui="sample-tag" className="inline-flex shrink-0 items-center rounded-full border border-primary/60 bg-honey-tint px-2.5 py-0.5 text-caption font-medium text-foreground">Test network</span>
```

## Do / don't

| Do | Don't |
|---|---|
| One tag per card with figures, top right, as the overview's plate | A boxed MOCK, a stamp, a hatched card edge, a tag in a status hue, a tag on a card with no figure |
| "Sample figures" or "Test network" in Inter, muted | "MOCK" in Plex Mono, uppercase, anywhere a person reads |
| Hatched pin or hatched glyph on every sample figure, named "sample figure" | A solid pin, or no mark, on a sample figure |
| Hatch only for sample or stale, each with its words | Hatch as decoration, a section divider, an empty-state fill or a "no data" cell |
| Muted strokes; the tag on the honey tint, as the overview's plate | Clay, chalk or yellow styling for sample |
