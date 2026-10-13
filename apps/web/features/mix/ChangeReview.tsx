'use client';
import type { ChainId, MixReview, Target } from '@colosseum/schemas';
import { Button } from '../../components/ui/Button';
import { Card, CardBody } from '../../components/ui/Card';
import { StatusMark } from '../../components/ui/StatusMark';
import { LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { changeHero, shareItems } from '../order/order-summary';
import { onMock } from '../order/readiness';
import { Fold, Hero, ShareList } from '../order/SignFlow';
import { unitsFor } from '../order/units';
import { useWalletPort } from '../wallet/WalletProvider';
import { MixReviewLines, MixReviewWarnings } from './MixReviewCard';
import { unticked } from './mix';

// New targets for a vault, reviewed as the first screen after "Apply" (gate SIGN-ONE-STEP): what
// changes in a few words, the vault's targets now beside the new ones, the server's warnings to tick,
// every line with its price and exit behind "Details", and one "Continue" that makes the order. The
// steps are signed after it, one to a screen; nothing is signed here.

export function ChangeReview({
  chain,
  review,
  before,
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
  const locale = LOCALE[lang];
  const words = { units: unitsFor(chain, onMock(port, chain)), t, locale };
  const left = unticked(review, ticked).length;
  const share = (bps: number) =>
    new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(
      bps / 10_000,
    );
  return (
    <div data-ui="change-review">
      <Card
        as="section"
        aria-label={t.mix.review.title}
        mock={review.provenance !== 'live'}
        mockLabels={{
          announce: review.provenance === 'mock' ? t.shell.mockAnnounce : t.shell.testNetworkLine,
        }}
      >
        <CardBody className="flex min-w-0 flex-col gap-6">
          <div className="flex flex-col gap-2">
            <Hero>{changeHero(review.targets, before, words)}</Hero>
            <p className="max-w-(--tf-measure-body) text-body text-muted-foreground">
              {f.changeLead}
            </p>
          </div>
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
              before: f.picture.now,
              after: f.picture.next,
              unchanged: f.picture.unchanged,
            }}
          />
          <MixReviewWarnings review={review} ticked={ticked} onTick={onTick} />
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
            <MixReviewLines review={review} />
          </Fold>
        </CardBody>
      </Card>
    </div>
  );
}
