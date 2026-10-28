'use client';
import type { MixReview } from '@colosseum/schemas';
import { useState } from 'react';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import { StatusMark } from '../../components/ui/StatusMark';
import { LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { AssetMark } from '../order/PlanView';
import { displayName, plainNames } from '../order/plain';
import { dollars } from '../portfolio/figures';
import { unticked } from './mix';

// The server's reading of a mix before it is bought or applied (gate ANY-COMPOSITION, #191): every
// line with its amount, the sourced price it was counted at and the most it may hold and still exit as
// planned, each figure with its pin; then the warnings, confirmed with one box. Nothing here is a
// figure of the model's or of this app's: the review is the server's, and the confirm sends back its
// hash with the ticks. A new goal's deposit draws its lines on its own card (DepositStep, gate
// DEPOSIT-ONE-SCREEN); a vault's change of targets draws them here (ChangeReview).

const NONE: ReadonlySet<string> = new Set();

/**
 * The warnings the person ticked, held to the one review they were ticked on. A tick is given to a
 * warning with its figures, which only the review's hash names: a review with another hash (a figure
 * that moved, a weight that changed) starts with none, even where a warning keeps its id.
 */
export function useTicks(
  review: MixReview | null,
): [ReadonlySet<string>, (id: string, on: boolean) => void] {
  const [held, setHeld] = useState<{ hash: string; ids: ReadonlySet<string> } | null>(null);
  const hash = review?.reviewHash ?? null;
  const ticked = held && held.hash === hash ? held.ids : NONE;
  const tick = (id: string, on: boolean) => {
    if (!hash) return;
    setHeld((old) => {
      const next = new Set(old && old.hash === hash ? old.ids : NONE);
      if (on) next.add(id);
      else next.delete(id);
      return { hash, ids: next };
    });
  };
  return [ticked, tick];
}

/** The words and figures a review's parts are written with. */
function useReviewWords() {
  const t = useT();
  const lang = useLang();
  const share = (bps: number) =>
    new Intl.NumberFormat(LOCALE[lang], { style: 'percent', maximumFractionDigits: 2 }).format(
      bps / 10_000,
    );
  const usd = (value: number) => dollars(lang, value.toFixed(2));
  return { t, lang, r: t.mix.review, share, usd };
}

/** Every line of a review: the share, the amount, the price it was counted at and its exit, each pinned. */
export function MixReviewLines({
  review,
  named,
}: {
  review: MixReview;
  /** A holding's name as the screen around it writes it; left out, the server's symbol. */
  named?: (assetId: string) => string;
}) {
  const { t, lang, r, share, usd } = useReviewWords();
  return (
    <table data-ui="mix-review-lines" className="w-full table-fixed border-collapse text-body-sm">
      <caption className="sr-only">{r.title}</caption>
      <thead className="text-caption text-muted-foreground">
        <tr className="border-b border-border">
          <th scope="col" className="py-2 text-start font-normal">
            {r.asset}
          </th>
          <th scope="col" className="w-16 py-2 text-end font-normal">
            {r.weight}
          </th>
          <th scope="col" className="w-24 py-2 text-end font-normal">
            {r.amount}
          </th>
        </tr>
      </thead>
      <tbody>
        {review.lines.map((line) => (
          <tr key={line.assetId} className="border-b border-border align-top">
            <th scope="row" className="py-3 pr-2 text-start font-normal">
              <span className="flex min-w-0 items-center gap-2">
                <AssetMark asset={line.assetId} />
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  {/* the one name every step uses for it, never the chain's symbol */}
                  {line.cls === 'cash'
                    ? r.cash
                    : (named?.(line.assetId) ?? displayName(line.assetId, t.plan))}
                </span>
              </span>
              <span className="mt-2 flex flex-col gap-1 text-caption text-muted-foreground">
                <span>
                  {r.price}:{' '}
                  {line.price ? (
                    <ProvenancePin
                      value={dollars(lang, line.price.usdPerToken)}
                      obs={line.price}
                      labels={t.pin}
                    />
                  ) : (
                    r.cashPrice
                  )}
                </span>
                {line.exitCeiling && (
                  <span data-ui="exit-ceiling">
                    {r.exit}:{' '}
                    <ProvenancePin
                      value={usd(line.exitCeiling.usd)}
                      obs={line.exitCeiling}
                      labels={t.pin}
                    />{' '}
                    ({line.exitCeiling.measured ? r.measured : r.tier})
                  </span>
                )}
              </span>
            </th>
            <td className="py-3 text-end tabular-nums">{share(line.weightBps)}</td>
            <td className="py-3 text-end tabular-nums">{usd(line.amountUsd)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr data-ui="mix-review-total">
          <th scope="row" colSpan={2} className="py-3 text-start font-medium">
            {r.total}
          </th>
          <td className="py-3 text-end font-medium tabular-nums">{usd(review.amountUsd)}</td>
        </tr>
      </tfoot>
    </table>
  );
}

/**
 * A warning of the server's as the rows around it name its holdings: every line's symbol ("SPYx",
 * "mGOLD", a test network's "tGLDx") becomes the name its row shows (audit I4), whether or not the
 * warning says which asset it is about. The longest symbol first, each as a whole word.
 */
export function namedAsRows(
  text: string,
  review: MixReview,
  named: (assetId: string) => string,
): string {
  const lines = review.lines
    .filter((line) => line.cls !== 'cash' && line.symbol)
    .sort((a, b) => (b.symbol?.length ?? 0) - (a.symbol?.length ?? 0));
  let said = text;
  for (const line of lines) {
    const symbol = (line.symbol ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    said = said.replace(new RegExp(`(?<![\\w])${symbol}(?![\\w])`, 'g'), named(line.assetId));
  }
  return plainNames(said);
}

/**
 * A review's warnings as one short list with one box for all of them (gate SIGN-ONE-STEP): each
 * warning's sentence with its figures pinned, then "I understand these", which ticks every one. The
 * server's symbol in a sentence is written as the screen around it names the holding.
 */
export function MixReviewAck({
  review,
  ticked,
  onTick,
  named,
}: {
  review: MixReview;
  ticked: ReadonlySet<string>;
  onTick: (id: string, on: boolean) => void;
  named: (assetId: string) => string;
}) {
  const { t, r, share, usd } = useReviewWords();
  if (review.warnings.length === 0) return null;
  const all = unticked(review, ticked).length === 0;
  const said = (text: string) => namedAsRows(text, review, named);
  return (
    <fieldset data-ui="mix-review-warnings" className="flex min-w-0 flex-col gap-2">
      <legend className="sr-only">{r.warnings}</legend>
      <ul className="flex flex-col gap-1.5 text-body-sm">
        {review.warnings.map((warning) => (
          <li key={warning.id} data-warning={warning.code} className="flex items-start gap-1.5">
            <StatusMark status="watch" className="mt-1.5" />
            <span className="min-w-0 [overflow-wrap:anywhere]">
              {said(warning.text)}
              {warning.figures.map((figure) => (
                <span
                  key={`${figure.label}:${figure.fetchedAt}`}
                  className="ml-1.5 text-caption text-muted-foreground"
                >
                  {figure.label}:{' '}
                  <ProvenancePin
                    value={figure.unit === 'USD' ? usd(figure.value) : share(figure.value)}
                    obs={figure}
                    labels={t.pin}
                  />
                </span>
              ))}
            </span>
          </li>
        ))}
      </ul>
      <label className="inline-flex items-center gap-2 text-body-sm font-medium">
        <input
          type="checkbox"
          data-ui="warnings-ack"
          className="size-4 shrink-0 accent-primary"
          checked={all}
          onChange={(e) => {
            const on = e.currentTarget.checked;
            for (const warning of review.warnings) onTick(warning.id, on);
          }}
        />
        {t.order.flow.understand}
      </label>
    </fieldset>
  );
}
