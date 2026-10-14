'use client';
import {
  type ChainId,
  chainFamily,
  type SharedFamily,
  type SharedRecipe,
  type Target,
  type VersionsResponse,
} from '@colosseum/schemas';
import Link from 'next/link';
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { buttonClass } from '../../components/ui/button-class';
import { DataTable } from '../../components/ui/DataTable';
import { utcMinute } from '../../components/ui/ExecutionList';
import { shorten } from '../../components/ui/format';
import { Hint } from '../../components/ui/Hint';
import { PAGE_BACK, PAGE_TITLE } from '../../components/ui/heading';
import { Icon } from '../../components/ui/Icon';
import { KIT_CELL, KIT_ROW, KitTable, KitTh } from '../../components/ui/KitTable';
import { Panel } from '../../components/ui/Panel';
import { StatusMark } from '../../components/ui/StatusMark';
import { LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { ChainChoice } from '../account/ChainChoice';
import { dollars } from '../goal/sheet';
import { formatBps, tokenName } from '../order/amounts';
import type { CallFailure } from '../order/order-api';
import { PlanView } from '../order/PlanView';
import { networkFor } from '../order/readiness';
import { unitsFor } from '../order/units';
import { useApiFetch, useWalletPort } from '../wallet/WalletProvider';
import { type ChainCheck, useChainRecipe } from './chain-recipe';
import { FamilyActions } from './FamilyActions';
import { isPlatformCreator } from './platform';
import { holdingsOf, kindsSaid, withCashLine } from './product-figures';
import { SourceMark } from './SourceMark';
import { readFamily, readPortfolio, readVersions } from './shared-api';
import type { FollowTerms } from './terms';
import { useSharedPerson } from './use-person';
import { FAMILY_PANES, FamilyWait } from './waits';

// A shared portfolio's page (DESIGN-VAULT section 11), in two panes: on the left its name and creator,
// each recipe a wallet of the person's signs on (one at a time: a portfolio with a recipe on both chains
// asks which, gate CHAIN-AT-THE-PLAN; a buy is on that recipe's chain, ONE-CHAIN) with the version in
// effect and the one that waits, and every version in a fold; on the right what can be done with it
// (FamilyActions.tsx): a new vault that copies it, or a vault of the person's to follow it with, and the
// vaults that follow it already, with auto-follow (gate GOLD-ONE-TAP) and the prompt when it changed. The version and weights are read from the chain by this app
// where it can (chain-recipe.ts): what it reads is what is shown and what a follow is held to, and our
// server's answer is shown as unverified where it cannot. The creator's words are text.

type Load = { kind: 'loading' } | { kind: 'read'; family: SharedFamily } | { kind: CallFailure };

/** What a follow is held to: the chain's account and version where read, the API's otherwise. */
export type Followed = {
  follow: FollowTerms;
  targets: Target[] | null;
  source: 'chain' | 'api';
  /** The chain has no such portfolio: nothing is followed. */
  missing: boolean;
  /** This app could have read the chain and could not: nothing is followed (`failed`). */
  tampered: boolean;
  /** Read from the chain, the version holds a token this app does not list. */
  unlisted: boolean;
  /**
   * The portfolio's id is not the one its slug gives: it was not published through the app, so a
   * follow held to `familyIdOf(slug)` cannot be signed, and none is offered (gate FAMILY-ID).
   */
  foreign: boolean;
};

export function followedOf(recipe: SharedRecipe, check: ChainCheck): Followed | null {
  if (check.state === 'reading') return null;
  if (check.state === 'missing')
    return {
      follow: { recipeOnchainId: recipe.onchainId, version: recipe.active.version },
      targets: null,
      source: 'chain',
      missing: true,
      tampered: false,
      unlisted: false,
      foreign: false,
    };
  if (check.state === 'failed')
    return {
      follow: { recipeOnchainId: recipe.onchainId, version: recipe.active.version },
      targets: null,
      source: 'chain',
      missing: false,
      tampered: true,
      unlisted: false,
      foreign: false,
    };
  if (check.state === 'read')
    return {
      follow: { recipeOnchainId: check.recipe.address, version: check.recipe.active.version },
      targets: check.targets,
      source: 'chain',
      missing: false,
      tampered: false,
      unlisted: check.targets === null,
      foreign: false,
    };
  return {
    follow: { recipeOnchainId: recipe.onchainId, version: recipe.active.version },
    targets: recipe.active.components,
    source: 'api',
    missing: false,
    tampered: false,
    unlisted: false,
    foreign: check.state === 'unverified' && check.why === 'family-id',
  };
}

export function FamilyScreen({ slug }: { slug: string }) {
  const t = useT();
  const apiFetch = useApiFetch();
  const port = useWalletPort();
  const person = useSharedPerson();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [round, setRound] = useState(0);
  // A buy was refused because the portfolio has a newer version: the page reads it again and says so.
  const [changed, setChanged] = useState(false);
  // The recipe on the page, for a portfolio the person can use on more than one chain.
  const [picked, setPicked] = useState<ChainId | null>(null);
  // A deposit was pressed and has not ended: the recipe on the page is the one it is signing on, so
  // nothing here may change the chain under it (the section would be drawn again and the run cut).
  const [running, setRunning] = useState(false);
  const show = (chain: ChainId) => {
    if (!running) setPicked(chain);
  };
  const titleId = useId();
  const settled = person.kind !== 'loading';

  // biome-ignore lint/correctness/useExhaustiveDependencies: `round` reads the portfolio again
  useEffect(() => {
    if (!settled) return;
    let mine = true;
    // What was read stays on the page while it is read again: only the first read shows the wait.
    setLoad((was) => (was.kind === 'read' ? was : { kind: 'loading' }));
    // Every recipe: which of them the person can use is worked out here, from their wallets.
    readFamily(apiFetch, slug, null).then((read) => {
      if (mine) setLoad(read.kind === 'read' ? { kind: 'read', family: read.value.family } : read);
    });
    return () => {
      mine = false;
    };
  }, [apiFetch, slug, settled, round]);

  if (load.kind === 'loading') return <FamilyWait />;
  if (load.kind !== 'read')
    return (
      <section aria-labelledby={titleId} className="flex flex-col items-start gap-4">
        <h1 id={titleId} className={PAGE_TITLE}>
          {load.kind === 'no-plan' ? t.shared.family.missing : t.shared.shelf.title}
        </h1>
        {load.kind !== 'no-plan' && (
          <p className="max-w-(--tf-measure-body) text-body">
            {load.kind === 'busy'
              ? t.shell.slowDown
              : load.kind === 'unreadable'
                ? t.shared.shelf.failure.unreadable
                : t.shared.shelf.failure.unreachable}
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          {load.kind !== 'no-plan' && (
            <Button variant="secondary" onClick={() => setRound((n) => n + 1)}>
              {t.shared.shelf.failure.retry}
            </Button>
          )}
          <Link href="/products" className={buttonClass({ variant: 'secondary' })}>
            {t.shared.family.backToShelf}
          </Link>
        </div>
      </section>
    );

  const { family } = load;
  const f = t.shared.family;
  // Signed in: the recipes on a chain a wallet of theirs signs on, one on the page at a time,
  // starting with the chain their new plans start on. Signed out: every recipe, and nothing offered.
  const usable =
    person.kind === 'ready' ? family.recipes.filter((r) => person.held.includes(r.chain)) : [];
  const chosen =
    usable.find((r) => r.chain === picked) ??
    (person.kind === 'ready' ? usable.find((r) => r.chain === person.chain) : undefined) ??
    usable[0] ??
    null;
  const recipes = chosen ? [chosen] : family.recipes;
  const nameOf = (chain: ChainId) => port.network(chain)?.name ?? t.chain.names[chain];
  return (
    <div data-ui="family-screen" className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <Link href="/products" className={`${buttonClass({ variant: 'link' })} ${PAGE_BACK}`}>
          {f.backToShelf}
        </Link>
        <h1 id={titleId} className={`${PAGE_TITLE} [overflow-wrap:anywhere]`}>
          {family.name}
        </h1>
        {/* One line under the name: the creator's own words (F5) */}
        {family.copy && (
          <p className="max-w-(--tf-measure-body) whitespace-pre-line text-body-lg text-muted-foreground [overflow-wrap:anywhere]">
            {family.copy}
          </p>
        )}
      </header>

      {chosen && usable.length > 1 && (
        <ChainChoice
          data-ui="family-chain"
          className="max-w-md"
          legend={f.which}
          hint={running ? f.whichLocked : f.whichHint}
          value={chosen.chain}
          disabled={running}
          onChange={show}
          options={usable.map((r) => ({
            chain: r.chain,
            name: nameOf(r.chain),
            address: port.active(chainFamily(r.chain))?.address ?? null,
            provenance: r.provenance,
          }))}
          labels={{
            testNetwork: t.shell.testNetworkLine,
            sample: t.shell.sample,
            wallet: t.chain.choice.wallet,
            saving: t.chain.switch.saving,
          }}
        />
      )}
      {recipes.map((recipe, i) => (
        <RecipeSection
          key={recipe.chain}
          // every version, in a fold under the last recipe's plan
          versions={
            i === recipes.length - 1 ? (
              <VersionsPanel slug={family.slug} chain={chosen?.chain ?? null} />
            ) : undefined
          }
          family={family}
          recipe={recipe}
          changed={changed}
          onRunning={(now) => {
            // The run is on the recipe on the page. Where the page's own choice was never touched
            // that recipe came from where the person's new plans start, which /invest can change in
            // another tab: it is pinned here, so the section is not drawn again under the run.
            if (now) setPicked(recipe.chain);
            setRunning(now);
          }}
          onVersionChanged={() => {
            setChanged(true);
            setRound((n) => n + 1);
          }}
          onReread={() => setRound((n) => n + 1)}
        />
      ))}
      {chosen && usable.length > 1 && (
        <VaultsElsewhere
          family={family}
          chain={chosen.chain}
          among={usable.map((r) => r.chain)}
          locked={running}
          onShow={show}
        />
      )}
    </div>
  );
}

/** Where the actions pane is held in view: under the bar, 96px from the window's top. */
const STICKY_TOP = 96;

/**
 * Whether the actions pane fits the window under the bar: then it stays in view as the plan scrolls.
 * Taller (a deposit's steps, a follow's quote), it scrolls with the page, so nothing of it is ever
 * out of reach under the window's foot.
 */
function useStickyFit() {
  const [fits, setFits] = useState(true);
  const node = useRef<HTMLElement | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const measure = useCallback(() => {
    const el = node.current;
    if (el) setFits(el.scrollHeight <= window.innerHeight - STICKY_TOP - 16);
  }, []);
  const ref = useCallback(
    (el: HTMLElement | null) => {
      observer.current?.disconnect();
      node.current = el;
      if (!el || typeof ResizeObserver === 'undefined') return;
      observer.current = new ResizeObserver(measure);
      observer.current.observe(el);
      measure();
    },
    [measure],
  );
  useEffect(() => {
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure]);
  return { ref, fits };
}

/** One chain's recipe, read from that chain where this app can, with what the person can do with it. */
function RecipeSection({
  family,
  recipe,
  changed,
  onRunning,
  onVersionChanged,
  onReread,
  versions,
}: {
  family: SharedFamily;
  recipe: SharedRecipe;
  /** Under the plan: every version. */
  versions?: ReactNode;
  /** A deposit was pressed (true) or ended, stopped or was put off (false): the page locks its chain. */
  onRunning: (running: boolean) => void;
  /** A buy was refused for a newer version, and the page read the portfolio again. */
  changed: boolean;
  onVersionChanged: () => void;
  onReread: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const aside = useStickyFit();
  // The person on this recipe's own chain, with their wallet there: a buy and a follow are on it.
  const person = useSharedPerson(recipe.chain);
  // A deposit is being signed: the chain and the card's amount are locked until it ends.
  const [pressed, setPressedHere] = useState(false);
  // What is typed and ticked on the amount card, kept here: the card is drawn again whenever the
  // recipe is read again, and the person's amount and tick stay with them.
  const [amountText, setAmountText] = useState('');
  const [ticked, setTicked] = useState(false);
  // the tick is the person's own: another person signed in on this page has not ticked it
  const tickedBy = person.kind === 'ready' ? person.userId : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tickedBy` is whose tick it is
  useEffect(() => setTicked(false), [tickedBy]);
  const setPressed = (now: boolean) => {
    setPressedHere(now);
    onRunning(now);
  };
  const f = t.shared.family;
  const chainName = t.chain.names[recipe.chain];
  const own = person.kind === 'ready' && person.chain === recipe.chain;
  const mock = own ? person.mock : recipe.provenance === 'mock';
  const check = useChainRecipe(recipe.chain, mock, family, recipe);
  const followed = followedOf(recipe, check);
  // A check that found something wrong is not folded away: the read failed, the chain has no such
  // portfolio, it differs from what our server said, or its words match no version on the chain.
  const alarm =
    check.state === 'failed' ||
    check.state === 'missing' ||
    (check.state === 'read' && (check.differs || check.textMatches === null));
  const locale = LOCALE[lang];
  const read = check.state === 'read' ? check.recipe : null;
  // What is shown is the chain's where it was read, our server's otherwise. A line whose token this
  // app does not list is shown by its mint, so nothing the version holds is left out of sight.
  const lines = (components: { asset: string | null; mint: string; weightBps: number }[]): Line[] =>
    components.map((c) =>
      c.asset
        ? { asset: c.asset, weightBps: c.weightBps }
        : { asset: c.mint, weightBps: c.weightBps, mint: c.mint },
    );
  const active: { version: number; effectiveAt: number; components: Line[] } = read
    ? {
        version: read.active.version,
        effectiveAt: read.active.effectiveAt,
        components: lines(read.active.components),
      }
    : recipe.active;
  const pending = read
    ? read.pending && {
        version: read.pending.version,
        effectiveAt: read.pending.effectiveAt,
        components: lines(read.pending.components),
      }
    : recipe.pending;

  const blocked =
    person.kind !== 'ready'
      ? null
      : person.off || !person.signable
        ? f.chainNotReady(chainName)
        : followed?.missing
          ? f.missingOnChain(chainName)
          : followed?.tampered
            ? f.tampered(chainName)
            : followed?.unlisted
              ? f.unlisted
              : followed?.foreign
                ? f.foreign
                : null;
  const p = t.shared.product;
  // What the lines leave of 100% is held in cash (SHARED-RULES-V2): shown as a line of its own.
  const holdings = holdingsOf(
    recipe,
    withCashLine(active.components, recipe.chain, unitsFor(recipe.chain, mock)?.cash ?? null),
    t,
  );
  const unmeasured = holdings.filter((h) => !h.exit);
  const list = (items: string[]) =>
    new Intl.ListFormat(locale, { type: 'conjunction' }).format(items);
  return (
    <div data-ui="family-panes" className={FAMILY_PANES}>
      <div className="flex min-w-0 flex-col gap-6">
        <PlanView
          title={f.recipe(chainName)}
          chainLabel
          answer={p.answer(kindsSaid(holdings, locale, t.plan.kinds), chainName)}
          chain={recipe.chain}
          provenance={recipe.provenance}
          holdings={holdings.map((h) => ({
            asset: h.asset,
            shareBps: h.shareBps,
            // no amount is set on this page: the row shows the share alone
            amountUsd: null,
            // the holding's own reading after the haircut, which is what the row's label says it is
            yield: h.yield
              ? {
                  lowPct: h.yield.afterHaircut * 100,
                  highPct: h.yield.afterHaircut * 100,
                  obs: h.yield.obs,
                }
              : null,
            // what it is, where the server says; a kind it did not send says nothing of the token
            why: h.cls ? h.why : '',
            // its kind, and what selling all of it costs where Bearing measures it
            kind: h.cls ? t.plan.kinds[h.cls] : '—',
            exitCost: h.exit
              ? { figure: p.exit.cost(formatBps(h.exit.maxCostBps, locale)), obs: h.exit.obs }
              : null,
          }))}
          exit={{
            tiers: holdings.flatMap((h) =>
              h.exit
                ? [
                    {
                      name: h.name,
                      text: (h.exit.lowerBound ? p.exit.atLeast : p.exit.about)(
                        dollars(Math.floor(h.exit.capacityUsd), lang),
                        h.exit.windowDays,
                      ),
                      cost: {
                        figure: p.exit.cost(formatBps(h.exit.maxCostBps, locale)),
                        obs: h.exit.obs,
                      },
                      // No meter: this size is the one measured at exactly the cost bound, so a
                      // bar of the cost against it would always be full and say nothing.
                    },
                  ]
                : [],
            ),
            ...(unmeasured.length > 0
              ? { caveat: p.exit.notMeasured(list(unmeasured.map((h) => h.name))) }
              : {}),
          }}
          kpis={[
            { label: p.kpi.version, value: active.version, ui: 'kpi-version' },
            {
              label: p.kpi.since,
              value: utcMinute(new Date(active.effectiveAt * 1000).toISOString()),
              ui: 'kpi-since',
            },
            {
              label: p.publisher,
              ui: 'kpi-publisher',
              value: (
                // who published it, by address: in view (gate PRODUCTS-PLAN-PANE), the whole of it a
                // hover away
                <span className="inline-flex flex-wrap items-baseline gap-x-2">
                  <Hint tip={read?.creator ?? recipe.creator} label={p.publisher}>
                    <span data-ui="creator" className="font-mono text-source">
                      {shorten(read?.creator ?? recipe.creator, 4, 4)}
                    </span>
                  </Hint>
                  {isPlatformCreator(
                    networkFor(recipe.chain, mock),
                    recipe.chain,
                    read?.creator ?? recipe.creator,
                  ) && <span className="text-caption">{t.shared.shelf.card.platform}</span>}
                </span>
              ),
            },
          ]}
          aside={
            <>
              {/* Where the version and weights come from, and words that match no version: never
                folded away (the flow audit, finding 41). */}
              {check.state === 'read' && check.textMatches === null && <TextMark matches={null} />}
              {/* Never folded away, before the deposit or during it: said once, here. */}
              <SourceMark check={check} chain={recipe.chain} />
            </>
          }
          figures={
            pending ? (
              <div className="flex flex-col gap-2 border-t border-border pt-4">
                <h3 className="text-h4 font-semibold">
                  {f.waits(
                    pending.version,
                    utcMinute(new Date(pending.effectiveAt * 1000).toISOString()),
                  )}
                </h3>
                <p className="max-w-(--tf-measure-body) text-body-sm">{f.waitsLead}</p>
                <WeightsTable
                  rows={pending.components}
                  locale={locale}
                  caption={f.versionN(pending.version)}
                />
              </div>
            ) : undefined
          }
          details={
            // The routine check of its words, behind a fold unless a check found something wrong.
            check.state !== 'read' || check.textMatches === 'pending' ? (
              <details data-ui="family-checks" open={alarm || undefined}>
                <summary className="w-fit cursor-pointer text-body-sm font-medium text-honey-text underline decoration-1 underline-offset-4 hover:decoration-2">
                  {t.plan.details}
                </summary>
                <div className="mt-3 flex flex-col gap-2">
                  <TextMark matches={check.state === 'read' ? check.textMatches : 'unchecked'} />
                </div>
              </details>
            ) : undefined
          }
        />
        {versions}
      </div>
      {/* The two ways to use it, beside the plan and in view as it scrolls (F1) */}
      <aside
        ref={aside.ref}
        data-sticky={aside.fits}
        className="flex min-w-0 flex-col gap-4 lg:data-[sticky=true]:sticky lg:data-[sticky=true]:top-24"
      >
        <FamilyActions
          family={family}
          recipe={recipe}
          person={person}
          own={own}
          mock={mock}
          followed={followed}
          blocked={blocked}
          changed={changed}
          targets={followed?.targets ?? null}
          shown={`${recipe.active.version}:${active.version}`}
          entry={{ text: amountText, onText: setAmountText, ticked, onTick: setTicked }}
          running={pressed}
          onRunning={setPressed}
          onVersionChanged={() => {
            // No order is made for the new version until the person has seen it and typed an
            // amount again.
            setPressed(false);
            setAmountText('');
            onVersionChanged();
          }}
          onReread={onReread}
        />
      </aside>
    </div>
  );
}

/**
 * The person's vaults that follow this portfolio on another chain than the recipe on the page. A vault
 * is updated on its own chain, so the page says where it is, with the way to show that chain's recipe.
 */
function VaultsElsewhere({
  family,
  chain,
  among,
  locked,
  onShow,
}: {
  family: SharedFamily;
  /** The chain of the recipe on the page. */
  chain: ChainId;
  /** The chains whose recipe the page can show for this person. */
  among: readonly ChainId[];
  /** A deposit is running on the recipe on the page: the way to another chain waits for it. */
  locked: boolean;
  onShow: (chain: ChainId) => void;
}) {
  const t = useT();
  const f = t.shared.family;
  const apiFetch = useApiFetch();
  const [following, setFollowing] = useState<ChainId[]>([]);
  useEffect(() => {
    let mine = true;
    const recipeOn = new Map(family.recipes.map((r) => [r.chain, r.onchainId]));
    readPortfolio(apiFetch).then((read) => {
      if (!mine || read.kind !== 'read') return;
      setFollowing(
        read.value.chains
          .filter((entry) =>
            entry.vaults.some(
              (v) => v.recipeOnchainId !== null && v.recipeOnchainId === recipeOn.get(entry.chain),
            ),
          )
          .map((entry) => entry.chain),
      );
    });
    return () => {
      mine = false;
    };
  }, [apiFetch, family]);
  const elsewhere = following.filter((other) => other !== chain && among.includes(other));
  if (elsewhere.length === 0) return null;
  return (
    <div data-ui="vaults-elsewhere" className="flex flex-col items-start gap-2">
      {elsewhere.map((other) => (
        <p key={other} className="max-w-(--tf-measure-body) text-body">
          {f.elsewhere(t.chain.names[other])}{' '}
          <Button variant="link" disabled={locked} onClick={() => onShow(other)}>
            {f.showOn(t.chain.names[other])}
          </Button>
        </p>
      ))}
    </div>
  );
}

/** A line of a version as shown: a listed asset, or the mint of a token this app does not list. */
type Line = Target & { mint?: string };

function WeightsTable({
  rows,
  locale,
  caption,
}: {
  rows: Line[];
  locale: string;
  caption: string;
}) {
  const t = useT();
  return (
    <DataTable<Line>
      caption={caption}
      captionHidden
      rows={rows}
      rowKey={(r) => r.asset}
      columns={[
        {
          key: 'asset',
          header: t.plan.columns.asset,
          rowHeader: true,
          cell: (r) =>
            r.mint ? (
              <span data-ui="unlisted-mint" className="flex flex-col">
                <span className="font-mono text-source [overflow-wrap:anywhere]">{r.mint}</span>
                <span className="text-body-sm text-muted-foreground">
                  {t.shared.family.notListed}
                </span>
              </span>
            ) : (
              tokenName(r.asset)
            ),
        },
        {
          key: 'share',
          header: t.plan.columns.share,
          numeric: true,
          cell: (r) => formatBps(r.weightBps, locale),
        },
      ]}
    />
  );
}

/** Every version the server has seen, newest first, per chain: a panel folded shut under the plan. */
function VersionsPanel({ slug, chain }: { slug: string; chain: ChainId | null }) {
  const t = useT();
  const f = t.shared.family;
  const apiFetch = useApiFetch();
  const titleId = useId();
  const [read, setRead] = useState<VersionsResponse | null>(null);
  useEffect(() => {
    let mine = true;
    readVersions(apiFetch, slug, chain).then((answer) => {
      if (mine && answer.kind === 'read') setRead(answer.value);
    });
    return () => {
      mine = false;
    };
  }, [apiFetch, slug, chain]);
  if (!read || read.chains.length === 0) return null;
  const count = read.chains.reduce((n, entry) => n + entry.versions.length, 0);
  return (
    <Panel aria-labelledby={titleId} data-ui="family-versions">
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
          <h2 id={titleId} className="flex items-baseline gap-3 text-body-lg font-semibold">
            {f.versions}
            <span className="text-body-sm font-normal text-muted-foreground">{count}</span>
          </h2>
          <Icon
            name="ChevronDown"
            size={16}
            className="text-muted-foreground transition-transform group-open:rotate-180"
          />
        </summary>
        {read.chains.map((entry) => (
          <KitTable
            key={entry.chain}
            minWidth="min-w-[28rem]"
            caption={`${f.versions} · ${t.chain.names[entry.chain]}`}
            head={
              <>
                <KitTh>{f.columns.version}</KitTh>
                <KitTh>{f.columns.status}</KitTh>
                <KitTh>{f.columns.effective}</KitTh>
              </>
            }
          >
            {entry.versions.map((r) => (
              <tr key={r.version} className={KIT_ROW}>
                <th scope="row" className={`${KIT_CELL} text-left font-normal tabular-nums`}>
                  {r.version}
                </th>
                <td className={KIT_CELL}>{f.status[r.status]}</td>
                <td className={`${KIT_CELL} tabular-nums`}>
                  {utcMinute(new Date(r.effectiveAt * 1000).toISOString())}
                </td>
              </tr>
            ))}
          </KitTable>
        ))}
      </details>
    </Panel>
  );
}

/**
 * Whether the name and description are the text the creator published: the hash of the text shown,
 * worked out here, against the versions the page read from the chain. Where nothing was read the text
 * is said not to be checked: the server's word on it is not repeated. The creator's words are never
 * vouched for when neither version matches.
 */
function TextMark({ matches }: { matches: 'active' | 'pending' | null | 'unchecked' }) {
  const t = useT();
  if (matches === 'active') return null;
  if (matches === 'unchecked')
    return (
      <p
        data-ui="text-unchecked"
        className="max-w-(--tf-measure-body) text-body-sm text-muted-foreground"
      >
        {t.shared.text.notChecked}
      </p>
    );
  return matches === 'pending' ? (
    <p className="max-w-(--tf-measure-body) text-body-sm text-muted-foreground">
      {t.shared.text.pending}
    </p>
  ) : (
    <p
      data-ui="text-unverified"
      className="flex max-w-(--tf-measure-body) items-start gap-1.5 text-body-sm"
    >
      <StatusMark status="watch" className="mt-1.5" />
      <span>{t.shared.text.unverified}</span>
    </p>
  );
}
