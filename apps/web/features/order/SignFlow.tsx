'use client';
import type { ReactNode } from 'react';
import { cn } from '../../components/ui/cn';
import { DataTable } from '../../components/ui/DataTable';
import { ExplorerLink, type ExplorerLinkLabels } from '../../components/ui/ExplorerLink';
import { Hint } from '../../components/ui/Hint';
import { Icon } from '../../components/ui/Icon';
import type { Figure, Picture, PictureRow } from './order-summary';

// The parts of the order screen, one screen at a time (gate SIGN-ONE-STEP): the strip that says where
// the person is, the picture of what changes, the steps already signed as one line each, the step
// being signed on its own, and the folds that keep the exact figures one press away. Nothing here
// decides what is signed: the order's screen (OrderScreen.tsx) hands each part its words.

/**
 * Where the person is: each step's short name, then "Done". Steps before `at` are done; `at` is the
 * one under way, or the last place once every step is. On a phone only that one is named.
 */
export function StepStrip({
  names,
  at,
  label,
  doneWord,
}: {
  names: readonly string[];
  at: number;
  label: string;
  doneWord: string;
}) {
  return (
    <ol
      data-ui="sign-progress"
      aria-label={label}
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-body-sm"
    >
      {names.map((name, i) => {
        const done = i < at || (i === at && i === names.length - 1);
        const current = i === at;
        return (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: the strip is the order's steps, in order
            key={i}
            data-done={done}
            aria-current={current ? 'step' : undefined}
            className={cn(
              'inline-flex items-center gap-2',
              current ? 'font-semibold text-foreground' : 'text-muted-foreground',
            )}
          >
            {i > 0 && (
              <span aria-hidden="true" className="text-muted-foreground">
                —
              </span>
            )}
            <span
              aria-hidden="true"
              className={cn(
                'inline-grid size-5 shrink-0 place-items-center rounded-sm border font-mono text-caption',
                done
                  ? 'border-primary bg-primary text-primary-foreground'
                  : current
                    ? 'border-foreground text-foreground'
                    : 'border-input',
              )}
            >
              {done ? <Icon name="Check" size={16} /> : i + 1}
            </span>
            <span className={cn(!current && 'max-sm:sr-only')}>{name}</span>
            {done && <span className="sr-only">, {doneWord}</span>}
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

/** What changes, as one compact table. */
export function ChangeTable({ picture }: { picture: Picture }) {
  return (
    <div data-ui="sign-picture">
      <DataTable<PictureRow>
        dense
        caption={picture.caption}
        rows={picture.rows}
        rowKey={(row) => row.key}
        columns={[
          { key: 'name', header: '', rowHeader: true, cell: (row) => row.name },
          ...picture.columns.map((header, i) => ({
            key: `c${i}`,
            header,
            numeric: true,
            cell: (row: PictureRow) => {
              const figure = row.cells[i];
              return figure ? <Rounded figure={figure} /> : '—';
            },
          })),
        ]}
      />
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

/** The steps confirmed so far, one line each, over the step being signed. */
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
    <ul data-ui="sign-past" aria-label={label} className="flex flex-col gap-1 text-body-sm">
      {steps.map((step) => (
        <li key={step.key} className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span aria-hidden="true" className="text-status-on">
            <Icon name="Check" size={16} />
          </span>
          <span className="font-medium">{step.name}</span>
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

/** The step being signed, alone: its place, what it does in plain words, its worst case, and the rest. */
export function StepPanel({
  place,
  title,
  worst,
  status,
  children,
}: {
  /** "Step 2 of 3". */
  place: string;
  title: string;
  worst: string | null;
  /** Where the step stands, said in a polite live region. */
  status: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section data-ui="sign-step" aria-label={title} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <p className="text-caption text-muted-foreground">{place}</p>
        {/* takes the focus when the review leads here: the press that led is gone */}
        <h3 tabIndex={-1} className="font-display text-h4 font-semibold text-balance outline-none">
          {title}
        </h3>
        {worst && (
          <p data-ui="sign-worst" className="max-w-(--tf-measure-body) text-body-sm">
            {worst}
          </p>
        )}
      </div>
      <div aria-live="polite" data-ui="sign-status" className="flex flex-col gap-2">
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
      <div className="mt-3 flex flex-col gap-4">{children}</div>
    </details>
  );
}
