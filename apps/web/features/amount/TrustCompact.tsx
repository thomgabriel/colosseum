'use client';
import { type ChainId, TRUST_STATUS } from '@colosseum/schemas';
import { useId } from 'react';
import { LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { formatBps } from '../order/amounts';
import { chainIsLive } from '../order/readiness';
import { trustPoints } from '../order/trust-points';

// The trust notice as the amount card holds it (gate AMOUNT-CARD): the same words as the notice of the
// invest card (TrustNotice.tsx), from the same function (trust-points.ts), set compact. Every short
// point stays in sight, the whole notice is one click away, and the box to tick is under them. Nothing
// is left out: on a live network that is the real money, the loss, who can change the code and who can
// pause. Accepted before, it shows the points and the full list with nothing to tick.

export function TrustCompact({
  chain,
  keeper: keeperTrades,
  accepted,
  checked,
  onCheck,
  id,
}: {
  chain: ChainId;
  keeper: boolean;
  accepted: boolean;
  checked: boolean;
  onCheck: (yes: boolean) => void;
  id?: string;
}) {
  const t = useT();
  const lang = useLang();
  const boxId = useId();
  const titleId = useId();
  const keeper = TRUST_STATUS.keeper[chain];
  const limits = keeper
    ? ([
        formatBps(keeper.toleranceBps, LOCALE[lang]),
        formatBps(keeper.weeklyLossCapBps, LOCALE[lang]),
      ] as const)
    : null;
  const points = trustPoints(t, chain, { live: chainIsLive(chain), keeperTrades, limits });
  // A live chain with no notice of its own: nothing to accept, so nothing is offered to tick.
  if (!points) return null;
  return (
    <div id={id} data-ui="trust-notice" className="flex flex-col gap-2">
      <p id={titleId} className="text-body-sm font-semibold">
        {t.trust.short.title}
      </p>
      <ul
        data-ui="trust-short"
        aria-labelledby={titleId}
        className="flex list-disc flex-col gap-0.5 pl-4 text-caption tracking-normal text-muted-foreground marker:text-muted-foreground"
      >
        {points.short.map((item) => (
          <li key={item} className="[overflow-wrap:anywhere]">
            {item}
          </li>
        ))}
      </ul>
      <details data-ui="trust-full">
        <summary className="w-fit cursor-pointer text-body-sm font-medium text-honey-text underline decoration-1 underline-offset-4 hover:decoration-2">
          {t.trust.short.full}
        </summary>
        <div className="mt-2 flex flex-col gap-2">
          <p className="text-body-sm font-semibold">{t.trust.title}</p>
          <ul className="flex list-disc flex-col gap-1.5 pl-4 text-body-sm">
            {points.items.map((item) => (
              <li key={item} className="[overflow-wrap:anywhere]">
                {item}
              </li>
            ))}
          </ul>
        </div>
      </details>
      {!accepted && (
        <label htmlFor={boxId} className="inline-flex items-center gap-2 text-body-sm font-medium">
          <input
            id={boxId}
            type="checkbox"
            className="size-4 accent-primary"
            checked={checked}
            onChange={(e) => onCheck(e.currentTarget.checked)}
          />
          {t.trust.accept}
        </label>
      )}
    </div>
  );
}
