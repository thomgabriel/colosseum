# The house kit (panels, figures and the table)
> Type: custom | Components: `<Panel>`, `<PanelHead>`, `<HeroFigure>`, `<StatGrid>` / `<PanelStat>`, `<Plate>` (`apps/web/components/ui/Panel.tsx`), `<KitTable>` / `<KitTh>` and the row classes (`KitTable.tsx`) | Added 2026-10-13 on `HOUSE-KIT` (docs/GATES.md, Thom)

The one way to build a screen: the pieces of Rodrigo's portfolio overview (`features/portfolio-section/OverviewPage.tsx`), taken out as they are. The overview is drawn with them, and looks as it did before (its screenshots at 1440 and 375, light and dark, compared pixel for pixel). A screen that needs a piece the kit does not have adds it to the kit; it does not style its own.

## Pieces

| Piece | What it is | As drawn |
|---|---|---|
| `Panel` | A wide panel: the overview's board, its list of vaults | `rounded-xl`, 1px `--border`, `--card`, no shadow, overflow hidden |
| `PanelHead` | A panel's head: an icon tile and a title, the panel's figures in one line, its actions on the right | icon tile 32px `rounded-lg` on the honey tint; title Inter 600 `text-body-lg`; each figure a muted label then the figure; actions pushed right; a hairline under it; 20px by 16px |
| `HeroFigure` | The figure a panel leads with | a muted `text-body-sm` label over it, Inter Tight 600 at 2rem, tabular; the `Plate` on the right of the label |
| `StatGrid` / `PanelStat` | Small figures, a muted label over each | two columns, 24px by 16px apart; label `text-caption` muted, figure Inter 500 `text-body`, tabular |
| `Plate` | The quiet pill that says the figures are not live | honey edge at 60% on its tint, ink text, `text-caption` |
| `KitTable`, `KitTh`, `KIT_ROW`, `KIT_CELL`, `KIT_PINNED` | The table a panel holds | across the panel, in a scrolling box with a minimum width; small muted heads; a hairline over each row; cells 20px by 16px; figures right-aligned and tabular, over the row's link so a pin opens; a row tints on hover and focus |

Pins, status pills (`Status`), chain chips (`ChainBadge`) and `ProvenancePin` sit in these as they do on the overview.
