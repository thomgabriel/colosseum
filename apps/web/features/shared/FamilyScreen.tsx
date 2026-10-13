'use client';
import {
  type ChainId,
  chainFamily,
  type PortfolioResponse,
  type RecipeVersionView,
  type SharedFamily,
  type SharedRecipe,
  type Target,
  type VaultView,
  type VersionsResponse,
} from '@colosseum/schemas';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { buttonClass } from '../../components/ui/button-class';
import { Card } from '../../components/ui/Card';
import { ChainBadge } from '../../components/ui/ChainBadge';
import { DataTable } from '../../components/ui/DataTable';
import { utcMinute } from '../../components/ui/ExecutionList';
import { Hint } from '../../components/ui/Hint';
import { PAGE_TITLE } from '../../components/ui/heading';
import { StatusMark } from '../../components/ui/StatusMark';
import { ScreenWait } from '../../components/waits/ScreenWait';
import { LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { ChainChoice } from '../account/ChainChoice';
import { AmountCard } from '../amount/AmountCard';
import { DepositCard, type DepositCardProps } from '../amount/DepositCard';
import { dollars } from '../goal/sheet';
import { formatBps, tokenName } from '../order/amounts';
import { Invest } from '../order/Invest';
import type { CallFailure } from '../order/order-api';
import { keepOrder, type OrderRecord, recallOrders } from '../order/order-record';
import { AssetMark, PlanView } from '../order/PlanView';
import { goalLine } from '../order/plain';
import { basketOfPlan, networkFor } from '../order/readiness';
import { unpriced, holdingsOf as vaultHoldingsOf } from '../portfolio/portfolio';
import { goalOfVault } from '../portfolio/vault-goal';
import { useApiFetch, useWalletPort } from '../wallet/WalletProvider';
import { type ChainCheck, familyIdFor, isVaultOf, useChainRecipe } from './chain-recipe';
import { HoldingsBar } from './HoldingsBar';
import { isPlatformCreator } from './platform';
import { holdingsOf, kindShares } from './product-figures';
import { sharedRefusal } from './refusal';
import { Offer } from './ShelfScreen';
import { SourceMark } from './SourceMark';
import { placeShared, readFamily, readPortfolio, readVersions } from './shared-api';
import type { FollowTerms, SharedTerms } from './terms';
import { type SharedPerson, shortAddress, useSharedPerson } from './use-person';
import { FamilyWait, MyVaultsWait } from './waits';

// A shared portfolio's page (DESIGN-VAULT section 11): its name and creator, each recipe a wallet of
// the person's signs on (one at a time: a portfolio with a recipe on both chains asks which, gate
// CHAIN-AT-THE-PLAN; a buy is on that recipe's chain, ONE-CHAIN) with the version in effect and the
// one that waits, whether
// auto-follow is offered (gate GOLD-ONE-TAP), the person's vaults with a follow and the prompt when the
// portfolio changed, and every version. The version and weights are read from the chain by this app
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
  const lang = useLang();
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
          <Link href="/shelf" className={buttonClass({ variant: 'secondary' })}>
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
        <Link href="/shelf" className={`${buttonClass({ variant: 'link' })} self-start`}>
          {f.backToShelf}
        </Link>
        <h1 id={titleId} className={`${PAGE_TITLE} [overflow-wrap:anywhere]`}>
          {family.name}
        </h1>
        <p className="max-w-(--tf-measure-body) text-body text-muted-foreground">{f.nextStep}</p>
        {family.copy && (
          <p className="max-w-(--tf-measure-body) whitespace-pre-line text-body-lg [overflow-wrap:anywhere]">
            {family.copy}
          </p>
        )}
      </header>

      {person.kind === 'ready' && usable.length === 0 && family.recipes.length > 0 && (
        // On a chain no wallet of theirs signs on: shown, and said plainly why nothing is offered.
        <p data-ui="family-no-wallet" className="max-w-(--tf-measure-body) text-body">
          {f.noWalletFor(
            new Intl.ListFormat(LOCALE[lang], { type: 'conjunction' }).format(
              family.recipes.map((r) => nameOf(r.chain)),
            ),
          )}
        </p>
      )}
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
      {recipes.map((recipe) => (
        <RecipeSection
          key={recipe.chain}
          family={family}
          recipe={recipe}
          changed={changed}
          onRunning={(now) => {
            // The run is on the recipe on the page. Where the page's own choice was never touched
            // that recipe came from where the person's new plans start, which /goal can change in
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
      <VersionsPanel slug={family.slug} chain={chosen?.chain ?? null} />
      <Link href="/shelf" className={`${buttonClass({ variant: 'link' })} self-start`}>
        {f.backToShelf}
      </Link>
    </div>
  );
}

/** One chain's recipe, read from that chain where this app can, with what the person can do with it. */
function RecipeSection({
  family,
  recipe,
  changed,
  onRunning,
  onVersionChanged,
  onReread,
}: {
  family: SharedFamily;
  recipe: SharedRecipe;
  /** A deposit was pressed (true) or ended, stopped or was put off (false): the page locks its chain. */
  onRunning: (running: boolean) => void;
  /** A buy was refused for a newer version, and the page read the portfolio again. */
  changed: boolean;
  onVersionChanged: () => void;
  onReread: () => void;
}) {
  const t = useT();
  const lang = useLang();
  // The person on this recipe's own chain, with their wallet there: a buy and a follow are on it.
  const person = useSharedPerson(recipe.chain);
  // A deposit is being signed: the chain and the card's amount are locked until it ends.
  const [pressed, setPressedHere] = useState(false);
  // What is typed and ticked on the amount card, kept here: the card is drawn again whenever the
  // recipe is read again, and the person's amount and tick stay with them.
  const [amountText, setAmountText] = useState('');
  const [ticked, setTicked] = useState(false);
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
  const reasonId = useId();
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
  const holdings = holdingsOf(recipe, active.components, t);
  // The person's vaults on this chain, and the follow of one of them: for the card's "Into" and the
  // list under it. Read only where a deposit is offered.
  const mine = useFamilyVaults(
    person.kind === 'ready' && own && followed && !blocked ? person : null,
    family,
    recipe,
    followed,
  );
  const unmeasured = holdings.filter((h) => !h.exit);
  const list = (items: string[]) =>
    new Intl.ListFormat(locale, { type: 'conjunction' }).format(items);
  return (
    <div className="flex flex-col gap-6">
      <PlanView
        title={f.recipe(chainName)}
        sub={p.sub(
          f.versionN(active.version),
          f.since(utcMinute(new Date(active.effectiveAt * 1000).toISOString())),
        )}
        answer={p.answer(
          // a sentence: only its first kind keeps its capital
          list(
            kindShares(holdings, locale, t.plan.kinds).map((kind, i) =>
              i === 0 ? kind : kind.charAt(0).toLowerCase() + kind.slice(1),
            ),
          ),
          chainName,
        )}
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
          why: h.why,
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
        aside={
          <>
            {/* Who published it, by address: in view (gate PRODUCTS-PLAN-PANE). */}
            <p className="flex flex-wrap items-baseline gap-x-2 text-body-sm text-muted-foreground">
              <span>{p.publisher}</span>
              <span data-ui="creator" className="break-all font-mono text-source text-foreground">
                {read?.creator ?? recipe.creator}
              </span>
              {isPlatformCreator(
                networkFor(recipe.chain, mock),
                recipe.chain,
                read?.creator ?? recipe.creator,
              ) && (
                <span className="font-medium text-foreground">{t.shared.shelf.card.platform}</span>
              )}
            </p>
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
          <div className="flex flex-col gap-3">
            <Offer recipe={recipe} />
            {/* The routine check of its words, behind a fold unless a check found something wrong. */}
            {(check.state !== 'read' || check.textMatches === 'pending') && (
              <details data-ui="family-checks" open={alarm || undefined}>
                <summary className="w-fit cursor-pointer text-body-sm font-medium text-honey-text underline decoration-1 underline-offset-4 hover:decoration-2">
                  {t.plan.details}
                </summary>
                <div className="mt-3 flex flex-col gap-2">
                  <TextMark matches={check.state === 'read' ? check.textMatches : 'unchecked'} />
                </div>
              </details>
            )}
          </div>
        }
        invest={
          person.kind === 'ready' && own ? (
            <div data-ui="product-invest" className="flex flex-col items-start gap-4">
              {changed && (
                // Said before any new order is offered: what is shown above is the new version.
                <p
                  data-ui="product-version-changed"
                  role="status"
                  className="flex max-w-(--tf-measure-body) items-start gap-1.5 text-body font-medium"
                >
                  <StatusMark status="watch" size={12} className="mt-1.5" />
                  {/* the one sentence for it, from the one place (refusal.ts) */}
                  <span>
                    {sharedRefusal({ kind: 'code', code: 'VERSION_CHANGED' }, t)?.sentence}
                  </span>
                </p>
              )}
              {blocked || !followed || !followed.targets ? (
                <>
                  <Button variant="primary" disabled aria-describedby={reasonId}>
                    {f.buy}
                  </Button>
                  <p id={reasonId} className="max-w-(--tf-measure-body) text-body-sm">
                    {blocked ?? t.shared.check.reading}
                  </p>
                </>
              ) : (
                // The amount card (gate AMOUNT-CARD): its press hands the amount to the one invest
                // step (gate INVEST-ONE-PRESS), held to the recipe this pane shows. A new version
                // draws the card again, empty, with the new displayed terms.
                <div className="w-full">
                  <FamilyDeposit
                    key={`${recipe.active.version}:${active.version}`}
                    entry={{ text: amountText, onText: setAmountText, ticked, onTick: setTicked }}
                    family={family}
                    recipe={recipe}
                    followed={followed}
                    targets={followed.targets}
                    person={person}
                    mock={mock}
                    vaults={mine}
                    running={pressed}
                    onRunning={setPressed}
                    onVersionChanged={() => {
                      // No order is made for the new version until the person has seen it and
                      // typed an amount again.
                      setPressed(false);
                      setAmountText('');
                      onVersionChanged();
                    }}
                  />
                </div>
              )}
            </div>
          ) : person.kind === 'signed-out' ? (
            <div data-ui="product-invest" className="flex flex-col items-start gap-2">
              <Link
                href={`/sign-in?next=/indexes/${encodeURIComponent(family.slug)}`}
                className={buttonClass({ variant: 'secondary' })}
              >
                {f.signIn}
              </Link>
            </div>
          ) : undefined
        }
      />

      {person.kind === 'ready' && own && followed && !blocked && (
        <VaultsPanel recipe={recipe} followed={followed} mine={mine} onReread={onReread} />
      )}
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

type OwnVault = PortfolioResponse['chains'][number]['vaults'][number];

/** The card's "Into" for a buy of the portfolio itself: the person's vault for it, or a new one. */
const INTO_FAMILY = 'family';
/** The card's "Into" for a vault of theirs that follows another portfolio or none: a switch. */
const INTO_SWITCH = 'switch:';

/** The person's vaults on this chain, and a follow of one of them, for the amount card and the list. */
type FamilyVaults = {
  vaults: OwnVault[] | null | 'failed';
  /** Those that follow this portfolio. */
  related: OwnVault[];
  /** Those that do not: each can be switched to follow it. */
  eligible: OwnVault[];
  nameOf: (vault: OwnVault) => string;
  /** A follow order for this vault, kept with its terms, then the order screen. */
  follow: (
    vault: VaultView,
    autoFollow: boolean,
    accept: boolean,
    from?: 'card' | 'list',
  ) => Promise<void>;
  /** The auto-follow switch an accept asks for. */
  keep: (vault: VaultView) => boolean;
  busy: string | null;
  failure: string | null;
  /** Where the follow that failed was asked for: the amount card's switch, or the list. */
  failedFrom: 'card' | 'list';
  /** Our server said the portfolio is another version now: reading it again is offered. */
  changed: boolean;
  clear: () => void;
  /** The amount card's "Into": dropped with everything else for another person, chain or version. */
  into: string;
  setInto: (into: string) => void;
};

function useFamilyVaults(
  person: Extract<SharedPerson, { kind: 'ready' }> | null,
  family: SharedFamily,
  recipe: SharedRecipe,
  followed: Followed | null,
): FamilyVaults {
  const t = useT();
  const lang = useLang();
  const v = t.shared.vaults;
  const router = useRouter();
  const apiFetch = useApiFetch();
  const [vaults, setVaults] = useState<OwnVault[] | null | 'failed'>(null);
  const submitting = useRef(false);
  const generation = useRef(0);
  // The orders this browser placed: a vault bought from a goal is named by that goal.
  const [records, setRecords] = useState<OrderRecord[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const [failedFrom, setFailedFrom] = useState<'card' | 'list'>('list');
  const [into, setInto] = useState<string>(INTO_FAMILY);
  // Everything is read again for another person, wallet, chain, portfolio or version.
  const key = person
    ? `${person.userId}:${person.owner}:${person.chain}:${person.mock}:${family.slug}:${recipe.onchainId}:${followed?.follow.version}:${followed?.source}`
    : null;
  const userId = person?.userId ?? null;
  useEffect(() => setRecords(recallOrders(userId)), [userId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for whose vaults these are
  useEffect(() => {
    setVaults(null);
    submitting.current = false;
    setBusy(null);
    setFailure(null);
    setChanged(false);
    setInto(INTO_FAMILY);
    if (!person) return;
    let mine = true;
    readPortfolio(apiFetch).then((read) => {
      if (!mine) return;
      if (read.kind !== 'read') return setVaults('failed');
      const entry = read.value.chains.find((c) => c.chain === person.chain);
      setVaults(entry?.vaults ?? []);
    });
    return () => {
      mine = false;
      generation.current += 1;
    };
  }, [apiFetch, key]);

  async function follow(
    vault: VaultView,
    autoFollow: boolean,
    accept: boolean,
    from: 'card' | 'list' = 'list',
  ) {
    if (!person || !followed || !person.owner || !person.userId || submitting.current) return;
    submitting.current = true;
    setFailedFrom(from);
    setBusy(`${vault.address}:${autoFollow}:${accept}`);
    setFailure(null);
    // The plan number the step names has to be the vault's own, as the guard derives it.
    if (
      isVaultOf(person.chain, person.mock, vault.owner, vault.basketId, vault.address) === false
    ) {
      submitting.current = false;
      setBusy(null);
      setFailure(t.order.mismatch.shape);
      return;
    }
    const terms: SharedTerms = {
      kind: 'follow',
      slug: family.slug,
      familyId: familyIdFor(family.slug),
      vault: vault.address,
      basketId: vault.basketId,
      follow: accept ? followed.follow : null,
      autoFollow,
      source: followed.source,
    };
    const started = generation.current;
    const placed = await placeShared(
      apiFetch,
      {
        type: 'follow',
        vault: vault.address,
        family: family.slug,
        autoFollow,
        version: followed.follow.version,
      },
      { chain: person.chain, owner: vault.owner, type: 'follow' },
    );
    // A late reply belongs to the discarded read, account, chain or version, not this page.
    if (started !== generation.current) return;
    if (placed.kind !== 'placed') {
      submitting.current = false;
      setBusy(null);
      // A refusal with a code is said in this app's own words for a portfolio (refusal.ts): a follow
      // of a version that is no longer the one in effect says so, and offers to read it again.
      const refused =
        placed.kind === 'said' || placed.kind === 'code' ? sharedRefusal(placed, t) : null;
      setChanged(refused?.changed === true);
      setFailure(
        refused
          ? refused.sentence
          : placed.kind === 'said'
            ? t.shared.publish.failure.said(placed.error)
            : placed.kind === 'busy'
              ? t.shell.slowDown
              : t.shared.publish.failure.unreachable,
      );
      return;
    }
    const kept = keepOrder({
      orderId: placed.order.id,
      userId: person.userId,
      proposalId: '',
      chain: person.chain,
      amountUsd: 0,
      lines: [],
      terms,
      approved: null,
    });
    if (!kept) {
      submitting.current = false;
      setBusy(null);
      setFailure(t.shared.publish.failure.noStore);
      return;
    }
    router.push(`/orders/${encodeURIComponent(placed.order.id)}`);
  }

  const offered = recipe.autoFollow.offered;
  const readVaults = Array.isArray(vaults) ? vaults : [];
  const following = followed?.follow.recipeOnchainId;
  return {
    vaults,
    related: readVaults.filter((vault) => vault.recipeOnchainId === following),
    eligible: readVaults.filter((vault) => vault.recipeOnchainId !== following),
    nameOf: (vault) => {
      const goal = goalOfVault(vault, records)?.goal.sheet;
      return (
        vault.name ??
        (goal
          ? goalLine(goal, t, dollars(goal.amountUsd, lang), (usd) => dollars(usd, lang))
          : v.address(shortAddress(vault.address)))
      );
    },
    follow,
    /**
     * The switch an accept asks for: the vault's own, but never on into a portfolio that does not
     * offer it (gate GOLD-ONE-TAP). A vault with auto-follow on then switches it off before it takes
     * the version, as the API plans it.
     */
    keep: (vault) => vault.autoFollow && offered,
    busy,
    failure,
    failedFrom,
    changed,
    clear: () => {
      setFailure(null);
      setChanged(false);
    },
    into,
    setInto,
  };
}

/** What a failed follow says, with the way to read the portfolio again where it changed. */
function FollowFailure({
  mine,
  from,
  onReread,
}: {
  mine: FamilyVaults;
  from: 'card' | 'list';
  onReread: () => void;
}) {
  const t = useT();
  if (!mine.failure || mine.failedFrom !== from) return null;
  return (
    <>
      <p
        role="alert"
        className="flex max-w-(--tf-measure-body) items-start gap-1.5 text-body-sm text-destructive"
      >
        <StatusMark status="off-track" size={12} className="mt-1.5" />
        <span>{mine.failure}</span>
      </p>
      {mine.changed && (
        <Button
          variant="secondary"
          className="self-start"
          onClick={() => {
            mine.clear();
            onReread();
          }}
        >
          {t.shared.refusal.reread}
        </Button>
      )}
    </>
  );
}

/**
 * The deposit into this portfolio, on the amount card (gate AMOUNT-CARD): "Into" chooses the person's
 * vault for it (a new one where they have none) or a vault of theirs to switch to it. A deposit hands
 * its amount to the one invest step (gate INVEST-ONE-PRESS); a switch moves no money, and its press
 * makes the follow order, reviewed and signed on the order's own screen.
 */
function FamilyDeposit({
  family,
  recipe,
  followed,
  targets,
  person,
  mock,
  vaults: mine,
  entry,
  running,
  onRunning,
  onVersionChanged,
}: {
  family: SharedFamily;
  recipe: SharedRecipe;
  followed: Followed;
  targets: Target[];
  person: Extract<SharedPerson, { kind: 'ready' }>;
  mock: boolean;
  vaults: FamilyVaults;
  entry: NonNullable<DepositCardProps['entry']>;
  running: boolean;
  onRunning: (running: boolean) => void;
  onVersionChanged: () => void;
}) {
  const t = useT();
  const a = t.amount;
  const chainName = t.chain.names[recipe.chain];
  // The vault a buy of this portfolio adds to, where the person has one: its number is the portfolio's.
  const ownBasket = basketOfPlan(familyIdFor(family.slug));
  const own = Array.isArray(mine.vaults)
    ? mine.vaults.find((vault) => vault.basketId === ownBasket)
    : undefined;
  const switchable = mine.eligible.filter((vault) => vault.basketId !== ownBasket);
  const { into } = mine;
  const switching = into.startsWith(INTO_SWITCH)
    ? switchable.find((vault) => vault.address === into.slice(INTO_SWITCH.length))
    : undefined;
  const choice = {
    label: a.into.label,
    value: switching ? into : INTO_FAMILY,
    options: [
      { value: INTO_FAMILY, label: own ? a.into.follows(mine.nameOf(own)) : a.into.newVault },
      ...switchable.map((vault) => ({
        value: `${INTO_SWITCH}${vault.address}`,
        label: a.into.other(mine.nameOf(vault)),
      })),
    ],
    hint: switching ? a.into.switchHint : own ? a.into.addsHint : a.into.newHint,
    // Held while a deposit is signed or a follow is being made: the choice is the one under way.
    ...(running || mine.busy !== null
      ? {}
      : {
          onChange: (next: string) => {
            mine.clear();
            mine.setInto(next);
          },
        }),
  };

  if (switching)
    return (
      <AmountCard
        mode="deposit"
        headingLevel={3}
        chain={recipe.chain}
        chainName={chainName}
        provenance={mock ? 'mock' : recipe.provenance}
        into={choice}
        field={null}
        preview={{
          title: a.preview.deposit,
          body: (
            <div data-ui="review-follow" className="flex flex-col gap-2">
              <p className="text-body-sm [overflow-wrap:anywhere]">
                {a.preview.switch(mine.nameOf(switching), family.name, followed.follow.version)}
              </p>
              <p className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-source">
                {targets.map((target) => (
                  <span key={target.asset} className="inline-flex items-center gap-1.5">
                    <AssetMark asset={target.asset} className="size-5" />
                    {tokenName(target.asset)}
                  </span>
                ))}
              </p>
            </div>
          ),
        }}
        notice={<FollowFailure mine={mine} from="card" onReread={onVersionChanged} />}
        action={{
          label: a.review,
          reasons: [],
          busy: mine.busy !== null,
          busyLabel: a.busy,
          onPress: () => void mine.follow(switching, mine.keep(switching), true, 'card'),
        }}
      />
    );

  return (
    <DepositCard
      headingLevel={3}
      entry={entry}
      chain={recipe.chain}
      chainName={chainName}
      mock={mock}
      provenance={recipe.provenance}
      owner={person.owner}
      userId={person.userId}
      buyOf={{ family: family.slug, chain: recipe.chain }}
      holdings={targets}
      keeper
      into={choice}
      blocked={[]}
      running={running}
      flow={(amount, change) => (
        <Invest
          of={{
            family: family.slug,
            snapshot: {
              family,
              recipe,
              terms: {
                kind: 'family',
                slug: family.slug,
                familyId: familyIdFor(family.slug),
                follow: followed.follow,
                targets,
                source: followed.source,
              },
            },
          }}
          amount={amount}
          onProgress={() => onRunning(true)}
          onDone={() => onRunning(false)}
          onStopped={() => onRunning(false)}
          onVersionChanged={onVersionChanged}
          onAmount={change}
        />
      )}
    />
  );
}

/**
 * The person's vaults on this chain that follow this portfolio, with the prompt when a newer version
 * has taken effect or waits, and the auto-follow switch where it is offered. A vault that does not
 * follow it is chosen in the amount card's "Into", where switching it is reviewed and signed.
 */
function VaultsPanel({
  recipe,
  followed,
  mine,
  onReread,
}: {
  recipe: SharedRecipe;
  followed: Followed;
  mine: FamilyVaults;
  /** Reads the portfolio again from our server, and with it the chain. */
  onReread: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const v = t.shared.vaults;
  const titleId = useId();
  const { vaults, related, busy, follow, keep, nameOf } = mine;
  const offered = recipe.autoFollow.offered;
  const cards = (items: OwnVault[]) => (
    <ul className="grid grid-cols-1 gap-4 min-[640px]:grid-cols-2">
      {items.map((vault) => {
        const behind = vault.acceptedVersion < followed.follow.version;
        const heading = `${titleId}-${vault.address}`;
        const holdings = vaultHoldingsOf(vault).filter((holding) => !/^0+$/.test(holding.raw));
        const shares = holdings.filter(
          (holding) => holding.weightBps > 0 && holding.valueUsd !== null,
        );
        const unpricedCount = unpriced(vault);
        return (
          <li key={vault.address} data-ui="my-vault" className="min-w-0">
            <Card
              as="article"
              interactive
              aria-labelledby={heading}
              mock={vault.provenance !== 'live'}
              mockLabels={{
                announce:
                  vault.provenance === 'sandbox' ? t.shell.testNetworkLine : t.shell.mockAnnounce,
              }}
              className="h-full"
            >
              <div className="flex min-w-0 flex-col items-start gap-3 p-6">
                <div className="flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
                  <ChainBadge chain={vault.chain} />
                  {vault.recipeOnchainId !== null && (
                    <span>{t.shared.vault.version(vault.acceptedVersion)}</span>
                  )}
                </div>
                <h3 id={heading} className="w-full break-words font-display font-semibold text-h4">
                  {nameOf(vault)}
                </h3>
                <div data-ui="vault-holdings" className="flex w-full min-w-0 flex-col gap-2">
                  <p className="text-caption text-muted-foreground">{t.portfolio.vault.holdings}</p>
                  {shares.length > 0 && (
                    <HoldingsBar
                      shares={shares.map((holding) => ({
                        key: holding.asset,
                        shareBps: holding.weightBps,
                      }))}
                    />
                  )}
                  <p className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-source [overflow-wrap:anywhere]">
                    {holdings.length > 0
                      ? holdings.map((holding) => (
                          <span
                            key={holding.asset}
                            className="inline-flex min-w-0 items-center gap-1.5"
                          >
                            <AssetMark asset={holding.asset} className="size-5" />
                            <span>
                              {`${tokenName(holding.asset)} ${holding.valueUsd === null ? '—' : formatBps(holding.weightBps, LOCALE[lang])}`}
                            </span>
                          </span>
                        ))
                      : v.noHoldings}
                  </p>
                  {unpricedCount > 0 && (
                    <p className="text-caption text-muted-foreground">
                      {t.portfolio.vault.unpriced(unpricedCount)}
                    </p>
                  )}
                </div>
                <p className="text-body-sm text-muted-foreground">{v.following}</p>
                <p className="text-body-sm text-muted-foreground">{v.autoIs(vault.autoFollow)}</p>
                {(behind || vault.pending) && (
                  <FollowPrompt
                    vault={vault}
                    version={followed.follow.version}
                    behind={behind}
                    busy={busy !== null}
                    onAccept={() => follow(vault, keep(vault), true)}
                  />
                )}
                {(offered || vault.autoFollow) && !behind && (
                  <Button
                    variant="secondary"
                    disabled={busy !== null}
                    busy={busy === `${vault.address}:${!vault.autoFollow}:false`}
                    onClick={() => follow(vault, !vault.autoFollow, false)}
                  >
                    {vault.autoFollow ? v.autoOff : v.autoOn}
                  </Button>
                )}
                <Hint
                  tip={<span className="font-mono text-source break-all">{vault.address}</span>}
                >
                  <Link
                    href={`/vaults/${vault.chain}/${encodeURIComponent(vault.address)}`}
                    className={buttonClass({ variant: 'link' })}
                  >
                    {v.open}
                  </Link>
                </Hint>
              </div>
            </Card>
          </li>
        );
      })}
    </ul>
  );
  return (
    <section aria-labelledby={titleId} className="flex min-w-0 flex-col gap-4">
      <h2 id={titleId} className="text-h4 font-semibold">
        {v.title}
      </h2>
      {vaults === null ? (
        <ScreenWait label={t.shared.vault.loading} skeleton={<MyVaultsWait />} />
      ) : vaults === 'failed' ? (
        <p className="text-body-sm">{v.failure}</p>
      ) : (
        <>
          {related.length > 0 ? (
            cards(related)
          ) : (
            <p className="text-body-sm text-muted-foreground">
              {vaults.length === 0 ? v.none : v.noFollowers}
            </p>
          )}
          {related.length > 0 && !offered && (
            <p className="max-w-(--tf-measure-body) text-body-sm text-muted-foreground">
              {v.oneTap}
            </p>
          )}
        </>
      )}
      <FollowFailure mine={mine} from="list" onReread={onReread} />
    </section>
  );
}

/**
 * The prompt when a followed portfolio changed (gate GOLD-ONE-TAP's one tap): the version in effect
 * that the vault has not taken, with an accept, or the version that waits, with its time. Read from
 * the person's own vault (`VaultView.pending` of GET /v1/portfolio) and the version in effect.
 */
export function FollowPrompt({
  vault,
  version,
  behind,
  busy,
  onAccept,
}: {
  vault: VaultView;
  /** The version in effect, as this app read it. */
  version: number;
  /** The vault holds an earlier version than the one in effect. */
  behind: boolean;
  busy: boolean;
  onAccept: () => void;
}) {
  const t = useT();
  const p = t.shared.prompt;
  const waiting = !behind && vault.pending;
  const added = vault.pending?.newAssets ?? [];
  return (
    <div
      data-ui="follow-prompt"
      className="flex w-full flex-col items-start gap-2 border-l-2 border-l-primary pl-3"
    >
      <p className="text-body font-medium">{p.title}</p>
      <p className="max-w-(--tf-measure-body) text-body-sm">
        {waiting && vault.pending
          ? p.waits(
              vault.pending.version,
              utcMinute(new Date(vault.pending.effectiveAt * 1000).toISOString()),
            )
          : p.inEffect(version)}
      </p>
      {added.length > 0 && (
        <p className="max-w-(--tf-measure-body) text-body-sm">
          {p.newAssets(added.map((a) => tokenName(a)).join(', '))}
        </p>
      )}
      {behind && (
        <Button variant="primary" busy={busy} onClick={onAccept}>
          {p.accept(version)}
        </Button>
      )}
    </div>
  );
}

/** Every version the server has seen, newest first, per chain. */
function VersionsPanel({ slug, chain }: { slug: string; chain: ChainId | null }) {
  const t = useT();
  const f = t.shared.family;
  const apiFetch = useApiFetch();
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
  return (
    <section aria-label={f.versions} className="flex flex-col gap-4">
      <h2 className="text-h4 font-semibold">{f.versions}</h2>
      {read.chains.map((entry) => (
        <DataTable<RecipeVersionView>
          key={entry.chain}
          caption={`${f.versions} · ${t.chain.names[entry.chain]}`}
          captionHidden
          rows={entry.versions}
          rowKey={(r) => String(r.version)}
          columns={[
            {
              key: 'version',
              header: f.columns.version,
              rowHeader: true,
              cell: (r) => String(r.version),
            },
            { key: 'status', header: f.columns.status, cell: (r) => f.status[r.status] },
            {
              key: 'effective',
              header: f.columns.effective,
              cell: (r) => utcMinute(new Date(r.effectiveAt * 1000).toISOString()),
            },
          ]}
        />
      ))}
    </section>
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
