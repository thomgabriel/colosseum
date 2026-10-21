'use client';
import { Fragment, type ReactNode, useId, useState } from 'react';
import { cn } from '../../components/ui/cn';
import { KIT_CELL, KIT_ROW } from '../../components/ui/KitTable';
import { Status } from '../../components/ui/StatusMark';
import { LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { formatBps } from '../order/amounts';
import { AssetMark } from '../order/PlanView';
import { coloursOf, colourVar } from './composition-colours';

// What a vault or a portfolio holds (gate WEIGHTS-RING, Thom, Oct 13 2026; composition.md), in the
// language of the portfolio overview (features/portfolio-section/OverviewPage.tsx): one slim strip of
// the shares across the width, then a table, a row a holding, its figures right-aligned in tabular
// figures. The first column is the asset (logo, name, a muted line under it); the weight column writes
// the share with a short bar of the holding's colour beside it, which is what ties a row to its segment;
// the caller adds its own columns before or after the weight (type, value, yield with its pin, exit
// cost). A comparison (now and after, planned and now) is two strips, one over the other, and two more
// columns: the share before and the signed difference. Pointing at a row or focusing its logo lights its
// segment and dims the rest; pointing at a segment lights its row. In a narrow box the table folds into
// rows: a table of the share alone under 32rem, the asset on the left and the share on the right; a
// table with more columns under 40rem (56rem with four figures or more), the asset and its line on top
// and the figures in a row under it, each under its column's name (FOLD). On a card in a list (`compact`) there is no table: the strip and a
// short list.

export type CompositionItem = {
  key: string;
  /** "SPY". */
  name: string;
  /** Where it is held or what it is, muted under the name: "xStocks", "Jupiter Lend". */
  venue?: string;
  /** The asset id, for its logo. Left out, a dot of its colour. */
  asset?: string;
  /** Cash takes the neutral colour, wherever it comes in the list. */
  cash?: boolean;
  /** Sample data: the segment is hatched. The card that holds it says so once (MOCK-QUIET). */
  mock?: boolean;
  /** The share, in basis points: in a comparison, the share after. */
  bps: number;
  /** The share as written, where the caller rounds the shares together; the strip still takes `bps`. */
  label?: string;
  /** In a comparison, the share before. Left out, the holding is new. */
  beforeBps?: number;
  /**
   * The share is not known (a holding with no price): a dash in its place, this sentence for a screen
   * reader, nothing drawn and no difference. The row stays in the list.
   */
  unknown?: string;
  /** Kept in the list at a share of nothing: a holding there is still an amount of. Nothing is drawn. */
  listed?: boolean;
  /** Under the name, in place of the venue: an amount. */
  detail?: ReactNode;
  /** The caller's cells, by column key. */
  cells?: Record<string, ReactNode>;
};

export type CompositionColumn = {
  key: string;
  header: string;
  /** Before the weight column, or after it (the default). */
  place?: 'before' | 'after';
  /** Right-aligned, tabular: a figure. */
  numeric?: boolean;
  /**
   * Words that need room (why a holding is there): drawn where the table is 52rem wide or more, and
   * under the row's figures where it folds into rows; between, left out rather than cut at the
   * panel's edge.
   * The caller says them in full elsewhere (the plan's fold).
   */
  roomy?: boolean;
};

export type CompositionProps = {
  items: readonly CompositionItem[];
  /** One composition, or two, before over after. (`ring` is an old name of `single`.) */
  mode?: 'single' | 'ring' | 'compare';
  /** A share as the rows write it. Left out, a percent with up to two decimals. */
  share?: (bps: number) => string;
  /**
   * A signed difference as the change column writes it: "+2 pp" where the shares are targets. Left
   * out, a percent with up to two decimals and its sign.
   */
  signed?: (bps: number) => string;
  /** The caller's columns. */
  columns?: readonly CompositionColumn[];
  labels?: {
    /** The table's name, for a screen reader. */
    caption?: string;
    /** The first column's head: "Asset". */
    asset?: string;
    /** The weight column's head: "Weight", "Share now". */
    weight?: string;
    /** The top strip, and the head of the column of the share before: "Now", "Planned". */
    before?: string;
    /** The bottom strip: "After", "Now". */
    after?: string;
    /** The head of the column of the difference: "Change", "Drift". */
    change?: string;
    /** The signed difference, said whole for a screen reader: "+2% against its target". */
    difference?: (signed: string) => string;
    /** Where the two shares are the same: "unchanged", "on target". Empty, a dash. */
    unchanged?: string;
    /** The drift as the status pill writes it: "Drift +2%". */
    drift?: (signed: string) => string;
  };
  /** How the change column says it: the signed difference coloured by direction, or a status pill. */
  changeAs?: 'delta' | 'status';
  /** A card in a list shows this many of the largest holdings, and how many more there are. */
  top?: number;
  /** In a comparison, both strips (the default), or the one after where nothing has moved. */
  strips?: 'one' | 'two';
  /** A card in a list: the strip and a short list, no table. */
  size?: 'default' | 'compact';
  /**
   * A picture to read, not to point at: no row is a control and nothing lights. For a card that is
   * itself one link, where a control inside it would be a second one.
   */
  still?: boolean;
  /**
   * Where a table with more than the share folds into rows: under 40rem (`wide`, the default), or
   * under 56rem (`wider`) for a table too wide for 40rem, as a vault's holdings off their targets.
   * A table of the share alone keeps its own fold.
   */
  fold?: 'wide' | 'wider';
  className?: string;
};

/** A name as the app writes it, "syrupUSDC (Maple)", as the list sets it: the name, then the venue. */
export function withVenue(display: string): { name: string; venue?: string } {
  const m = /^(.*\S)\s+\(([^()]+)\)$/.exec(display);
  return m?.[1] && m[2] ? { name: m[1], venue: m[2] } : { name: display };
}

const FADE =
  'transition-opacity duration-(--tf-dur-fade) motion-reduce:transition-none data-dim:opacity-30';
const FIGURE = 'text-right tabular-nums';

/**
 * Where the table folds into rows, and how. A table of the share alone folds under the kit's @lg
 * (32rem): the asset on the left, its share on the right (#326). A table with more columns folds where
 * they no longer fit (a vault's holdings were 607px wide in a 546px box beside the chat at 1024, to be
 * scrolled to): under 40rem, or under 56rem where the caller asks for it (`fold="wider"`: a vault off
 * its targets needs about 52rem for its five figures). Folded, the asset and its line run across the row and
 * the figures sit in a row under it, each under its column's name, wrapping where they run out of
 * room. Spelled out whole, so Tailwind finds every class.
 */
const FOLD = {
  share: {
    table: '@lg:min-w-max',
    head: '@max-lg:sr-only',
    cell: '@max-lg:p-0',
    row: '@max-lg:grid @max-lg:grid-cols-[minmax(0,1fr)_auto] @max-lg:gap-x-3 @max-lg:gap-y-1 @max-lg:px-5 @max-lg:py-3',
    asset: '',
    sub: '',
    weight: '@max-lg:self-center',
    bar: '@lg:block',
    figure: '',
    label: '',
    said: 'sr-only',
    roomy: '',
    roomyHead: '',
  },
  wide: {
    table: '@min-[40rem]:min-w-max',
    head: '@max-[40rem]:sr-only',
    cell: '@max-[40rem]:p-0',
    row: '@max-[40rem]:flex @max-[40rem]:flex-wrap @max-[40rem]:items-start @max-[40rem]:gap-x-6 @max-[40rem]:gap-y-2 @max-[40rem]:px-5 @max-[40rem]:py-3',
    asset: '@max-[40rem]:basis-full',
    // a reason wraps at a reading width where the table has its columns: never widens it
    sub: '@min-[40rem]:max-w-[32ch]',
    weight: '@max-[40rem]:text-left',
    bar: '@min-[40rem]:block',
    figure: '@max-[40rem]:text-left',
    label: 'hidden text-caption text-muted-foreground @max-[40rem]:block',
    // the share's name for a screen reader, where the row does not draw it
    said: 'sr-only @max-[40rem]:hidden',
    // words that need room: a line of their own when folded, left out from there to a 52rem table
    roomy: '@max-[40rem]:basis-full @min-[40rem]:hidden @min-[52rem]:table-cell',
    roomyHead: '@min-[40rem]:hidden @min-[52rem]:table-cell',
  },
  wider: {
    table: '@min-[56rem]:min-w-max',
    head: '@max-[56rem]:sr-only',
    cell: '@max-[56rem]:p-0',
    row: '@max-[56rem]:flex @max-[56rem]:flex-wrap @max-[56rem]:items-start @max-[56rem]:gap-x-6 @max-[56rem]:gap-y-2 @max-[56rem]:px-5 @max-[56rem]:py-3',
    asset: '@max-[56rem]:basis-full',
    sub: '@min-[56rem]:max-w-[32ch]',
    weight: '@max-[56rem]:text-left',
    bar: '@min-[56rem]:block',
    figure: '@max-[56rem]:text-left',
    label: 'hidden text-caption text-muted-foreground @max-[56rem]:block',
    said: 'sr-only @max-[56rem]:hidden',
    // a 56rem table has room for them
    roomy: '@max-[56rem]:basis-full',
    roomyHead: '',
  },
} as const;
export type Fold = keyof typeof FOLD;

/** Which fold a table takes: the share alone always its own; any other the caller's, else 40rem. */
export function foldOf(
  compare: boolean,
  columns: readonly CompositionColumn[],
  asked?: 'wide' | 'wider',
): Fold {
  if (!compare && columns.length === 0) return 'share';
  return asked ?? 'wide';
}

export function Composition({
  items,
  mode = 'single',
  share: shareOf,
  signed: signedOf,
  columns = [],
  labels,
  size = 'default',
  still = false,
  fold: foldAsked,
  changeAs = 'delta',
  top,
  strips = 'two',
  className,
}: CompositionProps) {
  const t = useT();
  const lang = useLang();
  const c = t.shared.composition;
  const hatchId = `composition-hatch-${useId().replace(/[^\w-]/g, '')}`;
  const [pointed, setPointed] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const lit = pointed ?? chosen;
  const share = shareOf ?? ((bps: number) => formatBps(bps, LOCALE[lang]));
  // signed, to two decimals so a change of one basis point is not written as nothing, a true minus
  const difference =
    signedOf ??
    ((bps: number) =>
      new Intl.NumberFormat(LOCALE[lang], {
        style: 'percent',
        maximumFractionDigits: 2,
        signDisplay: 'exceptZero',
      })
        .format(bps / 10_000)
        .replace(/-/g, '−'));
  const colours = coloursOf(items);
  const fill = (i: number) => {
    const item = items[i];
    return item?.mock ? `url(#${hatchId})` : colourVar(colours[i] ?? 'share-rest');
  };
  const compare = mode === 'compare';
  // the table has the asset and its share and nothing else (a draft's)
  const shareAlone = !compare && columns.length === 0;
  const fold = FOLD[foldOf(compare, columns, foldAsked)];
  const CELL = `${KIT_CELL} ${fold.cell}`;
  // the comparison's two strips, or one: the table still says before and after where they agree
  const two = compare && strips !== 'one';
  const compact = size === 'compact';
  const shown = items.filter((item) => item.bps > 0 || (compare && (item.beforeBps ?? 0) > 0));
  // a holding with no share to draw may still be a row: one with no price, or an amount at nothing
  if (shown.length === 0 && !items.some((item) => item.unknown || item.listed)) return null;

  const before = labels?.before ?? c.before;
  const after = labels?.after ?? c.after;
  const unchanged = labels?.unchanged ?? c.unchanged;
  const point = (key: string | null) => {
    if (!still) setPointed(key);
  };
  const dim = (key: string) => lit !== null && lit !== key;
  const shareText = (item: CompositionItem) => item.label ?? share(item.bps);
  const rows = items
    .map((item, i) => ({ item, i }))
    .filter(
      ({ item }) =>
        item.bps > 0 ||
        (compare && (item.beforeBps ?? 0) > 0) ||
        item.unknown !== undefined ||
        item.listed === true,
    );
  const largest = Math.max(1, ...items.map((item) => item.bps));

  /** One strip: a segment a holding by its share, rounded, the ground between them. */
  const strip = (which: 'before' | 'after') => (
    <div
      data-ui={two ? 'composition-bar' : 'composition-strip'}
      data-bar={two ? which : undefined}
      className="flex h-2 min-w-0 gap-[2px]"
    >
      {items.map((item, i) => {
        const bps = which === 'before' ? (item.beforeBps ?? 0) : item.bps;
        if (bps <= 0) return null;
        return (
          // biome-ignore lint/a11y/noStaticElementInteractions: pointer-only highlight; the row is the control
          <span
            key={item.key}
            data-ui="composition-segment"
            data-key={item.key}
            data-dim={dim(item.key) || undefined}
            onMouseEnter={() => point(item.key)}
            onMouseLeave={() => point(null)}
            className={cn('block h-full min-w-1 rounded-full', FADE)}
            style={{ flex: `${bps} 1 0`, background: fill(i) }}
          />
        );
      })}
    </div>
  );

  const mark = (item: CompositionItem, i: number) => {
    const drawn = (
      <span
        data-part="mark"
        className={cn('grid shrink-0 place-items-center', compact ? 'size-6' : 'size-8')}
      >
        {item.asset ? (
          <AssetMark asset={item.asset} className="size-full" />
        ) : (
          <svg aria-hidden="true" data-part="swatch" viewBox="0 0 12 12" className="size-2.5">
            <circle cx="6" cy="6" r="6" fill={fill(i)} />
          </svg>
        )}
      </span>
    );
    return still ? (
      drawn
    ) : (
      <button
        type="button"
        data-ui="composition-row"
        aria-label={`${item.name}${item.venue ? ` ${item.venue}` : ''}, ${item.unknown ?? shareText(item)}`}
        aria-pressed={chosen === item.key}
        onFocus={() => point(item.key)}
        onBlur={() => point(null)}
        onClick={() => setChosen((now) => (now === item.key ? null : item.key))}
        className="shrink-0 cursor-default rounded-full outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {drawn}
      </button>
    );
  };

  const written = (item: CompositionItem) =>
    item.unknown ? (
      <>
        <span aria-hidden="true">—</span>
        <span className="sr-only">{item.unknown}</span>
      </>
    ) : (
      shareText(item)
    );

  const hatch = (
    <svg aria-hidden="true" className="absolute size-0" focusable="false">
      <defs>
        <pattern
          id={hatchId}
          width="6"
          height="6"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <rect width="6" height="6" fill="var(--card)" />
          <rect width="1" height="6" fill="var(--tf-hatch)" />
        </pattern>
      </defs>
    </svg>
  );

  const pictured = two
    ? shown.length > 0 && (
        <div
          data-ui="composition-bars"
          aria-hidden="true"
          className="grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-3 gap-y-2.5"
        >
          {(['before', 'after'] as const).map((which) => (
            <Fragment key={which}>
              <span className="text-caption text-muted-foreground">
                {which === 'before' ? before : after}
              </span>
              {strip(which)}
            </Fragment>
          ))}
        </div>
      )
    : // a single holding is the whole; a strip of one says nothing
      shown.length > 1 && (
        <div
          role="img"
          aria-label={c.summary(shown.map((item) => `${item.name} ${shareText(item)}`).join(', '))}
        >
          {strip('after')}
        </div>
      );

  // A card in a list: the strip and a short list, the share on the right.
  if (compact)
    return (
      <div
        data-ui="composition"
        data-mode={compare ? 'compare' : 'single'}
        data-lit={lit ?? undefined}
        className={cn('flex min-w-0 flex-col gap-3', className)}
      >
        {hatch}
        {pictured}
        <ul data-ui="composition-list" className="flex min-w-0 flex-col gap-0.5">
          {(top === undefined
            ? rows
            : [...rows].sort((a, b) => b.item.bps - a.item.bps || a.i - b.i).slice(0, top)
          ).map(({ item, i }) => (
            <li
              key={item.key}
              data-row={item.key}
              data-lit={lit === item.key || undefined}
              onMouseEnter={() => point(item.key)}
              onMouseLeave={() => point(null)}
              className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 rounded-lg px-1 py-1 data-lit:bg-accent"
            >
              {mark(item, i)}
              <span data-part="name" className="truncate text-body-sm font-medium">
                {item.name}
              </span>{' '}
              <span data-ui="composition-share" className="text-body-sm font-medium tabular-nums">
                {written(item)}
              </span>
            </li>
          ))}
        </ul>
        {top !== undefined && rows.length > top && (
          <p data-ui="composition-more" className="px-1 text-caption text-muted-foreground">
            {c.more(rows.length - top)}
          </p>
        )}
      </div>
    );

  const beforeColumns = columns.filter((column) => column.place === 'before');
  const afterColumns = columns.filter((column) => column.place !== 'before');
  /** A column's name over its figure in a folded row; the table's head says it otherwise. */
  const label = (text: string) =>
    fold.label ? (
      // seen only; a screen reader has the column's head
      <span aria-hidden="true" data-part="fold-label" className={fold.label}>
        {text}
      </span>
    ) : null;
  /** A caller's cell: in a folded row, its figure under its column's name. */
  const cell = (column: CompositionColumn, item: CompositionItem) => (
    <td
      key={column.key}
      data-column={column.key}
      className={cn(CELL, column.numeric && FIGURE, fold.figure, column.roomy && fold.roomy)}
    >
      {label(column.header)}
      {item.cells?.[column.key] ?? '—'}
    </td>
  );
  const head = (text: string, numeric = false, roomy = false) => (
    <th
      key={text}
      scope="col"
      className={cn(
        'px-5 py-3 font-medium',
        fold.cell,
        numeric && 'text-right',
        roomy && fold.roomyHead,
      )}
    >
      {text}
    </th>
  );
  const weightHead = labels?.weight ?? c.weight;
  const changeHead = labels?.change ?? c.changeHead;

  return (
    <div
      data-ui="composition"
      data-mode={compare ? 'compare' : 'single'}
      data-lit={lit ?? undefined}
      className={cn('@container flex min-w-0 flex-col gap-4', className)}
    >
      {hatch}
      {/* the strip within the panel's margin; the table runs to its edges, as the kit's does */}
      {pictured && <div className="px-5 pt-4">{pictured}</div>}
      {/* as the kit's table: across the panel, and scrolled sideways rather than squeezed where the
          panel is narrower than its columns; folded into rows in a narrow box */}
      <div className="overflow-x-auto overflow-y-hidden">
        <table
          data-ui="composition-table"
          className={cn('w-full border-collapse text-body-sm', fold.table)}
        >
          <caption className="sr-only">{labels?.caption ?? c.caption}</caption>
          <thead className={cn('text-left text-caption text-muted-foreground', fold.head)}>
            <tr>
              {head(labels?.asset ?? c.asset)}
              {beforeColumns.map((column) => head(column.header, column.numeric, column.roomy))}
              {head(weightHead, true)}
              {compare && head(before, true)}
              {compare && head(changeHead, true)}
              {afterColumns.map((column) => head(column.header, column.numeric, column.roomy))}
            </tr>
          </thead>
          <tbody data-ui="composition-list">
            {rows.map(({ item, i }) => {
              const was = item.beforeBps ?? 0;
              const off = item.bps - was;
              const signed = difference(off);
              const said = labels?.difference ? labels.difference(signed) : signed;
              const sub = item.detail ?? item.venue;
              return (
                <tr
                  key={item.key}
                  data-row={item.key}
                  data-lit={lit === item.key || undefined}
                  onMouseEnter={() => point(item.key)}
                  onMouseLeave={() => point(null)}
                  className={cn(
                    KIT_ROW,
                    'transition-colors duration-(--tf-dur-fade) motion-reduce:transition-none data-lit:bg-accent',
                    fold.row,
                  )}
                >
                  <th scope="row" className={cn(CELL, 'text-left font-normal', fold.asset)}>
                    <span className="flex min-w-0 items-center gap-3">
                      {mark(item, i)}
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span data-part="name" className="truncate font-medium">
                          {item.name}
                        </span>
                        {/* In a table of the share alone, a row's reason wraps at a reading width,
                            18rem at least where the table has its columns, and never widens the
                            table past it: a long one pushed the share out of the panel, to be
                            scrolled to (Thom, Oct 15, a vault of SPY alone). In a table with more
                            columns it wraps at 32ch where the table has them, so a draft's long
                            reason cannot widen it either, and across the row where it folds. */}
                        {sub && (
                          <span
                            data-part="sub"
                            className={cn(
                              'text-caption text-muted-foreground',
                              item.detail && shareAlone
                                ? '[contain:inline-size] @lg:min-w-72'
                                : fold.sub || undefined,
                            )}
                          >
                            {sub}
                          </span>
                        )}
                      </span>
                    </span>
                  </th>
                  {beforeColumns.map((column) => cell(column, item))}
                  <td data-column="weight" className={cn(CELL, FIGURE, fold.weight)}>
                    {label(weightHead)}
                    {/* the share, and a short bar of its colour: what ties the row to its segment */}
                    <span className="inline-flex items-center justify-end gap-3">
                      <span
                        aria-hidden="true"
                        data-part="weight-bar"
                        className={cn(
                          'hidden h-1.5 w-12 overflow-hidden rounded-full bg-muted',
                          fold.bar,
                        )}
                      >
                        <span
                          className="block h-full rounded-full"
                          style={{
                            width: `${item.unknown || item.bps <= 0 ? 0 : Math.max(4, (item.bps / largest) * 100)}%`,
                            background: fill(i),
                          }}
                        />
                      </span>
                      {/* folded, the share says its column's name above it */}
                      {compare && <span className={fold.said}>{after}</span>}
                      <span data-ui="composition-share" className="font-medium">
                        {written(item)}
                      </span>
                    </span>
                  </td>
                  {compare && (
                    <td
                      data-column="before"
                      className={cn(CELL, FIGURE, 'text-muted-foreground', fold.figure)}
                    >
                      {label(before)}
                      {was > 0 ? share(was) : c.added}
                    </td>
                  )}
                  {compare && (
                    <td data-column="change" className={cn(CELL, FIGURE, fold.figure)}>
                      {label(changeHead)}
                      {item.unknown ? (
                        '—'
                      ) : changeAs === 'status' ? (
                        // a status pill: on target, or the drift, signed, as the overview's rows say status
                        <Status
                          status={off === 0 ? 'on-track' : 'watch'}
                          className="whitespace-nowrap"
                        >
                          {off === 0 ? (
                            unchanged
                          ) : (
                            <span
                              data-ui="composition-delta"
                              data-direction={off > 0 ? 'up' : 'down'}
                              className="tabular-nums"
                            >
                              <span aria-hidden="true">{labels?.drift?.(signed) ?? signed}</span>
                              <span className="sr-only">{said}</span>
                            </span>
                          )}
                        </Status>
                      ) : off === 0 ? (
                        <span className="text-muted-foreground">{unchanged || '—'}</span>
                      ) : (
                        <span
                          data-ui="composition-delta"
                          data-direction={off > 0 ? 'up' : 'down'}
                          className={cn('font-medium', off > 0 ? 'text-leaf' : 'text-madder')}
                        >
                          <span aria-hidden="true">{signed}</span>
                          <span className="sr-only">{said}</span>
                        </span>
                      )}
                    </td>
                  )}
                  {afterColumns.map((column) => cell(column, item))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
