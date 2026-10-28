'use client';
import type { ReactNode } from 'react';
import { LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { isCashId } from '../order/plain';
import { dollars } from '../portfolio/figures';
import { Composition, withVenue } from '../shared/Composition';

// The draft, read only: the ring the conversation's preview draws (Composition.tsx), beside a row for
// each asset with its exact share and, where the server has checked an amount, what goes into each in
// dollars. A figure that is not the server's is never drawn here: an amount not checked yet is a dash.

export type MixRow = {
  assetId: string;
  name: string;
  weightBps: number;
  /** The line's dollars as the server's review has them; null while there is no review of this mix. */
  amountUsd?: number | null;
  /** Under the name: the line's own facts with their pins (the one-screen deposit's prices and exit). */
  facts?: ReactNode;
};

export function MixLines({
  rows,
  caption,
  amounts = false,
  narrow = false,
}: {
  rows: readonly MixRow[];
  caption: string;
  /** Show the dollars column: on the deposit step, where an amount is typed. */
  amounts?: boolean;
  /** Keep the columns in a narrow pane, each row's facts under its name (Composition's `narrow`). */
  narrow?: boolean;
}) {
  const t = useT();
  const lang = useLang();
  const d = t.mix.deposit;
  const share = (bps: number) =>
    new Intl.NumberFormat(LOCALE[lang], { style: 'percent', maximumFractionDigits: 2 }).format(
      bps / 10_000,
    );
  return (
    <div data-ui="mix-lines" className="min-w-0">
      {/* still: on the deposit step the keyboard goes from the amount to the press, not through
          the rows */}
      <Composition
        still
        {...(narrow ? { fold: 'narrow' as const } : {})}
        share={share}
        labels={{ caption }}
        columns={amounts ? [{ key: 'amount', header: t.mix.review.amount, numeric: true }] : []}
        items={rows.map((row) => ({
          key: row.assetId,
          ...withVenue(row.name),
          ...(row.facts ? { detail: row.facts } : {}),
          asset: row.assetId,
          cash: isCashId(row.assetId),
          bps: row.weightBps,
          ...(amounts
            ? {
                cells: {
                  amount: (
                    <span data-ui="mix-line-amount">
                      {row.amountUsd == null ? (
                        <>
                          <span aria-hidden="true">—</span>
                          <span className="sr-only">{d.unchecked}</span>
                        </>
                      ) : (
                        dollars(lang, row.amountUsd.toFixed(2))
                      )}
                    </span>
                  ),
                },
              }
            : {}),
        }))}
      />
    </div>
  );
}
