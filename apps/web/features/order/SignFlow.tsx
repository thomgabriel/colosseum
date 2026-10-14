'use client';
import type { ReactNode } from 'react';
import { cn } from '../../components/ui/cn';
import { ExplorerLink, type ExplorerLinkLabels } from '../../components/ui/ExplorerLink';
import { Hint } from '../../components/ui/Hint';
import { Icon } from '../../components/ui/Icon';
import { KIT_CELL, KIT_NUMERIC, KIT_ROW, KitTable, KitTh } from '../../components/ui/KitTable';
import { HeroFigure, PanelStat, Plate, StatGrid } from '../../components/ui/Panel';
import { Composition } from '../shared/Composition';
import type { Figure, Picture, ShareItem } from './order-summary';
import { AssetMark } from './PlanView';

// The parts of the order screen, one screen at a time (gate SIGN-ONE-STEP), in the calm of the
// portfolio's overview: one large line a screen, a quiet strip that says where the person is, short
// rows with no rules between them, and the exact figures one fold away. Nothing here decides what is
// signed: the order's screen (OrderScreen.tsx) hands each part its words.

/**
 * The line a screen leads with, as the house kit's HeroFigure (HOUSE-KIT): a muted label over one
 * large figure, the quiet pill beside the label where the figures are not live. It takes the focus
 * where a screen replaced another.
 */
export function OrderHero({
  label,
  figure,
  plate,
}: {
  label: ReactNode;
  figure: ReactNode;
  /** "Test network · Solana · not live", "Sample figures": said once, beside the label. */
  plate?: { text: string; ui: string } | null;
}) {
  return (
    <div data-ui="sign-hero" tabIndex={-1} className="outline-none">
      <HeroFigure
        label={<span data-ui="sign-label">{label}</span>}
        ui="sign-figure"
        plate={plate ? <Plate ui={plate.ui}>{plate.text}</Plate> : undefined}
      >
        <span className="text-balance [overflow-wrap:anywhere]">{figure}</span>
      </HeroFigure>
    </div>
  );
}

/** Small figures under the line a screen leads with, a muted label over each. */
export function OrderStats({
  stats,
}: {
  stats: readonly { label: string; value: ReactNode; ui?: string }[];
}) {
  if (stats.length === 0) return null;
  return (
    // more than two in one row on a wide screen: the review fits its pane without a scroll
    <StatGrid columns={stats.length > 2 ? 4 : 2}>
      {stats.map((stat) => (
        <PanelStat key={stat.label} label={stat.label} ui={stat.ui}>
          {stat.value}
        </PanelStat>
      ))}
    </StatGrid>
  );
}

/**
 * Where the person is: each step's short name, then "Done". Steps before `at` are done, a skipped
 * one is marked so and never as done; `at` is the one under way, or the last place once every step
 * is. On a phone only that one is named.
 */
export function StepStrip({
  names,
  at,
  label,
  doneWord,
  skipped = [],
  skippedWord,
}: {
  names: readonly string[];
  at: number;
  label: string;
  doneWord: string;
  /** Places of steps that were skipped: they moved nothing. */
  skipped?: readonly number[];
  skippedWord?: string;
}) {
  return (
    <ol
      data-ui="sign-progress"
      aria-label={label}
      className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-caption text-muted-foreground"
    >
      {names.map((name, i) => {
        const missed = skipped.includes(i);
        const done = !missed && (i < at || (i === at && i === names.length - 1));
        const current = i === at;
        return (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: the strip is the order's steps, in order
            key={i}
            data-done={done}
            data-skipped={missed || undefined}
            aria-current={current ? 'step' : undefined}
            className={cn('inline-flex items-center gap-1.5', current && 'text-foreground')}
          >
            {i > 0 && (
              <span aria-hidden="true" className="px-0.5">
                ·
              </span>
            )}
            <span
              aria-hidden="true"
              className={cn(
                'inline-grid size-4 shrink-0 place-items-center rounded-full font-mono text-[10px]/none',
                done
                  ? 'bg-primary text-primary-foreground'
                  : current
                    ? 'border border-foreground'
                    : 'border border-input',
              )}
            >
              {done ? <Icon name="Check" size={16} className="size-3" /> : missed ? '–' : i + 1}
            </span>
            <span className={cn(current ? 'font-medium' : 'max-sm:sr-only')}>{name}</span>
            {done && <span className="sr-only">, {doneWord}</span>}
            {missed && skippedWord && <span className="sr-only">, {skippedWord}</span>}
          </li>
        );
      })}
    </ol>
  );
}

/** A figure read rounded, with its exact value one hover, focus or tap away. */
export function Rounded({ figure }: { figure: Figure }) {
  if (figure.shown === figure.exact) return <span className="tabular-nums">{figure.shown}</span>;
  return (
    <Hint tip={<span className="tabular-nums">{figure.exact}</span>}>
      <span className="tabular-nums">{figure.shown}</span>
    </Hint>
  );
}

/**
 * The kit's table inside a host's padding, a panel's or a card's: its outer cells lose theirs, so its
 * names and figures line up with the rest of the screen whatever the host pads with. On a phone the
 * cells between sit closer, so four columns fit with nothing to scroll.
 */
const FLUSH = cn(
  '[&_td:first-child]:pl-0 [&_td:last-child]:pr-0 [&_th:first-child]:pl-0 [&_th:last-child]:pr-0',
  'max-sm:[&_td]:px-2 max-sm:[&_th]:px-2',
);

/** A holding's name in a table row: its mark, then its name. */
function Holding({ name, asset }: { name: string; asset?: string }) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      {asset ? (
        <AssetMark asset={asset} />
      ) : (
        <span aria-hidden="true" className="inline-block size-6 shrink-0 rounded-full bg-muted" />
      )}
      <span className="min-w-0 truncate font-medium">{name}</span>
    </span>
  );
}

/**
 * What a vault aims at before and after, as the shared composition draws it (gate WEIGHTS-RING, mode
 * "compare"): the two strips, then a row a holding with its share after, its share before and the move
 * in points. Where nothing before is known, one composition. It runs to the panel's edges, as the kit's
 * table does: the hosts pad by the panel's 20px.
 */
export function ShareList({
  caption,
  items,
  share,
  labels,
}: {
  caption: string;
  items: readonly ShareItem[];
  share: (bps: number) => string;
  labels: {
    before: string;
    after: string;
    unchanged: string;
    holding: string;
    change: string;
    /** A move of a share, unsigned, in percentage points: "10 pp". */
    points: (bps: number) => string;
  };
}) {
  const compare = items.some((item) => item.beforeBps !== undefined);
  // a move is said in points, never as a share of a share; one too small to show whole is still a move
  const signed = (bps: number) =>
    `${bps > 0 ? '+' : '\u2212'}${labels.points(Math.abs(bps)) === labels.points(0) ? `<${labels.points(100)}` : labels.points(Math.abs(bps))}`;
  return (
    // the composition pads its strips for a panel's head; in the body, the body's own gap spaces it
    <div data-ui="sign-picture" className="-mx-5 -mt-4">
      <Composition
        mode={compare ? 'compare' : 'single'}
        items={items}
        share={share}
        signed={signed}
        labels={{
          caption,
          asset: labels.holding,
          weight: labels.after,
          before: labels.before,
          after: labels.after,
          change: labels.change,
          unchanged: labels.unchanged,
        }}
      />
    </div>
  );
}

/** Where an amount goes or what leaves, as the house kit's table: the holding, and its amount. */
export function AmountList({
  picture,
  labels,
}: {
  picture: Picture;
  labels: { holding: string; amount: string };
}) {
  return (
    <div data-ui="sign-picture" className={FLUSH}>
      <KitTable
        caption={picture.caption}
        minWidth="min-w-0"
        head={
          <>
            <KitTh>{labels.holding}</KitTh>
            <KitTh numeric>{labels.amount}</KitTh>
          </>
        }
      >
        {picture.rows.map((row) => {
          const figure = row.cells[row.cells.length - 1];
          return (
            <tr key={row.key} data-ui="sign-share" className={KIT_ROW}>
              <td className={KIT_CELL}>
                <Holding
                  name={row.name}
                  {...(row.key !== 'cash' && row.key.includes(':') ? { asset: row.key } : {})}
                />
              </td>
              <td className={cn(KIT_CELL, KIT_NUMERIC, 'font-medium')}>
                {figure ? <Rounded figure={figure} /> : '—'}
              </td>
            </tr>
          );
        })}
      </KitTable>
    </div>
  );
}

/** A step already confirmed: its name with a check, and its transaction. */
export type SignedStep = {
  key: string;
  name: string;
  txId: string | null;
  href: string | null;
};

/** The steps confirmed so far, one quiet line each, over the step being signed. */
export function SignedSteps({
  steps,
  label,
  explorer,
  links,
}: {
  steps: readonly SignedStep[];
  label: string;
  explorer: string;
  links: Partial<ExplorerLinkLabels>;
}) {
  if (steps.length === 0) return null;
  return (
    <ul
      data-ui="sign-past"
      aria-label={label}
      className="flex flex-col gap-1 text-body-sm text-muted-foreground"
    >
      {steps.map((step) => (
        <li key={step.key} className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span aria-hidden="true" className="text-status-on">
            <Icon name="Check" size={16} />
          </span>
          <span>{step.name}</span>
          {step.txId && (
            <ExplorerLink
              signature={step.txId}
              href={step.href}
              explorer={explorer}
              labels={links}
            />
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * The step being signed, alone: the line it leads with (what it does, in a figure), what it may give
 * up as small figures under it, where it stands, and the rest. Its place in the order is the strip's,
 * and the screen reader's.
 */
export function StepPanel({
  place,
  label,
  hero,
  stats,
  title,
  plate,
  status,
  children,
}: {
  /** "Step 2 of 3", for a screen reader: the strip shows it. */
  place: string;
  /** Over the figure: what the step is, "Swap". */
  label: string;
  /** "$1,354 → GOOGLx". */
  hero: string;
  /** "At least 3.76 GOOGLx", "Under today's price 1%". */
  stats: readonly { label: string; value: ReactNode; ui?: string }[];
  /** What the step does in a sentence: its name for a screen reader. */
  title: string;
  plate?: { text: string; ui: string } | null;
  /** Where the step stands. Said aloud by the order's one announcer, not here. */
  status: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section data-ui="sign-step" aria-label={title} className="flex flex-col gap-5">
      <p className="sr-only">{place}</p>
      <OrderHero label={label} figure={hero} plate={plate ?? null} />
      <OrderStats stats={stats} />
      <div data-ui="sign-status" className="flex flex-col gap-2 empty:hidden">
        {status}
      </div>
      {children}
    </section>
  );
}

/** What is one press away: the exact figures, every step, the transactions. */
export function Fold({ ui, label, children }: { ui: string; label: string; children?: ReactNode }) {
  return (
    <details data-ui={ui} className="group/fold">
      <summary className="w-fit cursor-pointer text-body-sm font-medium text-honey-text underline decoration-1 underline-offset-4 hover:decoration-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        {label}
      </summary>
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </details>
  );
}
