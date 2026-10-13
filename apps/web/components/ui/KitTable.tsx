import type { ReactNode } from 'react';
import { cn } from './cn';

// The house kit's table (STYLE.md, "The house kit"), as the portfolio overview's list of vaults draws
// it: across its panel, small muted heads, a hairline over each row, right-aligned tabular figures,
// a row that tints when pointed at or focused. A row that opens something puts its link's box over
// the row (`after:absolute after:inset-0`); a cell with a pin sits over that box (`KIT_PINNED`).

/** The table, in its scrolling box. `minWidth` keeps its columns apart on a narrow screen. */
export function KitTable({
  ui,
  minWidth = 'min-w-[760px]',
  head,
  children,
  caption,
}: {
  ui?: string;
  minWidth?: string;
  /** The head's cells (`KitTh`). */
  head: ReactNode;
  /** The rows (`KitTr`). */
  children: ReactNode;
  /** The table's name, for a screen reader. */
  caption?: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table data-ui={ui} className={cn('w-full border-collapse text-body-sm', minWidth)}>
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead className="text-left text-caption text-muted-foreground">
          <tr>{head}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** A head cell: muted, small; `numeric` puts it over a column of figures. */
export function KitTh({
  children,
  numeric = false,
  className,
}: {
  children: ReactNode;
  numeric?: boolean;
  className?: string;
}) {
  return (
    <th scope="col" className={cn('px-5 py-3 font-medium', numeric && 'text-right', className)}>
      {children}
    </th>
  );
}

/** A row: a hairline over it, a tint when pointed at or focused. */
export const KIT_ROW = 'relative border-t border-border focus-within:bg-muted/60 hover:bg-muted/60';
/** A cell. */
export const KIT_CELL = 'px-5 py-4';
/** A cell of figures: right-aligned, tabular, over the row's link so its pin opens. */
export const KIT_PINNED = 'relative z-10 text-right tabular-nums';
