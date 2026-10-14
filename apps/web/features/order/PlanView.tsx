'use client';
import type { AssetId, ChainId, Provenance } from '@colosseum/schemas';
import { type ReactNode, useId, useState } from 'react';
import { ChainBadge } from '../../components/ui/ChainBadge';
import { cn } from '../../components/ui/cn';
import {
  HeroFigure,
  Panel,
  PanelBody,
  PanelHead,
  PanelStat,
  Plate,
  StatGrid,
} from '../../components/ui/Panel';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import type { PinSource } from '../../components/ui/provenance';
import { type Lang, LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { dollars } from '../goal/sheet';
import { sampleLine } from '../portfolio-section/parts';
import { Composition, withVenue } from '../shared/Composition';
import { WhyCell } from '../shared/WhyCell';
import { formatBps, tokenName } from './amounts';
import { ASSET_LOGOS } from './asset-logos';
import { displayName, isCashId } from './plain';

// A plan, showing how, whatever it is a plan of (gate INVEST-TWO-PANE): the shape a plan's own page
// and the product pages share. It knows nothing of where the plan came from:
// `PlanPane` hands it a goal's plan (features/order/PlanPane.tsx), a product page a shared portfolio.
//
// It is a picture first (Thom, Oct 7: "the plan on the side panel could be more visual"). The answer
// in one line. The allocation as one thick bar in the brand's wood ramp, each part with its mark and,
// under it, its name and share; a row per holding in one line (mark, name, share bar, dollars, and
// the yield with its pin where the holding has one), with the reason behind a fold. The caller's
// chart. The way out as a meter per tier, with the cost and its pin, and "not measured yet" said once.
// Then the caller's details and its invest step. Nothing here is worked out: every figure is handed
// in. Anything not live is hatched and says so once. Motion is one short settle, and none where the
// person asks for less.

export type PlanViewHolding = {
  /** Where two rows may name the same asset; left out, the asset is the key. */
  key?: string;
  asset: AssetId;
  shareBps: number;
  /** Null where no amount is set yet (a product page before the person types one). */
  amountUsd: number | null;
  /** Null where the holding has no yield to show: the row shows none, never 0%. */
  yield: { lowPct: number; highPct: number; obs: PinSource | null } | null;
  /** One sentence: the reason that decided this holding. */
  why: string;
  /** Every reason, the deciding one first: said behind the fold only where `why` is empty. */
  reasons?: readonly string[];
  /** Its kind, as a word ("Dollar yield"): the table's type column, where the caller knows it. */
  kind?: string;
  /**
   * What selling all of it would cost, with its pin; null where it is not measured. Left out on every
   * holding, the table has no such column.
   */
  exitCost?: { figure: string; obs: PinSource | null } | null;
};

export type PlanViewExitTier = {
  /** What this tier is of, where the way out is told per holding. */
  name?: string;
  /** How fast and how much, in a sentence. */
  text: string;
  /** What leaving costs, as shown ("≤ 0.30%"), with its pin. Left out where it is not measured. */
  cost?: { figure: string; obs: PinSource | null };
  /**
   * How full the tier's meter is, 0 to 1: a figure the caller was given (the share of the plan whose
   * way out is measured, the cost against the limit a plan may cost). Null draws an empty meter.
   * Left out, no meter is drawn: the tier is its figures.
   */
  meter?: number | null;
  /** What a full meter stands for, in a sentence, under it. */
  scale?: string;
};

export type PlanViewExit = {
  tiers: PlanViewExitTier[];
  /** Said once where a cost is not measured: "Not measured yet, so no cost is shown." Never a zero. */
  caveat?: string;
};

export type PlanViewProps = {
  title: string;
  /**
   * The label over the answer is the chain's badge, as the portfolio overview names a chain; the title
   * is then the heading screen readers read ("On Solana").
   */
  chainLabel?: boolean;
  /** Under the title, muted: "Low risk · on Solana · nothing bought yet". */
  sub?: string;
  /** The heading level of the title: 2 on a page, 3 inside another section. */
  level?: 2 | 3;
  /** The answer in one line. A figure in it carries its own pin. */
  answer: ReactNode;
  chain: ChainId;
  /** How the figures are run: anything but `live` hatches the card and says so in one quiet line. */
  provenance: Provenance;
  /** An income plan may hold no stock. Kept for the callers that say it; nothing is drawn from it. */
  profile?: 'income';
  holdings: readonly PlanViewHolding[];
  exit: PlanViewExit;
  /** Under the answer: the ways to close a gap, a meter. */
  aside?: ReactNode;
  /** In the card's one fold, first. */
  more?: ReactNode;
  /** The figures under the answer, each a small muted label over its value: version, since, curator. */
  kpis?: readonly { label: string; value: ReactNode; ui?: string }[];
  /** Between the answer and the holdings: a meter of the answer, or a small figure beside it. */
  under?: ReactNode;
  /** After the holdings: the caller's one chart. */
  figures?: ReactNode;
  /** Under the card: what is behind a fold. */
  details?: ReactNode;
  /** The invest step, or the one button that leads to it. */
  invest?: ReactNode;
};

const percent = (value: number, lang: Lang) =>
  new Intl.NumberFormat(LOCALE[lang], {
    style: 'percent',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value / 100);

/** The same asset identity in allocation segments, labels and holding rows. */
export function AssetMark({ asset, className }: { asset: string; className?: string }) {
  const src = ASSET_LOGOS.get(tokenName(asset).toLowerCase());
  const [failed, setFailed] = useState<string | null>(null);
  const showLogo = src !== undefined && failed !== src;
  const letters = tokenName(asset)
    .replace(/[^A-Za-z]/g, '')
    .slice(0, 3);
  return (
    <span
      aria-hidden="true"
      data-ui="asset-mark"
      className={cn(
        'inline-grid size-6 shrink-0 place-items-center overflow-hidden rounded-asset border border-foreground/40 bg-card font-mono text-[9px]/none font-medium text-foreground',
        className,
      )}
    >
      {showLogo ? (
        // biome-ignore lint/performance/noImgElement: tiny local token artwork, already sized; no remote image service
        <img
          src={src}
          alt=""
          width={24}
          height={24}
          className="size-full object-contain"
          onError={() => setFailed(src)}
        />
      ) : (
        letters
      )}
    </span>
  );
}

/** A meter: a hairline track with what is handed in, filled. Empty where there is nothing measured. */
export function Meter({
  value,
  className,
}: {
  /** 0 to 1, or null for an empty meter. */
  value: number | null;
  className?: string;
}) {
  const filled = value === null ? 0 : Math.min(1, Math.max(0, value));
  return (
    <span
      aria-hidden="true"
      data-ui="meter"
      data-empty={value === null || undefined}
      className={cn('block h-2 w-full border border-border bg-muted', className)}
    >
      <span
        className="block h-full bg-primary motion-safe:transition-[width] motion-safe:duration-300"
        style={{ width: `${filled * 100}%` }}
      />
    </span>
  );
}

export function PlanView({
  title,
  chainLabel,
  chain,
  sub,
  level = 2,
  answer,
  provenance,
  holdings,
  exit,
  aside,
  more,
  kpis = [],
  under,
  figures,
  details,
  invest,
}: PlanViewProps) {
  const t = useT();
  const lang = useLang();
  const paneId = useId();
  const Title = `h${level}` as 'h2' | 'h3';
  const share = (bps: number) => formatBps(bps, LOCALE[lang]);
  const name = (assetId: string) => displayName(assetId, t.plan);
  const keyOf = (h: PlanViewHolding) => h.key ?? h.asset;
  const reasoned = holdings
    .map((h) => ({ h, reasons: h.why ? [h.why] : (h.reasons ?? []) }))
    .filter(({ reasons }) => reasons.length > 0);
  const range = (y: NonNullable<PlanViewHolding['yield']>) =>
    y.lowPct === y.highPct
      ? percent(y.lowPct, lang)
      : t.plan.projectedValue(percent(y.lowPct, lang), percent(y.highPct, lang));
  // not live: said in words on the panel, as the portfolio overview says it (the house kit's Plate)
  const plate =
    provenance !== 'live' ? (
      <Plate ui="sample-note">{sampleLine(t.shell, provenance)}</Plate>
    ) : undefined;
  return (
    <div data-ui="plan-pane" className="flex flex-col gap-6">
      {/* The house kit (STYLE.md), as the portfolio overview has it: a panel that leads with the
          answer and its figures; a panel of the holdings, its head, the strip and the table; then
          the method behind it, behind one fold. */}
      <Panel aria-labelledby={paneId} data-ui="plan-board" data-provenance={provenance}>
        <PanelBody>
          <div data-ui="plan-verdict">
            <HeroFigure
              label={
                <>
                  <Title
                    id={paneId}
                    className={cn('inline text-body-sm font-normal', chainLabel && 'sr-only')}
                  >
                    {title}
                  </Title>
                  {chainLabel && (
                    <span aria-hidden="true">
                      <ChainBadge chain={chain} />
                    </span>
                  )}
                </>
              }
              plate={plate}
              ui="plan-answer"
            >
              {answer}
            </HeroFigure>
          </div>
          {sub && <p className="-mt-2 text-body-sm text-muted-foreground">{sub}</p>}
          <StatGrid spacing="gap-x-6 gap-y-4 sm:grid-cols-4">
            <PanelStat ui="kpi-assets" label={t.plan.kpiAssets}>
              {holdings.filter((h) => h.shareBps > 0).length}
            </PanelStat>
            {kpis.map((kpi) => (
              <PanelStat key={kpi.label} ui={kpi.ui} label={kpi.label}>
                {kpi.value}
              </PanelStat>
            ))}
          </StatGrid>
          {aside && <div className="flex max-w-(--tf-measure-body) flex-col gap-3">{aside}</div>}
          {under}
        </PanelBody>
      </Panel>

      {/* What it holds: the panel's head, one strip of the shares, then the table, each column only
          where some holding has the figure (Composition.tsx, gate WEIGHTS-RING). */}
      <Panel aria-labelledby={`${paneId}-holdings`} data-ui="plan-legs">
        <PanelHead
          id={`${paneId}-holdings`}
          level={3}
          icon={<HoldingsIcon />}
          title={t.plan.holdingsTitle}
          stats={[
            {
              label: t.plan.kpiAssets,
              value: (
                <span className="font-medium">{holdings.filter((h) => h.shareBps > 0).length}</span>
              ),
            },
          ]}
        />
        <Composition
          share={share}
          labels={{ caption: t.plan.holds }}
          columns={[
            ...(holdings.some((h) => h.kind)
              ? [{ key: 'kind', header: t.plan.columns.kind, place: 'before' as const }]
              : []),
            ...(holdings.some((h) => h.amountUsd !== null)
              ? [{ key: 'amount', header: t.plan.columns.amount, numeric: true }]
              : []),
            ...(holdings.some((h) => h.yield)
              ? [{ key: 'yield', header: t.plan.columns.yield, numeric: true }]
              : []),
            ...(holdings.some((h) => h.exitCost !== undefined)
              ? [{ key: 'exit', header: t.plan.columns.exit, numeric: true }]
              : []),
            ...(reasoned.length > 0 ? [{ key: 'why', header: t.plan.columns.why }] : []),
          ]}
          items={holdings.map((h) => {
            const reasons = h.why ? [h.why] : (h.reasons ?? []);
            return {
              key: keyOf(h),
              // "jlUSDC" over "Jupiter Lend"; cash keeps its name whole: "Cash (USDC)"
              ...(isCashId(h.asset) ? { name: name(h.asset) } : withVenue(name(h.asset))),
              asset: h.asset,
              cash: isCashId(h.asset),
              bps: h.shareBps,
              // every holding of the plan is a row, as it always was, even at a share of nothing
              listed: true,
              cells: {
                kind: h.kind,
                amount: h.amountUsd !== null ? dollars(h.amountUsd, lang) : undefined,
                // the yield, only where this holding has one, with its pin
                yield: h.yield ? (
                  <span data-ui="row-yield">
                    <ProvenancePin value={range(h.yield)} obs={h.yield.obs} labels={t.pin} />
                  </span>
                ) : undefined,
                exit: h.exitCost ? (
                  <ProvenancePin value={h.exitCost.figure} obs={h.exitCost.obs} labels={t.pin} />
                ) : h.exitCost === null ? (
                  <span className="text-muted-foreground">{t.plan.notMeasured}</span>
                ) : undefined,
                // why, in one short line; every reason in full behind the fold under the table
                why: reasons[0] ? <WhyCell text={reasons[0]} /> : undefined,
              },
            };
          })}
        />
        {figures && <PanelBody className="border-t border-border">{figures}</PanelBody>}
        {/* The method behind it, behind one fold: why each share, and the way out. */}
        <details data-ui="plan-more" className="border-t border-border px-5 py-4">
          <summary className="w-fit cursor-pointer text-body-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            {t.plan.aboutHoldings}
          </summary>
          <div className="flex flex-col gap-6 pt-4">
            {more}
            {reasoned.length > 0 && (
              <div data-ui="plan-why" className="flex flex-col gap-3">
                <h3 className="text-body-sm font-medium">{t.plan.whyShares}</h3>
                <ul className="flex max-w-(--tf-measure-body) flex-col gap-3 text-body-sm">
                  {reasoned.map(({ h, reasons }) => (
                    <li key={keyOf(h)} data-row-why={keyOf(h)} className="flex flex-col gap-0.5">
                      <span className="font-medium">{name(h.asset)}</span>
                      {reasons.map((reason) => (
                        <span key={reason} className="text-muted-foreground">
                          {reason}
                        </span>
                      ))}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* The way out: a meter per tier, with what leaving costs and its pin. What is not
                  measured is an empty meter, said once. */}
            <div data-ui="exit-plan-line" className="flex flex-col gap-3">
              <h3 className="text-body-sm font-medium">{t.plan.exitPlan}</h3>
              <ul className="flex flex-col gap-3">
                {exit.tiers.map((tier) => (
                  <li
                    key={`${tier.name ?? ''}:${tier.text}`}
                    data-ui="exit-tier"
                    className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1"
                  >
                    <span className="min-w-0 text-body-sm">
                      {tier.name && <span className="font-medium">{tier.name}: </span>}
                      {tier.text}
                    </span>
                    <span className="text-right text-body-sm tabular-nums">
                      {tier.cost ? (
                        <>
                          <span className="text-muted-foreground">{t.plan.costPrefix} </span>
                          <ProvenancePin
                            value={tier.cost.figure}
                            obs={tier.cost.obs}
                            labels={t.pin}
                          />
                        </>
                      ) : null}
                    </span>
                    {tier.meter !== undefined && (
                      <Meter value={tier.meter} className="col-span-2" />
                    )}
                    {tier.meter !== undefined && tier.cost && tier.scale && (
                      <span className="col-span-2 text-caption text-muted-foreground">
                        {tier.scale}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              {exit.caveat && (
                <p data-ui="exit-caveat" className="text-body-sm text-muted-foreground">
                  {exit.caveat}
                </p>
              )}
              <p className="text-body-sm text-muted-foreground">{t.plan.inKind}</p>
            </div>
          </div>
        </details>
      </Panel>
      {details}
      {invest}
    </div>
  );
}

const HoldingsIcon = () => (
  <svg
    aria-hidden="true"
    width={18}
    height={18}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M8 2.5 14 5.5 8 8.5 2 5.5Z" />
    <path d="M2 8.5 8 11.5 14 8.5" />
    <path d="M2 11.5 8 14.5 14 11.5" />
  </svg>
);
