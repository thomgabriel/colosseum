'use client';
import type { Price, VaultResponse } from '@colosseum/schemas';
import Link from 'next/link';
import { type ReactNode, useId } from 'react';
import { buttonClass } from '../../components/ui/button-class';
import { CopyButton } from '../../components/ui/CopyButton';
import { shorten } from '../../components/ui/format';
import { Hint } from '../../components/ui/Hint';
import { MarketNote } from '../../components/ui/MarketNote';
import { Panel, PanelBody, PanelHead, Plate } from '../../components/ui/Panel';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import { pinSourceOfPrice } from '../../components/ui/price-source';
import { Status } from '../../components/ui/StatusMark';
import { type Lang, LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { tokenName } from '../order/amounts';
import { displayName, plainNames } from '../order/plain';
import { explorerAddressTemplateFor } from '../order/readiness';
import { dollars, share, shareTenths, tokens, utc } from '../portfolio/figures';
import { type HoldingRow, holdingsOf, unpriced } from '../portfolio/portfolio';
import { sampleLine } from '../portfolio-section/parts';
import { Composition, withVenue } from './Composition';
import { explorerHeightUrlFor, heightWord } from './explorer-height';
import { type PriceSourceLine, priceSourceLines } from './price-sources';

// What a vault holds, the centre of its page (gate VAULT-PAGE-ACTIONS): one picture and one list
// (Composition.tsx, gate WEIGHTS-RING). Off its plan, the picture is two bars, the planned shares over
// the shares now, and each row says the share now and, where it is off, the planned share and the
// signed difference, coloured by direction and said in words for a screen reader; on its plan, or with
// none, a ring. Each row leads with what the holding is worth, on its price's pin, with the amount under
// its name, rounded to read and exact one hover away. Cash at nothing is no row. The
// figures are written as the portfolio writes them (features/portfolio/figures.ts): the shares rounded
// together so they add up to the whole, the difference the one between the two shares as written.

/** An amount of a token to read at a glance: two decimals from one up, three figures under it. */
const readable = (lang: Lang, decimal: string) => {
  const value = Number(decimal);
  return new Intl.NumberFormat(LOCALE[lang], {
    ...(Math.abs(value) >= 1 ? { maximumFractionDigits: 2 } : { maximumSignificantDigits: 3 }),
  }).format(value);
};

export function VaultHoldings({
  read,
  deposit,
}: {
  read: VaultResponse;
  /** The owner's way to fund an empty vault: the empty card's one action. */
  deposit?: ReactNode;
}) {
  const t = useT();
  const lang = useLang();
  const v = t.shared.vault;
  const titleId = useId();
  const { vault } = read;
  const priceOf = (asset: string): Price | undefined => read.prices.find((p) => p.asset === asset);
  const addressPage = explorerAddressTemplateFor(read.chain, read.provenance === 'mock');
  const rows = holdingsOf(vault);
  // "syrupUSDC · Maple" in a row; cash keeps its name whole
  const named = (row: HoldingRow) =>
    row.cash ? { name: displayName(row.asset, t.plan) } : withVenue(displayName(row.asset, t.plan));
  const nowTenths = shareTenths(rows.map((r) => r.weightBps));
  const plannedTenths = shareTenths(rows.map((r) => r.targetBps));
  const empty = [vault.cash, ...vault.positions].every((h) => /^0+$/.test(h.raw));
  const missing = unpriced(vault);
  // A vault with no target has no plan to be over or under: no difference is drawn under a share.
  const planned = vault.positions.some((position) => position.targetBps > 0);
  // every priced share as written on its plan: one picture, no comparison
  const onTarget =
    planned && rows.every((r, i) => r.valueUsd === null || nowTenths[i] === plannedTenths[i]);

  // not live: said in words on the panel's head, as the portfolio overview says it (the kit's Plate)
  const plate =
    read.provenance !== 'live' ? (
      <Plate ui="sample-note">{sampleLine(t.shell, read.provenance)}</Plate>
    ) : undefined;
  /** Why a holding is there, as the server has it (`why`), in words: its stored reason, or its kind. */
  const whyOf = (row: HoldingRow): string | undefined => {
    const why = row.cash
      ? read.vault.cash.why
      : read.vault.positions.find((p) => p.asset === row.asset)?.why;
    if (!why) return undefined;
    // the engine's sentences name test-network tokens by their test names: said as every screen says them
    if (why.text) return plainNames(why.text);
    if (row.cash) return v.page.keptAsCash;
    return why.cls ? t.shared.product.why[why.cls] : undefined;
  };

  // Nothing held: said once, with what a deposit would go into where the vault has targets, in place of
  // a picture and a list of zeros.
  if (empty) {
    const planned = rows.filter((row) => row.targetBps > 0);
    const targeted = vault.positions.some((position) => position.targetBps > 0);
    const tenths = shareTenths(planned.map((row) => row.targetBps));
    return (
      <Panel aria-labelledby={titleId} data-ui="vault-holdings-panel">
        <PanelHead id={titleId} title={v.page.empty.title} actions={plate} />
        <PanelBody className="min-w-0 items-start">
          <p data-ui="vault-empty" className="max-w-(--tf-measure-body) text-body">
            {deposit
              ? targeted
                ? v.page.empty.withTargets
                : v.page.empty.noTargets
              : t.withdraw.empty}
          </p>
          {targeted && (
            <div
              data-ui="vault-empty-targets"
              className="-mx-5 flex w-[calc(100%+2.5rem)] min-w-0 flex-col"
            >
              <Composition
                share={(bps) => share(lang, bps)}
                labels={{ caption: v.page.empty.targets, weight: v.columns.target }}
                items={planned.map((row, i) => ({
                  key: row.asset,
                  ...named(row),
                  asset: row.asset,
                  cash: row.cash === true,
                  bps: (tenths[i] ?? 0) * 10,
                }))}
              />
            </div>
          )}
          {deposit}
        </PanelBody>
      </Panel>
    );
  }

  const shown = rows.filter(
    // cash at nothing, or dust under a cent, is no row
    (r) => !(r.cash && r.weightBps === 0 && Number(r.valueUsd ?? 0) < 0.01),
  );
  const whys = shown.map((r) => whyOf(r));
  return (
    <Panel aria-labelledby={titleId} data-ui="vault-holdings-panel">
      <PanelHead
        id={titleId}
        title={v.page.holdings}
        stats={[
          {
            label: t.plan.kpiAssets,
            value: <span className="font-medium">{shown.filter((r) => !r.cash).length}</span>,
          },
          ...(planned
            ? [
                {
                  label: v.columns.target,
                  ui: 'vault-on-target',
                  value: (
                    <Status status={onTarget ? 'on-track' : 'watch'}>
                      {onTarget ? v.page.allOnTarget : v.page.offTargetShort}
                    </Status>
                  ),
                },
              ]
            : []),
        ]}
        actions={plate}
      />
      {missing > 0 && (
        // The value leaves out what has no price: said beside the holdings it leaves out.
        <p data-ui="vault-unpriced" className="px-5 pt-4 text-caption text-muted-foreground">
          {t.portfolio.vault.unpriced(missing)}
        </p>
      )}
      <Composition
        // Planned over Now, with the planned share and a status a row, only where they differ; on
        // target the head says so once, and the table is the holdings as they are
        mode={planned && !onTarget ? 'compare' : 'single'}
        changeAs="status"
        share={(bps) => share(lang, bps)}
        labels={{
          caption: v.page.holdings,
          weight: v.columns.weight,
          before: v.columns.target,
          after: v.columns.weight,
          change: v.columns.status,
          difference: v.page.against,
          unchanged: v.page.allOnTarget,
          drift: v.page.drift,
        }}
        columns={[
          { key: 'price', header: v.columns.price, place: 'before', numeric: true },
          { key: 'value', header: v.page.value, place: 'before', numeric: true },
        ]}
        items={shown.map((r, i) => {
          const price = priceOf(r.asset);
          const at = rows.indexOf(r);
          const why = whys[i];
          return {
            key: r.asset,
            ...named(r),
            asset: r.asset,
            cash: r.cash === true,
            // a holding with no price has no share that was worked out: never drawn as 0%
            bps: r.valueUsd === null ? 0 : (nowTenths[at] ?? 0) * 10,
            ...(planned ? { beforeBps: (plannedTenths[at] ?? 0) * 10 } : {}),
            ...(r.valueUsd === null ? { unknown: t.portfolio.vault.noPrice } : {}),
            // every holding is a row, whatever its share
            listed: !/^0+$/.test(r.raw),
            // under the name: the amount, rounded to read and exact one hover away, then why it is
            // there, in full: the pane is narrow, so a column of its own would be cut
            detail: (
              <span className="flex flex-col">
                <span data-ui="holding-detail">
                  <Hint
                    tip={`${tokens(lang, r.display)} ${tokenName(r.asset)}`}
                    label={`${readable(lang, r.display)} ${tokenName(r.asset)}`}
                    // a 24px target, as every control has (WCAG 2.5.8)
                    triggerClassName="min-h-6 tabular-nums"
                  >
                    {readable(lang, r.display)} {tokenName(r.asset)}
                  </Hint>
                </span>
                {why && (
                  <span data-ui="holding-why" className="max-w-[32ch]">
                    {why}
                  </span>
                )}
              </span>
            ),
            cells: {
              price: price ? (
                <span className="inline-flex flex-col items-end">
                  <ProvenancePin
                    value={dollars(lang, price.usdPerToken)}
                    // each address in the price's details links to this network's explorer
                    obs={{ ...pinSourceOfPrice(price), explorer: addressPage }}
                    what={v.columns.price}
                    {...(price.market === 'closed' ? { detail: t.shell.marketClosedWhy } : {})}
                    labels={t.pin}
                  />
                  <MarketNote market={price.market} label={t.shell.marketClosed} />
                </span>
              ) : (
                // a missing price says why, one hover, focus or tap away
                <Hint tip={t.portfolio.vault.noPriceWhy} label={t.portfolio.vault.noPrice}>
                  —
                </Hint>
              ),
              // what it is worth, on the pin of the price it stands on
              value:
                r.valueUsd !== null && price ? (
                  <ProvenancePin
                    value={dollars(lang, r.valueUsd)}
                    obs={{ ...pinSourceOfPrice(price), explorer: addressPage }}
                    what={v.page.value}
                    labels={t.pin}
                  />
                ) : (
                  '—'
                ),
            },
          };
        })}
      />
    </Panel>
  );
}

/** A long address, shortened, with the whole of it to copy and in its title. */
function Address({ value, what }: { value: string; what: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      {/* the whole address one hover, focus or tap away, as every tooltip is (Hint) */}
      <Hint tip={value} label={what}>
        <span className="font-mono text-source">{shorten(value, 6, 6)}</span>
      </Hint>
      <CopyButton value={value} what={what} />
    </span>
  );
}

/**
 * Where the prices come from, each source once: a price account with the entries it is read at, its
 * address shortened with the whole of it to copy; any other source word for word, behind a fold.
 */
function PriceSources({ sources }: { sources: string[] }) {
  const t = useT();
  const lang = useLang();
  const p = t.shared.vault.page;
  const lines = priceSourceLines(sources);
  const accounts = lines.filter(
    (line): line is Extract<PriceSourceLine, { kind: 'account' }> => line.kind === 'account',
  );
  const texts = lines.flatMap((line) => (line.kind === 'text' ? [line.text] : []));
  const list = (entries: number[]) =>
    new Intl.ListFormat(LOCALE[lang], { type: 'conjunction' }).format(entries.map(String));
  return (
    <div className="flex flex-col gap-2">
      {accounts.length > 0 && (
        <ul className="flex flex-col gap-2">
          {accounts.map((line) => (
            <li
              key={`${line.layout}:${line.account}:${line.owner}`}
              data-ui="vault-price-account"
              className="flex flex-col gap-0.5"
            >
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span>{line.layout}</span>
                <span aria-hidden="true" className="text-muted-foreground">
                  ·
                </span>
                <Address value={line.account} what={p.copyPriceAccount} />
                <span aria-hidden="true" className="text-muted-foreground">
                  ·
                </span>
                <span className="tabular-nums">
                  {p.priceEntries(line.entries.length, list(line.entries))}
                </span>
              </span>
              <span className="flex flex-wrap items-center gap-x-1 text-caption text-muted-foreground">
                {p.priceOwner} <Address value={line.owner} what={p.copyPriceOwner} />
              </span>
            </li>
          ))}
        </ul>
      )}
      {texts.length > 0 && (
        <details data-ui="vault-price-sources-written">
          <summary className="w-fit cursor-pointer text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            {p.sourcesAsWritten(texts.length)}
          </summary>
          <ul className="flex flex-col gap-1 pt-2 font-mono text-source [overflow-wrap:anywhere]">
            {texts.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/**
 * The vault's own facts, behind one fold at the foot of its page: its address, its owner, what it
 * follows, auto-follow, when it was read and where its prices come from.
 */
export function VaultDetails({ read, mine = false }: { read: VaultResponse; mine?: boolean }) {
  const t = useT();
  const lang = useLang();
  const v = t.shared.vault;
  const { vault } = read;
  const follows = vault.recipeOnchainId;
  const sources = [...new Set(read.prices.map((price) => price.source))];
  const mock = read.provenance === 'mock';
  const height =
    !mock && read.blockOrSlot
      ? new Intl.NumberFormat(LOCALE[lang]).format(BigInt(read.blockOrSlot))
      : null;
  const heightUrl =
    !mock && read.blockOrSlot ? explorerHeightUrlFor(read.chain, read.blockOrSlot, false) : null;
  return (
    <details data-ui="vault-details" className="border-t border-border pt-4">
      <summary className="w-fit cursor-pointer text-body-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        {v.page.details}
      </summary>
      <dl className="grid gap-x-6 gap-y-2 pt-3 text-body-sm sm:grid-cols-[auto_1fr] sm:items-center">
        <dt className="text-muted-foreground">{v.address}</dt>
        <dd data-ui="vault-address">
          <Address value={vault.address} what={v.page.copyVault} />
        </dd>
        <dt className="text-muted-foreground">{v.owner}</dt>
        <dd data-ui="vault-owner">
          <Address value={vault.owner} what={v.page.copyOwner} />
        </dd>
        <dt className="text-muted-foreground">{v.follows}</dt>
        <dd className="[overflow-wrap:anywhere]">
          {follows ? (
            <span className="font-mono text-source" title={follows}>
              {shorten(follows, 6, 6)} · {v.version(vault.acceptedVersion)}
            </span>
          ) : (
            v.followsNothing
          )}
        </dd>
        <dt className="text-muted-foreground">{v.autoFollow}</dt>
        <dd data-ui="vault-auto-follow" className="flex flex-col gap-1">
          <span>{vault.autoFollow ? v.on : v.off}</span>
          {/* Auto-follow is switched on where the vault's portfolio is: its page offers the switch. A
              withdrawal switches it off, and this is the way back. Said to the owner, beside the setting. */}
          {mine && follows && !vault.autoFollow && (
            <span
              data-ui="vault-auto-follow-off"
              className="max-w-(--tf-measure-body) text-muted-foreground"
            >
              {v.autoFollowOff}{' '}
              <Link href="/shelf" className={buttonClass({ variant: 'link' })}>
                {v.autoFollowWhere}
              </Link>
            </span>
          )}
        </dd>
        <dt className="text-muted-foreground">{v.page.readAt}</dt>
        <dd data-ui="vault-read-at" className="flex flex-wrap items-baseline gap-x-2">
          {/* the slot or block the chain was at when it was read, to its explorer; the mock has none */}
          {height !== null && (
            <>
              <span>
                {v.page.height[heightWord(read.chain)]}{' '}
                {heightUrl ? (
                  <a
                    data-ui="vault-height"
                    href={heightUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-source underline decoration-1 underline-offset-4 hover:decoration-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    {height}
                  </a>
                ) : (
                  <span data-ui="vault-height" className="font-mono text-source">
                    {height}
                  </span>
                )}
              </span>
              <span aria-hidden="true" className="text-muted-foreground">
                ·
              </span>
            </>
          )}
          <time dateTime={vault.observedAt}>{utc(lang, vault.observedAt)}</time>
        </dd>
        {sources.length > 0 && (
          <>
            <dt className="text-muted-foreground">{v.page.priceSources}</dt>
            <dd data-ui="vault-price-sources">
              <PriceSources sources={sources} />
            </dd>
          </>
        )}
      </dl>
    </details>
  );
}
