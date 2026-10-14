import type { ReactNode } from 'react';
import { cn } from './cn';

// The house kit (STYLE.md, "The house kit"): the pieces Rodrigo's portfolio overview is built from
// (features/portfolio-section/OverviewPage.tsx), taken out so every screen is built the same way. A
// wide rounded panel; its head, with an icon tile, a title, the panel's figures in one line and its
// actions on the right; a hero figure with its label over it; a grid of small figures, a muted label
// over each; the quiet pill that says a figure is not live; and the table the panels hold (KitTable).

/** A wide rounded panel: the overview's board and its list of vaults. */
export function Panel({
  as: Tag = 'section',
  className,
  children,
  ...rest
}: {
  as?: 'section' | 'div' | 'article';
  className?: string;
  children: ReactNode;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'data-ui'?: string;
  'data-provenance'?: string;
}) {
  return (
    <Tag
      {...rest}
      className={cn(
        'overflow-hidden rounded-xl border border-border bg-card text-card-foreground',
        className,
      )}
    >
      {children}
    </Tag>
  );
}

/** A panel's section: its margin, its pieces 16px apart. `className` adds to it (a hairline over it). */
export function PanelBody({
  className,
  children,
  ui,
}: {
  className?: string;
  children: ReactNode;
  ui?: string;
}) {
  return (
    <div data-ui={ui} className={cn('flex flex-col gap-4 p-5', className)}>
      {children}
    </div>
  );
}

/** A figure of a panel's head, in one line: its label muted, then the figure. */
export type HeadStat = { label: string; value: ReactNode; ui?: string };

/** A panel's head: an icon tile and a title, its figures in one line, its actions on the right. */
export function PanelHead({
  id,
  icon,
  title,
  stats = [],
  actions,
  tabs,
  level = 2,
  className,
}: {
  id?: string;
  icon?: ReactNode;
  title: ReactNode;
  stats?: readonly HeadStat[];
  actions?: ReactNode;
  /**
   * Tabs that say what the panel is (Deposit | Withdraw): drawn in the title's place, the title then
   * read by screen readers alone, so the head does not say the same thing twice.
   */
  tabs?: ReactNode;
  level?: 2 | 3;
  className?: string;
}) {
  const Title = `h${level}` as 'h2' | 'h3';
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-border px-5 py-4',
        className,
      )}
    >
      <Title
        id={id}
        className={cn(
          'flex items-center gap-2.5 text-body-lg font-semibold whitespace-nowrap',
          tabs !== undefined && 'sr-only',
        )}
      >
        {icon && (
          <span className="inline-flex size-8 items-center justify-center rounded-lg bg-honey-tint text-foreground">
            {icon}
          </span>
        )}
        {title}
      </Title>
      {tabs}
      {stats.map((stat) => (
        <p key={stat.label} data-ui={stat.ui} className="flex items-baseline gap-2 text-body-sm">
          <span className="text-muted-foreground">{stat.label}</span>
          {stat.value}
        </p>
      ))}
      {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
    </div>
  );
}

/** The figure a panel leads with: a muted label over it, and the quiet pill beside the label. */
export function HeroFigure({
  label,
  plate,
  ui,
  children,
}: {
  label: ReactNode;
  /** Beside the label, on the right: the pill that says the figures are not live. */
  plate?: ReactNode;
  ui?: string;
  children: ReactNode;
}) {
  return (
    <div data-ui="hero-figure" className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-3">
        <div className="text-body-sm text-muted-foreground">{label}</div>
        {plate}
      </div>
      <p
        data-ui={ui}
        className="font-display text-[2rem]/10 font-semibold tracking-[-0.02em] tabular-nums"
      >
        {children}
      </p>
    </div>
  );
}

/** A small figure, its label over it: one cell of a StatGrid (Card has its own `Stat`, for a card). */
export function PanelStat({
  label,
  children,
  ui,
  wide = false,
}: {
  label: string;
  children: ReactNode;
  ui?: string;
  /** Across both columns: a figure too long for one (an address). */
  wide?: boolean;
}) {
  return (
    <div data-ui={ui} className={cn('flex min-w-0 flex-col gap-1', wide && 'col-span-2')}>
      <dt className="text-caption text-muted-foreground">{label}</dt>
      <dd className="m-0 text-body font-medium tabular-nums">{children}</dd>
    </div>
  );
}

/**
 * Small figures in a grid, two columns, as the overview's board has them. `spacing` is the grid's gap,
 * in place of the board's own.
 */
export function StatGrid({ spacing, children }: { spacing?: string; children: ReactNode }) {
  return <dl className={cn('m-0 grid grid-cols-2', spacing ?? 'gap-x-6 gap-y-4')}>{children}</dl>;
}

/** The quiet pill's look, shared with a sample card's tag (`Card mock`), so the two are one mark. */
export const PLATE =
  'rounded-full border border-primary/60 bg-honey-tint px-2.5 py-0.5 text-caption font-medium text-foreground';

/**
 * The quiet pill: honey edge on its tint, ink text. Says, in words, that figures are not live. A
 * panel's sample mark is `ui="sample-tag"`, the hook a sample card's tag has (MOCK-QUIET).
 */
export function Plate({ children, ui }: { children: ReactNode; ui?: string }) {
  return (
    <span data-ui={ui} className={PLATE}>
      {children}
    </span>
  );
}
