'use client';
import type { ReactNode } from 'react';
import { cn } from '../../components/ui/cn';
import { ExplorerLink, type ExplorerLinkLabels } from '../../components/ui/ExplorerLink';
import { Hint } from '../../components/ui/Hint';
import { Icon } from '../../components/ui/Icon';
import type { Figure, Picture, ShareItem } from './order-summary';
import { AssetMark } from './PlanView';

// The parts of the order screen, one screen at a time (gate SIGN-ONE-STEP), in the calm of the
// portfolio's overview: one large line a screen, a quiet strip that says where the person is, short
// rows with no rules between them, and the exact figures one fold away. Nothing here decides what is
// signed: the order's screen (OrderScreen.tsx) hands each part its words.

/** The one large line of a screen, in the display face. Takes the focus where a screen replaced another. */
export function Hero({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <h3
      id={id}
      tabIndex={-1}
      data-ui="sign-hero"
      className="font-display text-[2rem]/10 font-semibold tracking-[-0.02em] text-balance tabular-nums outline-none [overflow-wrap:anywhere]"
    >
      {children}
    </h3>
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

const ROW = 'flex min-w-0 items-center justify-between gap-4 py-2';

/**
 * What a vault aims at before and after, as short rows: the holding, its share now, its share after
 * and the signed difference. A stand-in for the shared composition's comparison
 * (`features/shared/Composition.tsx`, mode "compare"), which takes the same items.
 */
export function ShareList({
  caption,
  items,
  share,
  labels,
}: {
  caption: string;
  items: readonly ShareItem[];
  share: (bps: number, exact?: boolean) => string;
  labels: { before: string; after: string; unchanged: string };
}) {
  const compare = items.some((item) => item.beforeBps !== undefined);
  const signed = (bps: number) => `${bps > 0 ? '+' : '−'}${share(Math.abs(bps))}`;
  return (
    <section data-ui="sign-picture" aria-label={caption} className="flex flex-col">
      <p className="text-body-sm text-muted-foreground">{caption}</p>
      <ul className="flex flex-col">
        {items.map((item) => {
          const was = item.beforeBps ?? 0;
          const moved = item.bps - was;
          return (
            <li key={item.key} data-ui="sign-share" className={ROW}>
              <span className="flex min-w-0 items-center gap-3">
                {item.asset && !item.cash ? (
                  <AssetMark asset={item.asset} />
                ) : (
                  <span aria-hidden="true" className="inline-block size-6 rounded-full bg-muted" />
                )}
                <span className="min-w-0 truncate font-medium">{item.name}</span>
              </span>
              <span className="flex shrink-0 items-baseline gap-3 tabular-nums">
                {compare && (
                  <span className="text-body-sm text-muted-foreground">
                    <span className="sr-only">{labels.before} </span>
                    {share(was)}
                    <span aria-hidden="true"> →</span>
                  </span>
                )}
                <span className="text-body font-semibold">
                  {compare && <span className="sr-only">{labels.after} </span>}
                  {share(item.bps)}
                </span>
                {compare && (
                  <span
                    data-ui="sign-share-delta"
                    className={cn(
                      'w-14 text-end text-caption',
                      moved > 0
                        ? 'text-status-on'
                        : moved < 0
                          ? 'text-status-off'
                          : 'text-muted-foreground',
                    )}
                  >
                    {moved === 0 ? labels.unchanged : signed(moved)}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Where an amount goes or what leaves, as short rows: the name, and its amount. */
export function AmountList({ picture }: { picture: Picture }) {
  return (
    <section data-ui="sign-picture" aria-label={picture.caption} className="flex flex-col">
      <p className="text-body-sm text-muted-foreground">{picture.caption}</p>
      <ul className="flex flex-col">
        {picture.rows.map((row) => {
          const figure = row.cells[row.cells.length - 1];
          return (
            <li key={row.key} data-ui="sign-share" className={ROW}>
              <span className="flex min-w-0 items-center gap-3">
                {row.key !== 'cash' && row.key.includes(':') ? (
                  <AssetMark asset={row.key} />
                ) : (
                  <span aria-hidden="true" className="inline-block size-6 rounded-full bg-muted" />
                )}
                <span className="min-w-0 truncate font-medium">{row.name}</span>
              </span>
              <span className="shrink-0 text-body font-semibold">
                {figure ? <Rounded figure={figure} /> : '—'}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
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
 * The step being signed, alone: its large line (the focal element), what it may give up small under
 * it, where it stands, and the rest. Its place in the order is the strip's, and the screen reader's.
 */
export function StepPanel({
  place,
  hero,
  note,
  title,
  status,
  children,
}: {
  /** "Step 2 of 3", for a screen reader: the strip shows it. */
  place: string;
  /** "$1,354 → GOOGLx". */
  hero: string;
  /** "at least 3.76 GOOGLx · 1% under today's price". */
  note: string | null;
  /** What the step does in a sentence: its name for a screen reader. */
  title: string;
  /** Where the step stands. Said aloud by the order's one announcer, not here. */
  status: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section data-ui="sign-step" aria-label={title} className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <p className="sr-only">{place}</p>
        <Hero>{hero}</Hero>
        {note && (
          <p data-ui="sign-worst" className="text-body-sm text-muted-foreground">
            {note}
          </p>
        )}
      </div>
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
