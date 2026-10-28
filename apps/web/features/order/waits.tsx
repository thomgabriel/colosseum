'use client';
import type { ReactNode } from 'react';
import { CardBody, CardHeader } from '../../components/ui/Card';
import { PAGE_TITLE } from '../../components/ui/heading';
import { Panel, PanelBody } from '../../components/ui/Panel';
import {
  Skeleton,
  SkeletonLine,
  SkeletonListRow,
  SkeletonMark,
} from '../../components/ui/Skeleton';
import { ScreenWait } from '../../components/waits/ScreenWait';
import { useT } from '../../i18n/I18nProvider';

// The plan, buy and order screens while their data is on its way, each in its own outline so nothing
// moves when it lands. A plan and a shared portfolio draw the same pane (PlanView.tsx), so they wait
// in the same one. The words that are the screen's own (a title, a heading) are already there; a
// name, a share or an amount is a still bar. No figure is drawn, real or made up.

const CARD = 'rounded-lg border border-border bg-card text-card-foreground';
const LEDE = 'w-full max-w-(--tf-measure-body)';

/** The chain's tag over a page's title. */
export function ChainBadgeWait() {
  return <Skeleton className="h-5 w-14" />;
}

/**
 * The plan pane in outline (PlanView.tsx), in the house kit's two panels as it lands: the board, with
 * the label over the answer, the answer in its own face and the small figures under it; then the
 * holdings' panel, with its head, the strip, a row a holding and the exit plan.
 */
export function PlanViewWait({
  title,
  sub = false,
  aside = 0,
  kpis = 1,
  rows = 3,
}: {
  /** The label over the answer, where the screen knows it; left out, the chain's tag in outline. */
  title?: string;
  /** A line under the answer: the risk, the chain, what is deposited. */
  sub?: boolean;
  /** Lines beside the answer: where the version and weights were read from. */
  aside?: number;
  /** How many small figures the board has under the answer. */
  kpis?: number;
  rows?: number;
}) {
  const t = useT();
  return (
    <div aria-hidden="true" data-ui="plan-pane-wait" className="flex flex-col gap-6">
      <Panel as="div" data-ui="plan-board-wait">
        <PanelBody>
          <div className="flex flex-col gap-1">
            <div className="flex min-h-[1.375rem] items-center text-body-sm text-muted-foreground">
              {title ?? <ChainBadgeWait />}
            </div>
            <SkeletonLine className="font-display text-[2rem]/10" width="w-80" />
          </div>
          {sub && <SkeletonLine className="-mt-2 text-body-sm" width="w-64" />}
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
            {Array.from({ length: kpis }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: still boxes with no identity of their own
              <div key={i} className="flex min-w-0 flex-col gap-1">
                <SkeletonLine className="text-caption" width="w-12" />
                <SkeletonLine className="text-body" width="w-16" />
              </div>
            ))}
          </div>
          {aside > 0 && (
            <SkeletonLine
              className="max-w-(--tf-measure-body) text-body-sm"
              width="w-80"
              lines={aside}
            />
          )}
        </PanelBody>
      </Panel>
      <Panel as="div" data-ui="plan-legs-wait">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-border px-5 py-4">
          <p className="flex items-center gap-2.5 text-body-lg font-semibold whitespace-nowrap">
            <span className="inline-flex size-8 rounded-lg bg-honey-tint" />
            {t.plan.holdingsTitle}
          </p>
        </div>
        <div className="px-5 pt-4">
          <Skeleton className="h-2 w-full rounded-full" />
        </div>
        <div className="pt-4">
          {Array.from({ length: rows }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: still boxes with no identity of their own
            <div key={i} className="flex items-center gap-3 border-t border-border px-5 py-4">
              <SkeletonMark />
              <SkeletonLine className="text-body" width="w-20" />
              <SkeletonLine className="ml-auto text-body" width="w-12" />
            </div>
          ))}
        </div>
        <PanelBody className="border-t border-border">
          <p className="text-body-sm font-medium">{t.plan.exitPlan}</p>
          <SkeletonLine className="text-body-sm" width="w-96" />
          <p className="text-body-sm text-muted-foreground">{t.plan.inKind}</p>
        </PanelBody>
      </Panel>
    </div>
  );
}

/** A page's head: the chain's tag, the title in the title's own face, and the lines under it. */
function HeadWait({
  title,
  titleLines = 1,
  children,
}: {
  /** The page's own title, where it is known before the data. */
  title?: string;
  titleLines?: number;
  children?: ReactNode;
}) {
  return (
    <div aria-hidden="true" className="flex flex-col items-start gap-3">
      <ChainBadgeWait />
      {title ? (
        <p className={PAGE_TITLE}>{title}</p>
      ) : (
        <SkeletonLine className={`w-full ${PAGE_TITLE}`} width="w-72" lines={titleLines} />
      )}
      {children}
    </div>
  );
}

/** A plan's page (PlanScreen): the goal as its title, what the plan does, the pane, and the way on. */
export function PlanScreenWait() {
  const t = useT();
  return (
    <ScreenWait
      label={t.chain.reading}
      skeleton={
        <div data-ui="plan-screen-wait" className="flex flex-col gap-8">
          <HeadWait>
            {/* what the plan does, then what happens next: more lines on a phone, as the words wrap */}
            <SkeletonLine className={`${LEDE} text-body-lg sm:hidden`} lines={4} />
            <SkeletonLine className={`${LEDE} hidden text-body-lg sm:block`} lines={2} />
            <SkeletonLine className={`${LEDE} text-body sm:hidden`} lines={3} />
            <SkeletonLine className={`${LEDE} hidden text-body sm:block`} lines={2} />
          </HeadWait>
          <div aria-hidden="true" className="flex flex-col gap-6">
            <PlanViewWait title={t.plan.title} sub kpis={1} rows={4} />
            <div className="border border-border px-6 py-4">
              <p className="text-body font-medium">{t.plan.details}</p>
            </div>
            <Skeleton className="h-10 w-28 rounded-md" />
          </div>
        </div>
      }
    />
  );
}

/** The buy page (BuyScreen): its title, the amount, and the card the order is made on. */
export function BuyScreenWait() {
  const t = useT();
  return (
    <ScreenWait
      label={t.chain.reading}
      skeleton={
        <div data-ui="buy-screen-wait" className="flex flex-col gap-8">
          <HeadWait title={t.buy.title}>
            <SkeletonLine className={`${LEDE} text-body-lg sm:hidden`} lines={4} />
            <SkeletonLine className={`${LEDE} hidden text-body-lg sm:block`} lines={2} />
          </HeadWait>
          <div aria-hidden="true" data-wait="amount" className="flex flex-col gap-1.5">
            <p className="text-caption font-medium">{t.buy.amount.label}</p>
            <Skeleton className="h-10 w-44 rounded-md" />
            <SkeletonLine className="text-caption" width="w-64" />
          </div>
          <div aria-hidden="true" data-wait="invest-card" className={`${CARD} max-w-3xl p-6`}>
            <div className="flex flex-col gap-5">
              <SkeletonLine className="text-h4" width="w-40" />
              <div className="flex flex-col divide-y divide-border border-y border-border">
                {[0, 1, 2, 3].map((i) => (
                  <SkeletonListRow key={i} mark={false} className="h-9" />
                ))}
              </div>
              <Skeleton className="h-10 w-32 rounded-md" />
            </div>
          </div>
        </div>
      }
    />
  );
}

/** An order's page (OrderScreen): its title and the card of its steps, a line a step. */
export function OrderScreenWait({
  steps = 4,
  head,
}: {
  steps?: number;
  /** The page's own head, where the order this browser kept already says what it is. */
  head?: ReactNode;
}) {
  const t = useT();
  return (
    <ScreenWait
      label={t.order.loading}
      skeleton={
        <div data-ui="order-screen-wait" className="flex flex-col gap-8">
          {head ?? (
            <HeadWait titleLines={1}>
              <SkeletonLine
                className="w-full max-w-(--tf-measure-body) text-body-lg"
                width="w-full"
                lines={2}
              />
            </HeadWait>
          )}
          <div aria-hidden="true" data-wait="order-steps" className={CARD}>
            <CardHeader title={t.order.stepsTitle} level={2} />
            <CardBody className="flex flex-col gap-4">
              <ReviewWait rows={steps} />
            </CardBody>
          </div>
        </div>
      }
    />
  );
}

/**
 * What the wallet holds against a deposit, while it is read (FundingStep): the line that says what is
 * needed, the note under it, and the two ways on. `label` says what is awaited where that first line
 * will be, so the step lands on it and nothing under it moves. No amount is drawn: none is known yet.
 */
export function FundsWait({ label }: { label?: string }) {
  return (
    <div data-ui="funds-wait" className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        {label ? (
          <p className="max-w-(--tf-measure-body) text-body text-muted-foreground">{label}</p>
        ) : (
          <SkeletonLine className="max-w-(--tf-measure-body) text-body" width="w-full" />
        )}
        <SkeletonLine className="max-w-(--tf-measure-body) text-body-sm" width="w-4/5" />
      </div>
      <div aria-hidden="true" className="flex flex-wrap gap-3">
        <Skeleton className="h-9 w-44 rounded-md" />
        <Skeleton className="h-9 w-36 rounded-md" />
      </div>
    </div>
  );
}

/**
 * An order's review in outline (gate SIGN-ONE-STEP), drawn as the house kit draws it (HOUSE-KIT): the
 * label and the figure it leads with, its small figures two by two, a row a line of the table of what
 * changes, and the fold of its details. No amount is drawn: none is known yet.
 */
function ReviewWait({ rows }: { rows: number }) {
  return (
    <>
      <div data-ui="skeleton-figure" className="flex flex-col gap-1">
        <SkeletonLine className="text-body-sm" width="w-24" />
        <SkeletonLine className="text-[2rem]/10" width="w-40" />
      </div>
      <div data-ui="skeleton-stats" className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
        {['w-16', 'w-20', 'w-14', 'w-12'].map((width) => (
          <div key={width} className="flex flex-col gap-1">
            <SkeletonLine className="text-caption" width="w-20" />
            <SkeletonLine className="text-body" width={width} />
          </div>
        ))}
      </div>
      <div className="flex flex-col">
        {Array.from({ length: rows }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: still boxes with no identity of their own
          <div key={i} className="flex items-center justify-between border-t border-border py-4">
            <SkeletonLine className="text-body-sm" width={i % 2 ? 'w-16' : 'w-20'} />
            <SkeletonLine className="text-body-sm" width="w-12" />
          </div>
        ))}
      </div>
      <SkeletonLine className="text-body-sm" width="w-16" />
    </>
  );
}

/**
 * An order while it is made or read, inside the pane or the card that holds it: its review in outline.
 * No card of its own (the host is one), and no amount.
 */
export function StepsWait({ steps = 3 }: { steps?: number }) {
  return (
    <div aria-hidden="true" data-ui="steps-wait" className="flex flex-col gap-4">
      <ReviewWait rows={steps} />
    </div>
  );
}

/**
 * The order's costs in one line while the order is made or read, at the foot of the one-screen
 * deposit (gate DEPOSIT-ONE-SCREEN), where the line lands.
 */
export function CostsWait() {
  return (
    <div aria-hidden="true" data-ui="costs-wait" className="flex flex-col gap-3">
      <SkeletonLine className="text-body-sm" width="w-72" />
      <SkeletonLine className="text-body-sm" width="w-56" />
    </div>
  );
}
