'use client';
import type {
  PortfolioResponse,
  SharedFamily,
  SharedRecipe,
  Target,
  VaultView,
} from '@colosseum/schemas';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { buttonClass } from '../../components/ui/button-class';
import { cn } from '../../components/ui/cn';
import { utcMinute } from '../../components/ui/ExecutionList';
import { OptionCards } from '../../components/ui/OptionCards';
import { Panel, PanelBody, PanelHead } from '../../components/ui/Panel';
import { StatusMark } from '../../components/ui/StatusMark';
import { ScreenWait } from '../../components/waits/ScreenWait';
import { useLang, useT } from '../../i18n/I18nProvider';
import { AmountCard } from '../amount/AmountCard';
import { DepositCard, type DepositCardProps } from '../amount/DepositCard';
import { dollars } from '../goal/sheet';
import { tokenName } from '../order/amounts';
import { Invest } from '../order/Invest';
import { keepOrder, type OrderRecord, recallOrders } from '../order/order-record';
import { AssetMark } from '../order/PlanView';
import { goalLine } from '../order/plain';
import { basketOfPlan } from '../order/readiness';
import { goalOfVault } from '../portfolio/vault-goal';
import { vaultTitle } from '../portfolio/vault-name';
import { useApiFetch } from '../wallet/WalletProvider';
import { familyIdFor, isVaultOf } from './chain-recipe';
import type { Followed } from './FamilyScreen';
import { FollowQuote } from './FollowQuote';
import { sharedRefusal } from './refusal';
import { Offer } from './ShelfScreen';
import { placeShared, readPortfolio } from './shared-api';
import type { SharedTerms } from './terms';
import { type SharedPerson, shortAddress } from './use-person';
import { ActionsWait } from './waits';

// A shared portfolio's actions, in the right pane of its page (Thom, Oct 14): two ways to use it, and
// nothing else to choose. Start a new vault that copies it, opened with a first deposit that is signed
// here (the amount card, then the one invest step, gate INVEST-ONE-PRESS). Or follow it with a vault of
// the person's on its chain: the vault is chosen, what following would trade is quoted, and the follow
// order is reviewed and signed on the order's own screen. A vault that follows it already is a state
// with the way to it, never a place to deposit into. Signed out, both are named and sign-in comes first.

type OwnVault = PortfolioResponse['chains'][number]['vaults'][number];
type Ready = Extract<SharedPerson, { kind: 'ready' }>;
/** The way the person chose: a new vault, or one of theirs to follow it with. */
type Way = 'new' | 'follow';

/** The person's vaults on this chain, and a follow of one of them. */
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
  /** Where the follow that failed was asked for: the follow card, or a vault that follows it. */
  failedFrom: 'card' | 'list';
  /** Our server said the portfolio is another version now: reading it again is offered. */
  changed: boolean;
  clear: () => void;
  /** The way chosen, and the vault chosen to follow it with: dropped for another person, chain or version. */
  way: Way | null;
  setWay: (way: Way) => void;
  chosen: string | null;
  setChosen: (address: string) => void;
  /** Reads the person's vaults again, keeping what was chosen: after a deposit opened one. */
  reread: () => void;
};

function useFamilyVaults(
  person: Ready | null,
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
  const [way, setWay] = useState<Way | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  // Everything is read again for another person, wallet, chain, portfolio or version.
  const key = person
    ? `${person.userId}:${person.owner}:${person.chain}:${person.mock}:${family.slug}:${recipe.onchainId}:${followed?.follow.version}:${followed?.source}`
    : null;
  const userId = person?.userId ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `round` reads them again after a deposit
  useEffect(() => setRecords(recallOrders(userId)), [userId, round]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for whose vaults these are
  useEffect(() => {
    setVaults(null);
    submitting.current = false;
    setBusy(null);
    setFailure(null);
    setChanged(false);
    setWay(null);
    setChosen(null);
    return () => {
      generation.current += 1;
    };
  }, [key]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` and `round` say when to read
  useEffect(() => {
    if (!person) return;
    let mine = true;
    readPortfolio(apiFetch).then((read) => {
      if (!mine) return;
      if (read.kind !== 'read') return setVaults((was) => (Array.isArray(was) ? was : 'failed'));
      const entry = read.value.chains.find((c) => c.chain === person.chain);
      setVaults(entry?.vaults ?? []);
    });
    return () => {
      mine = false;
    };
  }, [apiFetch, key, round]);

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
  const chainName = t.chain.names[recipe.chain];
  return {
    vaults,
    related: readVaults.filter((vault) => vault.recipeOnchainId === following),
    eligible: readVaults.filter((vault) => vault.recipeOnchainId !== following),
    // One name rule (vault-name.ts): its own name, else its number; with neither, the goal it was
    // bought for, else its address, so two of them in one list are never called the same.
    nameOf: (vault) => {
      const goal = goalOfVault(vault, records)?.goal.sheet;
      const unnamed = goal
        ? goalLine(goal, t, dollars(goal.amountUsd, lang), (usd) => dollars(usd, lang))
        : v.address(shortAddress(vault.address));
      return vaultTitle(vault, { ...t.portfolio.actions, unnamed: () => unnamed }, chainName);
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
    way,
    setWay,
    chosen,
    setChosen,
    reread: () => setRound((n) => n + 1),
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

export type FamilyActionsProps = {
  family: SharedFamily;
  recipe: SharedRecipe;
  /** The person on the recipe's own chain. */
  person: SharedPerson;
  /** Their chain is the recipe's: a deposit or a follow can be made from here. */
  own: boolean;
  mock: boolean;
  followed: Followed | null;
  /** Why nothing can be done with this portfolio from here, in a sentence. */
  blocked: string | null;
  /** A deposit was refused for a newer version, and the page read the portfolio again. */
  changed: boolean;
  /** The weights a deposit and a follow are held to: the chain's where read. */
  targets: Target[] | null;
  /** The version shown: a new one draws the deposit again, empty. */
  shown: string;
  /** The amount and the trust box, kept by the page: the card is drawn again on every read. */
  entry: NonNullable<DepositCardProps['entry']>;
  running: boolean;
  onRunning: (running: boolean) => void;
  onVersionChanged: () => void;
  onReread: () => void;
};

/** The right pane: the two ways, the vaults that follow it, and the card of the way chosen. */
export function FamilyActions(props: FamilyActionsProps) {
  const { family, recipe, person, own, followed, blocked, changed } = props;
  const t = useT();
  const x = t.shared.actions;
  const titleId = useId();
  const ready = person.kind === 'ready' && own ? person : null;
  const mine = useFamilyVaults(
    ready && followed && !blocked ? ready : null,
    family,
    recipe,
    followed,
  );
  const chainName = t.chain.names[recipe.chain];

  const panel = (body: ReactNode) => (
    <Panel as="section" aria-labelledby={titleId} data-ui="family-actions">
      <PanelHead id={titleId} title={x.title} />
      <PanelBody>
        {changed && (
          // Said before any new order is offered: what is shown beside it is the new version.
          <p
            data-ui="product-version-changed"
            role="status"
            className="flex items-start gap-1.5 text-body-sm font-medium"
          >
            <StatusMark status="watch" size={12} className="mt-1" />
            {/* the one sentence for it, from the one place (refusal.ts) */}
            <span>{sharedRefusal({ kind: 'code', code: 'VERSION_CHANGED' }, t)?.sentence}</span>
          </p>
        )}
        {body}
        <div className="border-t border-border pt-4 text-caption text-muted-foreground">
          <Offer recipe={recipe} />
        </div>
      </PanelBody>
    </Panel>
  );

  // Signed in with no wallet on this chain, or not yet known: both ways named, why neither is offered,
  // and whether auto-follow is (PRODUCTS-PLAN-PANE). Not an invest step: nothing here can be taken.
  if (!ready && person.kind !== 'signed-out')
    return panel(
      <>
        <Ways chainName={chainName} />
        {person.kind === 'no-wallet' && (
          <p data-ui="family-no-wallet" className="text-body-sm">
            {t.shared.family.noWalletFor(chainName)}
          </p>
        )}
      </>,
    );
  // Signed out: both ways named, and sign-in first.
  const content = !ready ? (
    panel(
      <>
        <Ways chainName={chainName} />
        <p className="text-body-sm text-muted-foreground">{x.signedOut}</p>
        <Link
          href={`/sign-in?next=/indexes/${encodeURIComponent(family.slug)}`}
          className={cn(buttonClass({ variant: 'primary' }), 'w-full')}
        >
          {x.signIn}
        </Link>
      </>,
    )
  ) : blocked || !followed || !props.targets ? (
    panel(
      <>
        <Ways chainName={chainName} />
        <p data-ui="family-blocked" className="text-body-sm">
          {blocked ?? t.shared.check.reading}
        </p>
      </>,
    )
  ) : mine.vaults === null ? (
    panel(<ScreenWait label={t.shared.vault.loading} skeleton={<ActionsWait />} />)
  ) : (
    <Chosen
      {...props}
      person={ready}
      followed={followed}
      targets={props.targets}
      mine={mine}
      panel={panel}
    />
  );
  // The pane, and the card of the way chosen under it: what the page's tests and its e2e find.
  return (
    <div data-ui="product-invest" className="flex min-w-0 flex-col gap-4">
      {content}
    </div>
  );
}

/** The two ways, named, where neither can be taken here yet. */
function Ways({ chainName }: { chainName: string }) {
  const x = useT().shared.actions;
  return (
    <OptionCards
      ui="family-ways"
      legend={x.legend}
      options={[
        { value: 'new', title: x.newVault.title, line: x.newVault.line },
        { value: 'follow', title: x.follow.title, line: x.follow.line(chainName) },
      ]}
    />
  );
}

/** Signed in on the recipe's chain, with the vaults read: the vaults that follow it, then the ways. */
function Chosen({
  family,
  recipe,
  person,
  mock,
  followed,
  targets,
  shown,
  entry,
  running,
  onRunning,
  onVersionChanged,
  onReread,
  mine,
  panel,
}: FamilyActionsProps & {
  person: Ready;
  followed: Followed;
  targets: Target[];
  mine: FamilyVaults;
  panel: (body: ReactNode) => ReactNode;
}) {
  const t = useT();
  const x = t.shared.actions;
  const v = t.shared.vaults;
  const chainName = t.chain.names[recipe.chain];
  // A deposit started on this card: it stays, through its last step, whatever the vaults read says.
  const [ran, setRan] = useState(false);
  // The vault a deposit into this portfolio adds to, where the person has one: its number is the
  // portfolio's. It follows it, so it is a state, and no new vault can be opened beside it.
  const ownBasket = basketOfPlan(familyIdFor(family.slug));
  const vaults = Array.isArray(mine.vaults) ? mine.vaults : [];
  const own = vaults.find((vault) => vault.basketId === ownBasket);
  const switchable = mine.eligible.filter((vault) => vault.basketId !== ownBasket);
  // Unread, the person's vault for it may be open, and a deposit would go there: no new vault is
  // promised until the vaults are read.
  const failed = mine.vaults === 'failed';
  const canNew = (!own && !failed) || ran;
  const canFollow = switchable.length > 0;
  const way: Way | null =
    mine.way === 'follow' && canFollow
      ? 'follow'
      : mine.way === 'new' && canNew
        ? 'new'
        : canNew
          ? 'new'
          : canFollow
            ? 'follow'
            : null;
  const switching =
    way === 'follow'
      ? (switchable.find((vault) => vault.address === mine.chosen) ?? switchable[0])
      : undefined;
  // Held while a deposit is signed or a follow is being made: the way is the one under way.
  const locked = running || mine.busy !== null;
  const ways = [
    {
      value: 'new' as const,
      title: x.newVault.title,
      line: canNew ? (
        x.newVault.line
      ) : own ? (
        <>
          {x.newVault.open}{' '}
          <Link
            href={`/vaults/${own.chain}/${encodeURIComponent(own.address)}`}
            title={own.address}
            className="font-medium text-foreground underline decoration-1 underline-offset-4 hover:decoration-2"
          >
            {mine.nameOf(own)}
          </Link>
        </>
      ) : (
        v.failure
      ),
      open: canNew,
    },
    {
      value: 'follow' as const,
      title: x.follow.title,
      line: failed ? v.failure : canFollow ? x.follow.line(chainName) : x.follow.none(chainName),
      open: canFollow,
    },
  ];

  return (
    <>
      {panel(
        <>
          {mine.related.length > 0 && (
            <Following mine={mine} recipe={recipe} followed={followed} onReread={onReread} />
          )}
          {/* both ways, always: one that cannot be taken here says why in its own line */}
          <OptionCards
            ui="family-ways"
            legend={x.legend}
            value={way}
            locked={locked}
            options={ways.map((option) => ({ ...option, disabled: !option.open }))}
            onChange={(next) => {
              mine.clear();
              mine.setWay(next);
            }}
          />
        </>,
      )}
      {way === 'new' && (
        <DepositCard
          key={shown}
          headingLevel={3}
          title={x.firstDeposit}
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
              onProgress={() => {
                setRan(true);
                onRunning(true);
              }}
              onDone={() => {
                onRunning(false);
                // the vault it opened follows the portfolio now: said above, as a state (F3)
                mine.reread();
              }}
              onStopped={() => onRunning(false)}
              onVersionChanged={onVersionChanged}
              onAmount={change}
            />
          )}
        />
      )}
      {way === 'follow' && switching && (
        <div data-ui="review-follow" className="flex min-w-0 flex-col gap-4">
          <AmountCard
            mode="deposit"
            // a follow moves no money: the card says what it does, not "Deposit"
            title={v.followWith}
            headingLevel={3}
            chain={recipe.chain}
            chainName={chainName}
            provenance={mock ? 'mock' : recipe.provenance}
            into={{
              label: x.vault,
              value: switching.address,
              options: switchable.map((vault) => ({
                value: vault.address,
                label: mine.nameOf(vault),
                title: vault.address,
              })),
              hint: mine.keep(switching) ? v.followNoteKeeper : v.followNote,
              ...(locked
                ? {}
                : {
                    onChange: (next: string) => {
                      mine.clear();
                      mine.setChosen(next);
                    },
                  }),
            }}
            field={null}
            preview={{
              title: t.amount.preview.targets,
              body: (
                <div className="flex flex-col gap-2">
                  <p className="text-body-sm [overflow-wrap:anywhere]">
                    {t.amount.preview.switch(
                      mine.nameOf(switching),
                      family.name,
                      followed.follow.version,
                    )}
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
              label: t.amount.review,
              reasons: [],
              busy: mine.busy !== null,
              busyLabel: t.amount.busy,
              onPress: () => void mine.follow(switching, mine.keep(switching), true, 'card'),
            }}
          />
          {/* what following would trade, quoted now: our keeper's to make where auto-follow stays on */}
          {!mine.keep(switching) && (
            <FollowQuote
              key={`${switching.address}:${followed.follow.version}`}
              chain={person.chain}
              mock={person.mock}
              address={switching.address}
              slug={family.slug}
              version={followed.follow.version}
            />
          )}
        </div>
      )}
    </>
  );
}

/**
 * The person's vaults on this chain that follow this portfolio, each a state with the way to it: the
 * prompt when a newer version has taken effect or waits, and the auto-follow switch where it is offered.
 */
function Following({
  mine,
  recipe,
  followed,
  onReread,
}: {
  mine: FamilyVaults;
  recipe: SharedRecipe;
  followed: Followed;
  /** Reads the portfolio again from our server, and with it the chain. */
  onReread: () => void;
}) {
  const t = useT();
  const x = t.shared.actions;
  const v = t.shared.vaults;
  const { related, busy, follow, keep, nameOf } = mine;
  const offered = recipe.autoFollow.offered;
  return (
    <div className="flex flex-col gap-3">
      <ul data-ui="family-following" className="flex flex-col gap-3">
        {related.map((vault) => {
          const behind = vault.acceptedVersion < followed.follow.version;
          return (
            <li
              key={vault.address}
              data-ui="my-vault"
              className="flex flex-col items-start gap-2 rounded-md border border-border px-3 py-2.5"
            >
              <p className="flex w-full min-w-0 items-start gap-1.5 text-body-sm">
                <StatusMark status="on-track" size={12} className="mt-1 shrink-0" />
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  {/* its name; its address on hover (AMOUNT-CARD) */}
                  <Link
                    title={vault.address}
                    href={`/vaults/${vault.chain}/${encodeURIComponent(vault.address)}`}
                    className="font-medium text-foreground underline decoration-1 underline-offset-4 hover:decoration-2"
                  >
                    {nameOf(vault)}
                  </Link>{' '}
                  {x.follows}
                  <span className="text-muted-foreground">
                    {' · '}
                    {x.version(vault.acceptedVersion)}
                  </span>
                </span>
              </p>
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
                <div className="flex w-full flex-wrap items-center justify-between gap-2">
                  <span className="text-caption text-muted-foreground">
                    {v.autoIs(vault.autoFollow)}
                  </span>
                  <Button
                    variant="secondary"
                    size="dense"
                    disabled={busy !== null}
                    busy={busy === `${vault.address}:${!vault.autoFollow}:false`}
                    onClick={() => follow(vault, !vault.autoFollow, false)}
                  >
                    {vault.autoFollow ? v.autoOff : v.autoOn}
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <FollowFailure mine={mine} from="list" onReread={onReread} />
    </div>
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
      <p className="text-body-sm font-medium">{p.title}</p>
      <p className="text-body-sm">
        {waiting && vault.pending
          ? p.waits(
              vault.pending.version,
              utcMinute(new Date(vault.pending.effectiveAt * 1000).toISOString()),
            )
          : p.inEffect(version)}
      </p>
      {added.length > 0 && (
        <p className="text-body-sm">{p.newAssets(added.map((a) => tokenName(a)).join(', '))}</p>
      )}
      {behind && (
        <Button variant="secondary" busy={busy} onClick={onAccept}>
          {p.accept(version)}
        </Button>
      )}
    </div>
  );
}
