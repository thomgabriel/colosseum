'use client';
import { ChainId } from '@colosseum/schemas';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { buttonClass } from '../../components/ui/button-class';
import { ChainBadge } from '../../components/ui/ChainBadge';
import { PAGE_BACK, PAGE_TITLE } from '../../components/ui/heading';
import { Panel } from '../../components/ui/Panel';
import {
  Skeleton,
  SkeletonLine,
  SkeletonListRow,
  SkeletonMark,
} from '../../components/ui/Skeleton';
import { ScreenWait } from '../../components/waits/ScreenWait';
import { useT } from '../../i18n/I18nProvider';
import { PlanViewWait } from '../order/waits';
import { useWalletPort } from '../wallet/WalletProvider';

// The shelf and a shared portfolio's page while they are read, in their own outlines: the shelf's
// cards in the shelf's grid, each with its bar of holdings; a portfolio's head over the plan pane it
// shares with a plan's page. A name, a share or a yield is a still bar: no figure is drawn.

/** What a card of holdings opens with: one bar of the shares, then a mark, a name and a share each. */
export function HoldingsWait({ rows = 3 }: { rows?: number }) {
  return (
    <span aria-hidden="true" data-ui="holdings-wait" className="flex flex-col gap-2">
      <Skeleton className="h-3 w-full rounded-none" />
      <span className="grid gap-x-5 gap-y-2 sm:grid-cols-2">
        {Array.from({ length: rows }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: still boxes with no identity of their own
          <SkeletonListRow key={i} />
        ))}
      </span>
    </span>
  );
}

/** One card of the shelf: its name and chain, its holdings, its yield, its words, who made it. */
function ShelfCardWait() {
  return (
    <div data-wait="shelf-card" className="h-full rounded-lg border border-border bg-card">
      <div className="flex items-baseline justify-between gap-4 p-6">
        <SkeletonLine className="min-w-0 flex-1 text-h4" width="w-44" />
        <Skeleton className="h-5 w-14" />
      </div>
      <div className="flex flex-col gap-3 border-t border-border p-6">
        <HoldingsWait />
        <SkeletonLine className="text-body-sm" width="w-72" />
        <SkeletonLine className="text-body-sm" width="w-48" />
        <SkeletonLine className="text-body-sm" width="w-40" />
      </div>
    </div>
  );
}

/** The shelf's list: cards two abreast on a desk, one on a phone, as the shelf lays them. */
export function ShelfWait({ cards = 4 }: { cards?: number }) {
  return (
    <div
      aria-hidden="true"
      data-ui="shelf-wait"
      className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0"
    >
      {Array.from({ length: cards }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: still boxes with no identity of their own
        <ShelfCardWait key={i} />
      ))}
    </div>
  );
}

/** A shared portfolio's page: the way back, its name and words, then its two panes. */
export function FamilyWait() {
  const t = useT();
  return (
    <ScreenWait
      label={t.shared.family.loading}
      skeleton={
        <div data-ui="family-wait" className="flex flex-col gap-8">
          <div className="flex flex-col gap-3">
            {/* The way back works while the page waits: on a slow read it is what a person wants. */}
            <Link href="/products" className={`${buttonClass({ variant: 'link' })} ${PAGE_BACK}`}>
              {t.shared.family.backToShelf}
            </Link>
            <div aria-hidden="true" className="flex flex-col gap-3">
              <SkeletonLine className={PAGE_TITLE} width="w-80" />
              <SkeletonLine className="max-w-(--tf-measure-body) text-body-lg" width="w-64" />
            </div>
          </div>
          <div className={FAMILY_PANES}>
            <PlanViewWait kpis={4} aside={2} />
            <div aria-hidden="true" className="flex flex-col gap-4">
              <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5">
                <SkeletonLine className="text-body-lg" width="w-40" />
                <ActionsWait />
              </div>
            </div>
          </div>
        </div>
      }
    />
  );
}

/**
 * A shared portfolio's two panes: what it holds on the left, what to do with it on the right, kept in
 * view as the plan scrolls. One column on a phone, the actions under the plan.
 */
export const FAMILY_PANES =
  'grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,25rem)]';

/** The two ways to use a portfolio, in outline, while the person's vaults are read. */
export function ActionsWait() {
  return (
    <div aria-hidden="true" data-ui="actions-wait" className="flex flex-col gap-2">
      <Skeleton className="h-14 w-full rounded-md" />
      <Skeleton className="h-14 w-full rounded-md" />
    </div>
  );
}

/** A screen's head as it will read: the chain's tag, the title, and the line under it. */
function HeadWait({
  chain,
  title,
  lead,
  children,
}: {
  chain: ChainId | null;
  title: string;
  /** The line under the title, where the chain already says it; else its outline. */
  lead: string | null;
  children?: ReactNode;
}) {
  return (
    <header className="flex flex-col items-start gap-3">
      {chain ? <ChainBadge chain={chain} /> : <Skeleton className="h-5 w-14" />}
      <h1 className={PAGE_TITLE}>{title}</h1>
      {lead ? (
        <p className="max-w-(--tf-measure-body) text-body-lg">{lead}</p>
      ) : (
        <SkeletonLine
          className="w-full max-w-(--tf-measure-body) text-body-lg"
          width="w-full"
          lines={2}
        />
      )}
      {children}
    </header>
  );
}

/**
 * The amount card in outline (gate AMOUNT-CARD): its frame where the card lands, the title, the
 * amount's well, what it leads to, and the one button. Its height is its data's.
 */
export function AmountCardWait({ wait }: { wait: string }) {
  return (
    <div
      aria-hidden="true"
      data-wait={wait}
      className="flex w-full flex-col gap-4 rounded-xl border border-border bg-card p-5"
    >
      <SkeletonLine className="text-h4" width="w-24" />
      <Skeleton className="h-28 w-full rounded-md" />
      <Skeleton className="h-20 w-full rounded-md" />
      <Skeleton className="h-10 w-full rounded-md" />
    </div>
  );
}

/** Withdraw (WithdrawScreen): its head, then the amount card. */
export function WithdrawWait({ chain }: { chain: ChainId | null }) {
  const t = useT();
  const w = t.withdraw;
  return (
    <ScreenWait
      label={w.loading}
      skeleton={
        <div data-ui="withdraw-wait" className="flex flex-col gap-8">
          <HeadWait
            chain={chain}
            title={w.title}
            lead={chain ? w.lead(t.chain.names[chain]) : null}
          />
          <AmountCardWait wait="card" />
        </div>
      }
    />
  );
}

/** Add money (AddMoneyScreen): its head, the amount card, and where the deposit goes. */
export function AddMoneyWait({ chain }: { chain: ChainId | null }) {
  const t = useT();
  const words = t.portfolio.add;
  return (
    <ScreenWait
      label={t.portfolio.reading}
      skeleton={
        <div data-ui="add-money-wait" className="flex flex-col gap-8">
          <HeadWait
            chain={chain}
            title={words.title}
            lead={chain ? words.lead(t.chain.names[chain]) : null}
          >
            <span aria-hidden="true" className="flex min-h-6 items-center gap-x-5">
              <SkeletonLine className="font-mono text-source" width="w-20" />
              <SkeletonLine className="text-body-sm" width="w-36" />
            </span>
          </HeadWait>
          <div
            aria-hidden="true"
            className="grid min-w-0 items-start gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
          >
            <div className="flex min-w-0 flex-col gap-5">
              <AmountCardWait wait="card" />
            </div>
            <div
              data-wait="strategy"
              className="flex min-w-0 flex-col gap-4 border-t border-border pt-5"
            >
              <p className="text-h3">{words.strategy}</p>
              <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
                <SkeletonLine className="text-body-sm" width="w-32" />
                <HoldingsWait rows={2} />
              </div>
            </div>
          </div>
        </div>
      }
    />
  );
}

/** Publish (PublishScreen) while the account is read: its head, the source vault, the two cards. */
export function PublishWait() {
  const t = useT();
  const p = t.shared.publish;
  return (
    <ScreenWait
      label={t.chain.reading}
      skeleton={
        <div data-ui="publish-wait" className="flex flex-col gap-8">
          <header className="flex flex-col gap-3">
            <h1 className={PAGE_TITLE}>{p.title}</h1>
            <SkeletonLine
              className="max-w-(--tf-measure-body) text-body-lg"
              width="w-full"
              lines={2}
            />
          </header>
          <div aria-hidden="true" className="grid items-start gap-6 lg:grid-cols-2 [&>*]:min-w-0">
            <div
              data-wait="source"
              className="flex flex-col gap-4 rounded-lg border border-border bg-card p-6 lg:col-span-2"
            >
              <div className="flex flex-col gap-1.5">
                <p className="text-caption font-medium">{p.sourceVault}</p>
                <Skeleton className="h-10 w-full rounded-md" />
                <SkeletonLine className="text-caption" width="w-56" />
              </div>
              <SkeletonLine className="text-body-sm" width="w-80" lines={2} />
            </div>
            <div
              data-wait="words"
              className="flex flex-col gap-5 rounded-lg border border-border bg-card p-6"
            >
              {[p.name, p.slug, p.copy].map((label, i) => (
                <div key={label} className="flex flex-col gap-1.5">
                  <p className="text-caption font-medium">{label}</p>
                  <Skeleton className={`w-full rounded-md ${i === 2 ? 'h-24' : 'h-10'}`} />
                  <SkeletonLine className="text-caption" width="w-64" />
                </div>
              ))}
            </div>
            <div data-wait="assets" className="rounded-lg border border-border bg-card">
              <p className="p-6 text-h4 font-semibold">{p.assets}</p>
              <div className="flex flex-col gap-4 border-t border-border p-6">
                <p className="text-body-sm text-muted-foreground">{p.assetsHint}</p>
                <div className="flex flex-col gap-3">
                  {[0, 1, 2].map((i) => (
                    <SkeletonListRow key={i} mark={false} />
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      }
    />
  );
}

/**
 * What a vault holds, in outline, in the house kit's panel as it lands (VaultHoldings.tsx): its head,
 * the strip, then a row a holding. As the table does (Composition.tsx), a row is one line where the
 * box is 40rem wide or more, and under it folds: the asset on top, the figures in a row under it, each
 * under its column's name.
 */
function VaultHoldingsWait({ className }: { className?: string }) {
  const t = useT();
  const v = t.shared.vault;
  const figures = [v.columns.price, v.page.value, v.columns.weight];
  return (
    <div aria-hidden="true" data-wait="holdings" className={`min-w-0 ${className ?? ''}`}>
      <Panel as="div">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-border px-5 py-4">
          <p className="text-body-lg font-semibold whitespace-nowrap">{v.page.holdings}</p>
          <SkeletonLine className="text-body-sm" width="w-16" />
        </div>
        <div className="px-5 pt-4">
          <Skeleton className="h-2 w-full rounded-full" />
        </div>
        <div className="@container pt-4">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              data-wait="holding"
              className="flex flex-wrap items-center gap-x-6 border-t border-border px-5 py-4 @max-[40rem]:items-start @max-[40rem]:gap-y-2 @max-[40rem]:py-3"
            >
              <span className="flex min-w-0 items-center gap-3 @max-[40rem]:basis-full">
                <SkeletonMark />
                <span className="flex flex-col gap-1">
                  <SkeletonLine className="text-body" width="w-16" />
                  <SkeletonLine className="text-caption" width="w-20" />
                </span>
              </span>
              <span className="ml-auto flex gap-6 @max-[40rem]:ml-0">
                {figures.map((label) => (
                  <span
                    key={label}
                    className="flex flex-col items-end gap-1 @max-[40rem]:items-start"
                  >
                    <span className="hidden text-caption text-muted-foreground @max-[40rem]:block">
                      {label}
                    </span>
                    <SkeletonLine className="text-body-sm" width="w-12" />
                  </span>
                ))}
              </span>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

/**
 * A vault's own page (VaultScreen), as its workbench: the way back, its name and value with its
 * actions; the conversation beside what it holds, which is a card with one bar, a label a holding
 * and the table of them. The name, the value and every holding are still bars: none is drawn.
 */
export function VaultWait({ visitor = false }: { visitor?: boolean }) {
  const t = useT();
  const v = t.shared.vault;
  // Someone signed out owns no vault here: the page they get has no conversation and no action, so
  // its wait draws neither. That is known before the vault is read.
  if (visitor)
    return (
      <ScreenWait
        label={v.loading}
        skeleton={
          <div data-ui="vault-wait" data-visitor className="flex min-w-0 flex-col gap-6">
            <div className="flex min-w-0 flex-col gap-3">
              <Link
                href="/portfolio"
                className={`${buttonClass({ variant: 'link' })} ${PAGE_BACK}`}
              >
                {v.back}
              </Link>
              <div aria-hidden="true" className="flex flex-col gap-2">
                <SkeletonLine className={PAGE_TITLE} width="w-40" />
                <SkeletonLine className="font-display text-h3" width="w-36" />
              </div>
            </div>
            <VaultHoldingsWait />
          </div>
        }
      />
    );
  return (
    <ScreenWait
      label={v.loading}
      // the workbench's own frame: the page's width and height, as the vault's page takes them
      className="flex min-w-0 flex-col md:min-h-0 md:flex-1"
      skeleton={
        <div
          data-ui="vault-wait"
          data-workbench
          className="grid min-w-0 gap-4 md:min-h-0 md:flex-1 md:grid-cols-12 md:grid-rows-[minmax(0,auto)_minmax(15rem,1fr)] md:items-stretch"
        >
          <div className="flex min-w-0 flex-col gap-3 md:col-span-12">
            {/* the way back works while the vault is read */}
            <Link href="/portfolio" className={`${buttonClass({ variant: 'link' })} ${PAGE_BACK}`}>
              {v.back}
            </Link>
            <div aria-hidden="true" className="flex flex-col gap-2">
              {/* the name and its Rename button (PAGE-SHELL: a button, not a link) */}
              <div className="flex w-full flex-wrap items-start gap-x-4 gap-y-1">
                <SkeletonLine className={PAGE_TITLE} width="w-40" />
                <Skeleton className="h-9 w-[5.5rem] rounded-md" />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
                <SkeletonLine className="font-display text-h3" width="w-36" />
                {/* on a phone the third action wraps under the pair, as the page's does */}
                <div className="flex flex-wrap items-center gap-3 max-sm:w-[16.25rem]">
                  <Skeleton className="h-10 w-24 rounded-md max-sm:w-[7.25rem]" />
                  <Skeleton className="h-10 w-24 rounded-md max-sm:w-[7.25rem]" />
                  <Skeleton className="h-10 w-24 rounded-md" />
                </div>
              </div>
            </div>
          </div>
          <div
            aria-hidden="true"
            data-wait="chat"
            className="flex min-w-0 flex-col gap-4 md:col-span-5"
          >
            <div className="flex flex-col gap-1">
              <SkeletonLine className="text-body" width="w-44" />
              <SkeletonLine className="text-caption" width="w-56" />
            </div>
            <SkeletonLine className="text-body-sm" width="w-full" lines={2} />
            <div className="flex flex-wrap gap-2">
              <Skeleton className="h-8 w-36 rounded-md" />
              <Skeleton className="h-8 w-36 rounded-md" />
            </div>
            {/* the typing box at the pane's foot, with the line under it */}
            <div className="mt-auto flex flex-col gap-2 max-md:mt-[3.3125rem]">
              <Skeleton className="h-[4.875rem] w-full rounded-lg" />
              <SkeletonLine className="text-caption/8" width="w-48" />
            </div>
          </div>
          {/* the right pane as the page draws it: it scrolls on its own on a desktop, with the same
              gutter for its scrollbar, so what it holds lands where its outline was */}
          <div className="tf-scroll-pane flex min-w-0 flex-col md:col-span-7 md:min-h-0 md:overflow-y-auto md:overscroll-contain md:pr-2">
            <VaultHoldingsWait />
          </div>
        </div>
      }
    />
  );
}

/** Add money's wait before the page runs (its `loading.tsx`): the chain is the address's own. */
export function AddMoneyRouteWait() {
  const { chain } = useParams<{ chain?: string }>();
  const known = ChainId.safeParse(chain);
  return <AddMoneyWait chain={known.success ? known.data : null} />;
}

/** A vault page's wait before the page runs (its `loading.tsx`): a visitor's, or the owner's. */
export function VaultRouteWait() {
  const port = useWalletPort();
  return <VaultWait visitor={port.status === 'signed-out'} />;
}
