'use client';
import type { ChainId, MixReview, Target } from '@colosseum/schemas';
import { useId } from 'react';
import { Button } from '../../components/ui/Button';
import { Panel, PanelBody, PanelHead } from '../../components/ui/Panel';
import { StatusMark } from '../../components/ui/StatusMark';
import { LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { changeFigures, changeHero, shareItems } from '../order/order-summary';
import { displayName } from '../order/plain';
import { onMock } from '../order/readiness';
import { Fold, OrderHero, OrderStats, Rounded, ShareList } from '../order/SignFlow';
import { unitsFor } from '../order/units';
import { useWalletPort } from '../wallet/WalletProvider';
import { MixReviewAck, MixReviewLines } from './MixReviewCard';
import { unticked } from './mix';

// New targets for a vault, reviewed as the first screen after "Apply" (gate SIGN-ONE-STEP): what
// changes in a few words, the vault's targets now beside the new ones, the server's warnings to tick,
// every line with its price and exit behind "Details", and one "Continue" that makes the order. The
// steps are signed after it, one to a screen; nothing is signed here.

export function ChangeReview({
  chain,
  review,
  before,
  holds,
  ticked,
  onTick,
  busy,
  changed,
  onConfirm,
  onBack,
}: {
  chain: ChainId;
  review: MixReview;
  /** The vault's targets as its page read them; null where they are not known. */
  before: readonly Target[] | null;
  /** What the vault holds now, as shares of its value: what the swaps start from. */
  holds: readonly Target[] | null;
  ticked: ReadonlySet<string>;
  onTick: (id: string, on: boolean) => void;
  busy: boolean;
  /** The server answered a new review to a confirm: its figures moved since the person looked. */
  changed?: boolean;
  onConfirm: () => void;
  /** To the weights, to change them. */
  onBack: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const port = useWalletPort();
  const f = t.order.flow;
  const titleId = useId();
  const locale = LOCALE[lang];
  const units = unitsFor(chain, onMock(port, chain));
  const words = { units, t, locale };
  // one name for a holding everywhere on the screen: the rows', the warnings' and the details'
  const named = (asset: string) => displayName(asset, t.plan);
  const left = unticked(review, ticked).length;
  const share = (bps: number) =>
    new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(
      bps / 10_000,
    );
  const figures = changeFigures(review.targets, holds, review.amountUsd, words);
  const plate =
    review.provenance === 'sandbox'
      ? { text: t.shell.testNetworkLine, ui: 'sample-tag' }
      : review.provenance === 'mock'
        ? { text: t.shell.mockAnnounce, ui: 'sample-tag' }
        : null;
  return (
    <div data-ui="change-review">
      <Panel aria-labelledby={titleId}>
        <PanelHead id={titleId} title={f.changeTitle} />
        <PanelBody className="min-w-0">
          <OrderHero
            label={f.label.change}
            figure={changeHero(review.targets, before, words)}
            plate={plate}
          />
          <OrderStats
            stats={
              figures
                ? [
                    // worked out from the vault's prices before any quote: said as estimates, so
                    // the quoted figures the steps then show never read as the same figure changed
                    {
                      label: f.stat.swappedEstimate,
                      value: <Rounded figure={figures.swapped} />,
                      ui: 'stat-swapped',
                    },
                    {
                      label: f.stat.worstEstimate,
                      value: `${figures.worst.shown} · ${figures.pct}`,
                      ui: 'stat-worst',
                    },
                  ]
                : []
            }
          />
          {figures && (
            <p data-ui="change-estimate" className="text-caption text-muted-foreground">
              {f.stat.estimate}
            </p>
          )}
          {changed && (
            <p role="status" className="flex items-start gap-1.5 text-body-sm">
              <StatusMark status="watch" className="mt-1.5" />
              <span>{t.mix.review.changed}</span>
            </p>
          )}
          <ShareList
            caption={f.picture.targets}
            items={shareItems(review.targets, before, words)}
            share={share}
            labels={{
              before: f.picture.before,
              after: f.picture.next,
              unchanged: f.picture.unchanged,
              holding: f.table.holding,
              change: f.table.change,
              points: (bps: number) =>
                f.picture.points(
                  new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(bps / 100),
                ),
            }}
          />
          <MixReviewAck review={review} ticked={ticked} onTick={onTick} named={named} />
          <div className="flex flex-col gap-2">
            <Button
              variant="primary"
              className="w-full"
              data-action="mix-confirm"
              busy={busy}
              busyLabel={t.mix.vault.confirming}
              disabled={left > 0}
              onClick={onConfirm}
            >
              {f.continue}
            </Button>
            <Button variant="link" className="self-start" disabled={busy} onClick={onBack}>
              {f.changeWeights}
            </Button>
          </div>
          <Fold ui="change-details" label={f.details}>
            <MixReviewLines review={review} named={named} />
          </Fold>
        </PanelBody>
      </Panel>
    </div>
  );
}
