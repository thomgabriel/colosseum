import type { ReactNode } from 'react';
import { cn } from './cn';

// The house kit's table (STYLE.md, "The house kit"), as the portfolio overview's list of vaults draws
// it: across its panel, small muted heads, a hairline over each row, right-aligned tabular figures,
// a row that tints when pointed at or focused. A row that opens something puts its link's box over
// the row (`KIT_ROW_LINK`); a cell with a pin sits over that box (`KIT_ABOVE_LINK`).

/** What names the table for a screen reader: a caption, a label, or the id of the heading over it. */
export type KitTableName =
  | { caption: string; label?: never; labelledBy?: never }
  | { label: string; caption?: never; labelledBy?: never }
  | { labelledBy: string; caption?: never; label?: never };

/**
 * The table, in its scrolling box. `minWidth` keeps its columns apart on a narrow screen. It is always
 * named: by a caption, a label, or the heading over it.
 */
export function KitTable({
  ui,
  minWidth = 'min-w-[760px]',
  head,
  children,
  ...name
}: {
  ui?: string;
  minWidth?: string;
  /** The head's cells (`KitTh`). */
  head: ReactNode;
  /** The rows (`KitTr`). */
  children: ReactNode;
} & KitTableName) {
  return (
    <div className="overflow-x-auto">
      <table
        data-ui={ui}
        aria-label={name.label}
        aria-labelledby={name.labelledBy}
        className={cn('w-full border-collapse text-body-sm', minWidth)}
      >
        {name.caption && <caption className="sr-only">{name.caption}</caption>}
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
/** A cell of figures: right-aligned and tabular. */
export const KIT_NUMERIC = 'text-right tabular-nums';
/**
 * A row that opens something: its one link, whose box is stretched over the whole row. Every control
 * in the row (a pin, a copy button) sits over it with `KIT_ABOVE_LINK`, so it opens and not the link.
 */
export const KIT_ROW_LINK = 'after:absolute after:inset-0';
/** A cell, or a control, over a row's stretched link. */
export const KIT_ABOVE_LINK = 'relative z-10';
