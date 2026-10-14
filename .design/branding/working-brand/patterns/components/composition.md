# Composition (a strip and a table, on the house kit)
> Type: custom | Component: `<Composition>` (`apps/web/features/shared/Composition.tsx`) | Added 2026-10-13 on `WEIGHTS-RING`, built on the house kit (`HOUSE-KIT`, [house-kit.md](./house-kit.md)) | Replaces, for what a vault or portfolio holds: the plan-leg bar with a legend under it and a bar per row

What a vault or a portfolio holds is one slim strip of its shares and one table, in the language of the portfolio overview: inside a `Panel`, under its `PanelHead`, the table across the panel's width. No ring, no legend, no bar per row. Thom rejected in turn a bar with a legend and progress bars, a ring with legend squares, a thick ring with logos and a calm roomy list ("not optimized for desktop"); this is the institutional version he kept ("better, keep going on this path").

## The strip

8px, a segment per holding by its share, pill-rounded, a 2px ground gap, within the panel's margin. A 0.5% holding keeps a 4px segment. One holding draws no strip. Segments light and dim with their rows.

## The table

The kit's table (`KitTable` measures): small muted heads, a hairline over each row, cells 20 by 16px, figures right-aligned and tabular, scrolled sideways rather than squeezed where the panel is narrower than its columns.

- **Asset**: the logo (AssetMark; a dot of the holding's colour where there is none), the name, and a muted line under it: the venue, or on the vault page the amount, rounded to read and exact one hover away, and under it why the holding is there, in full (the vault's pane is narrow, so the reason is never a column there).
- **Weight**: the share, with a 48px bar of the holding's colour beside it, as long as its share against the largest. This bar is what ties a row to its segment.
- **The caller's columns**, before or after the weight, each only where some holding has the figure:
  - shared portfolio and a plan: Type (the asset's class; a dash where the server sent none, never "Other"), Amount, Yield after haircut (pin), Exit cost (Bearing's figure with its pin, or "Not measured"), Why;
  - vault page: Price (pin), Value (pin).
- **Why**: one short muted line, cut to the column, the whole of it one hover, focus or tap away. On a plan, the line's deciding reason, and nothing where the server sent no kind for the asset; on a vault (under the amount), what the server holds (`why` on GET /v1/vaults/{chain}/{address}): the followed portfolio's asset kind, the plan's deciding reason, or the owner's stored choice; cash "Kept as cash" where its target is above 0; nothing invented.

## Before and after

Where shares move (a vault off its targets, the signing review), two strips, the earlier over the later, labelled on the left ("Planned" / "Share now", "Now" / "After"), and two more columns: the share before, and the change, either signed and coloured by direction (leaf up, madder down) or, on the vault page, a status pill ("On target", "Drift +2%"). A vault on its targets shows one strip and no comparison columns; the panel's head says "Planned · On target" once.

## On a card in a list

The strip, then the three largest holdings, one line each (logo, name, share), and "and N more". Nothing in it is a control where the card is a link (`still`).

## In a narrow box

Under 32rem the table folds into rows: the asset on the left, the weight on the right, every other figure under them, each with its column's name.

## Pointing and focus

Pointing at a row, or focusing its logo, lights its segment and dims the others to 30%; the row takes the honey tint. Pointing at a segment does the same. Pressing a logo keeps it lit until pressed again (`aria-pressed`).

## Accessibility

The strip is one `role="img"` with the whole composition in its label; the comparison's strips are hidden from a screen reader, whose rows say before, after and the difference. The table has a caption and row headers. Axe passes in light and dark at 375px, with no sideways scroll of the page.

## Sample data

On these panels the figures that are not live are said by the kit's `Plate` in the panel's head ("Sample figures", "Test network"), as on the portfolio overview; a sample holding's segment is hatched.

## Where it is used

The shared portfolio's page and a plan on Invest (`PlanView`: a board panel with the answer as its hero and the figures under it, then the Holdings panel; on a shared portfolio the chain's badge labels the answer, and where no holding's kind is known the answer is the portfolio's name), the vault page's holdings (and the targets of an empty vault), the shelf's cards and the vault cards of a portfolio page, Invest and the portfolio (compact), the draft on `/goal` (before and after when it changes a vault's targets) and its deposit step, the monitor's plan parts, and the exposure page's shares. The signing flow's review uses the before-and-after mode.
