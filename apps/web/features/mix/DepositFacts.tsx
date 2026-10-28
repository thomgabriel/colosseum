'use client';
import type { MixReview, MixReviewLine } from '@colosseum/schemas';
import type { ReactNode } from 'react';
import { formatAge } from '../../components/ui/format';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import { LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { dollars } from '../portfolio/figures';
import { ageSeconds, gapBps, type QuotePrice } from './deposit-facts';

// What a holding's row says under its name on the one-screen deposit (gate DEPOSIT-ONE-SCREEN): the
// price the vault buys at (the order's quote) beside the reference feed's, with the gap; then its exit
// as Analytics measured it: the cost of selling this line's size where the server states it, the most
// the line may hold and still exit as planned, and how old that measurement is. Every figure is the
// server's, each with its pin; a tier that stands in where nothing is measured says so (EXIT-SOURCE).

export function DepositFacts({
  line,
  quote,
  quoting,
  now,
}: {
  line: MixReviewLine;
  /** The order's quote for this asset, once the order is made. */
  quote: QuotePrice | null;
  /** An order is being made for this amount: the pool price is on its way. */
  quoting: boolean;
  /** The reader's clock, for the age of the measurement. */
  now: number;
}) {
  const t = useT();
  const lang = useLang();
  const f = t.mix.deposit.facts;
  const money = (value: number) => dollars(lang, value.toFixed(2));
  const pct = (bps: number, signed: boolean) =>
    new Intl.NumberFormat(LOCALE[lang], {
      style: 'percent',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
      ...(signed ? { signDisplay: 'exceptZero' as const } : {}),
    })
      .format(bps / 10_000)
      // a true minus, as every signed figure in the app
      .replace('-', '−');
  const ago = (fetchedAt: string) => {
    const seconds = ageSeconds(fetchedAt, now);
    if (seconds === null) return null;
    if (seconds < 60) return t.pin.ago.now;
    const age = formatAge(seconds);
    if (!age) return null;
    const unit = t.pin.ago[age.unit];
    return t.pin.ago.ago
      .replace('{n}', String(age.count))
      .replace('{unit}', unit[age.count === 1 ? 0 : 1] ?? unit[0] ?? age.unit);
  };
  const feed = line.price ? Number(line.price.usdPerToken) : null;
  const gap = quote && feed !== null ? gapBps(quote.usdPerToken, feed) : null;
  const exit = line.exitCeiling;
  const cost = line.exitCost ?? null;
  const measuredAgo = exit?.measured ? ago(exit.fetchedAt) : null;
  if (!line.price && !exit) return null;
  return (
    <span data-ui="deposit-facts" className="flex flex-col gap-0.5">
      {line.price && (
        <span data-ui="deposit-prices" className="flex flex-wrap gap-x-1.5">
          {quote ? (
            <span data-ui="pool-price">
              {f.pool}{' '}
              <ProvenancePin value={money(quote.usdPerToken)} obs={quote.obs} labels={t.pin} />
              <span aria-hidden="true"> ·</span>
            </span>
          ) : null}
          <span data-ui="feed-price">
            {f.feed}{' '}
            <ProvenancePin
              value={dollars(lang, line.price.usdPerToken)}
              obs={line.price}
              labels={t.pin}
            />
            {(gap !== null || quoting) && <span aria-hidden="true"> ·</span>}
          </span>
          {gap !== null ? (
            <span data-ui="price-gap">{f.gap(pct(gap, true))}</span>
          ) : quoting ? (
            <span data-ui="pool-later">{f.poolLater}</span>
          ) : null}
        </span>
      )}
      {exit && (
        <span data-ui="exit-facts" className="flex flex-wrap gap-x-1.5">
          {cost && (
            <span data-ui="exit-cost">
              {f.exitCost} <ProvenancePin value={pct(cost.bps, false)} obs={cost} labels={t.pin} />
              <span aria-hidden="true"> ·</span>
            </span>
          )}
          <span data-ui="exit-ceiling">
            {f.exitUpTo} <ProvenancePin value={money(exit.usd)} obs={exit} labels={t.pin} />
            <span aria-hidden="true"> ·</span>
          </span>
          <span data-ui="exit-age">
            {exit.measured
              ? measuredAgo
                ? f.measured(measuredAgo)
                : t.mix.review.measured
              : f.tier}
          </span>
        </span>
      )}
    </span>
  );
}

/**
 * One line of measured facts about the vault at this amount, over its rows (gate DEPOSIT-ONE-SCREEN,
 * amended Oct 28 by Thom: objective, no goal or risk label): how many holdings, the worst exit cost at
 * this size among them with its pin, and whether every holding is within what it can sell as planned,
 * as the server's check says; a ceiling that is a tier's, not a measurement, is said as such.
 */
export function DepositSummary({ review }: { review: MixReview }) {
  const t = useT();
  const lang = useLang();
  const s = t.mix.deposit.summary;
  const held = review.lines.filter((line) => line.cls !== 'cash');
  if (held.length === 0) return null;
  const costs = held.flatMap((line) => (line.exitCost ? [line.exitCost] : []));
  const worst = costs.reduce<(typeof costs)[number] | null>(
    (most, cost) => (most === null || cost.bps > most.bps ? cost : most),
    null,
  );
  const over = held.filter((line) => line.exitCeiling && line.amountUsd > line.exitCeiling.usd);
  const tiers = held.filter((line) => line.exitCeiling && !line.exitCeiling.measured).length;
  const pct = (bps: number) =>
    new Intl.NumberFormat(LOCALE[lang], {
      style: 'percent',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(bps / 10_000);
  const parts: ReactNode[] = [
    <span key="count" data-ui="summary-holdings">
      {s.holdings(held.length)}
    </span>,
    ...(worst
      ? [
          <span key="cost" data-ui="summary-exit-cost">
            {s.exitCostAt(dollars(lang, review.amountUsd.toFixed(2)))}{' '}
            <ProvenancePin value={pct(worst.bps)} obs={worst} labels={t.pin} /> {s.atWorst}
          </span>,
        ]
      : []),
    <span key="exit" data-ui="summary-exit">
      {over.length === 0 ? s.within : s.over(over.length)}
      {tiers > 0 && ` (${s.tier(tiers)})`}
    </span>,
  ];
  return (
    <p
      data-ui="deposit-summary"
      className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1 text-body-sm"
    >
      {parts.map((part, i) => (
        <span key={(part as { key: string }).key} className="whitespace-nowrap">
          {part}
          {i < parts.length - 1 && <span aria-hidden="true">{' · '}</span>}
        </span>
      ))}
    </p>
  );
}
