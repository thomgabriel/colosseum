'use client';
import {
  type ConsentKind,
  chainFamily,
  type Leg,
  type OrderDetail,
  TRUST_STATUS,
  type Trade,
} from '@colosseum/schemas';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../../components/ui/Button';
import { buttonClass } from '../../components/ui/button-class';
import { Stat, StatRow } from '../../components/ui/Card';
import { ChainBadge } from '../../components/ui/ChainBadge';
import { CopyButton } from '../../components/ui/CopyButton';
import { ExplorerLink } from '../../components/ui/ExplorerLink';
import { PAGE_TITLE } from '../../components/ui/heading';
import { Panel, PanelBody, PanelHead } from '../../components/ui/Panel';
import { StatusMark } from '../../components/ui/StatusMark';
import { type Dictionary, LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { useAccount } from '../account/AccountProvider';
import { dollars } from '../goal/sheet';
import { useVaultNow, type VaultNow } from '../portfolio/chain-vault';
import { utc } from '../portfolio/figures';
import { readPersonPlans, recordsOfPlans } from '../portfolio/server-plans';
import { SharedReview } from '../shared/SharedReview';
import { useApiFetch, useWalletPort } from '../wallet/WalletProvider';
import { formatBps, formatRaw, shownRaw, tokenName } from './amounts';
import { landedSentence, type OrderEmbed, progressOf } from './invest-words';
import {
  addMoneyPath,
  type CallFailure,
  continueOrder,
  continuesOrders,
  readOrder,
  rebalancePath,
} from './order-api';
import {
  checkContinuation,
  checkDeposit,
  checkFamilyBuy,
  checkVaultAdd,
  type DepositCheck,
  depositLanded,
  dollarsShapeOk,
  leftOfApproved,
  leftOfPlan,
  movesCash,
  rebalanceShapeOk,
  retargetShapeOk,
  sharedShapeOk,
  stepCalls,
  stoppedShort,
} from './order-check';
import { announceOrderDone } from './order-done';
import {
  acceptTrust,
  isBuy,
  keepOrder,
  type OrderRecord,
  recallOrder,
  recallOrders,
  trustAccepted,
} from './order-record';
import {
  changeHero,
  depositPicture,
  orderCosts,
  type Picture,
  shareItems,
  stepWordsOf,
  withdrawLeast,
  withdrawPicture,
} from './order-summary';
import { legsInOrder, type NextStep, type OutcomeView, outcomeView, stepOf } from './order-view';
import { readStoredPlan } from './plan-store';
import { targetsOfPlan } from './plan-terms';
import { chainIsLive, chainReady, explorerNameFor, explorerUrlFor, onMock } from './readiness';
import { planNumberOf, type RunOutcome, useOrderRunner } from './run-order';
import {
  AmountList,
  Fold,
  OrderHero,
  OrderStats,
  Rounded,
  ShareList,
  type SignedStep,
  SignedSteps,
  StepPanel,
  StepStrip,
} from './SignFlow';
import { TrustNotice } from './TrustNotice';
import { tradeLine } from './trade-line';
import { type ChainUnits, unitsFor } from './units';
import { CostsWait, OrderScreenWait, StepsWait } from './waits';
import { useStayed } from './withdraw-stayed';

// The order, one screen at a time (gate SIGN-ONE-STEP): what changes and its worst case, then each step
// on its own with a button that names it, then what the order did. The exact figures of every step are
// one fold away on each screen. The review shows the order as the API made it; when the person presses the button that order, exactly as
// shown, is kept with the consents they ticked, and every run is handed that and nothing read later.
// The signing is `execute()` of @colosseum/sdk through run-order.ts: this screen never holds the wallet's
// signing members, only the answer. Status changes are said in an aria-live region, with the explorer
// link of each landed step.

type Load = { kind: 'loading' } | { kind: 'read'; order: OrderDetail } | { kind: CallFailure };

/** Why an order is not offered for signing, or that it may be, with what it deposits. */
type Check = DepositCheck | { ok: false; why: 'trades' | 'shape' | 'withdraw' };

/**
 * The order's cash is in the vault: its deposit landed, or it finishes another order and deposits
 * nothing, so the cash it spends is what that one left there.
 */
const cashIn = (order: OrderDetail) => depositLanded(order) || order.continues !== undefined;

/**
 * Before an order is offered for signing (order-check.ts): a buy of a plan deposits what was typed; a
 * buy of a shared portfolio does too, and spends it on the weights its screen read; an add to a vault
 * deposits it into that vault and spends it on the vault's targets; a follow and a publish move nothing and have only the steps their terms call for.
 */
function checkOf(order: OrderDetail, record: OrderRecord, units: ChainUnits | null): Check {
  const terms = record.terms;
  // An order that finishes another deposits nothing: it is held to the trades that one left.
  if (record.continues)
    return checkContinuation(order, record.continues, units, order !== record.approved?.order);
  if (!terms) return checkDeposit(order, record.amountUsd, units);
  if (terms.kind === 'family') return checkFamilyBuy(order, record.amountUsd, units, terms.targets);
  if (terms.kind === 'vault') return checkVaultAdd(order, record.amountUsd, units, terms);
  if (terms.kind === 'retarget')
    return retargetShapeOk(order, terms, units)
      ? { ok: true, depositRaw: 0n, decimals: 0 }
      : { ok: false, why: 'shape' };
  if (terms.kind === 'withdraw' && terms.dollars)
    return dollarsShapeOk(order, terms, units)
      ? { ok: true, depositRaw: 0n, decimals: 0 }
      : { ok: false, why: 'withdraw' };
  if (terms.kind === 'rebalance')
    return rebalanceShapeOk(order, terms, units)
      ? { ok: true, depositRaw: 0n, decimals: 0 }
      : { ok: false, why: 'shape' };
  return sharedShapeOk(order, terms)
    ? { ok: true, depositRaw: 0n, decimals: 0 }
    : { ok: false, why: terms.kind === 'withdraw' ? 'withdraw' : 'shape' };
}
type Phase = { legId: string; phase: string } | null;

export function OrderScreen({
  id,
  embed,
}: {
  id: string;
  /**
   * Drawn inside the invest card (InvestCard.tsx, gate INVEST-ONE-PRESS): the same review, the same
   * one press and the same run, with no page title of its own, the card's words on the button and
   * its progress in one line. Everything that decides what is signed is as on the order's own page.
   */
  embed?: OrderEmbed;
}) {
  const t = useT();
  const lang = useLang();
  const port = useWalletPort();
  const { account } = useAccount();
  const apiFetch = useApiFetch();
  const { run } = useOrderRunner();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [record, setRecord] = useState<OrderRecord | null | undefined>(undefined);
  const [live, setLive] = useState<OrderDetail | null>(null);
  const [phase, setPhase] = useState<Phase>(null);
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<RunOutcome | null>(null);
  const [consents, setConsents] = useState<ConsentKind[]>([]);
  const [round, setRound] = useState(0);
  // The person read the review and went on to the steps: nothing is approved until the first is signed.
  const [onward, setOnward] = useState(embed?.reviewed === true);
  // Moving between screens takes the focus along, since what was pressed is gone from the screen:
  // "Continue" to the step's large line and "Back" to "Continue"; and where the focus was lost as the
  // screen changed by itself (the one press of the invest card, the last step confirmed), to the new
  // screen's large line.
  const [focusTo, setFocusTo] = useState<'step' | 'review' | null>(null);
  const shell = useRef<HTMLDivElement>(null);
  const seenStage = useRef<string | undefined>(undefined);
  useEffect(() => {
    const root = shell.current;
    const stageNow = root?.dataset.stage;
    const stageBefore = seenStage.current;
    seenStage.current = stageNow;
    if (!root) return;
    if (stageNow && stageNow !== stageBefore)
      embed?.onStage?.(stageNow as 'review' | 'steps' | 'done');
    const hero = () => root.querySelector<HTMLElement>('[data-ui="sign-hero"]');
    if (focusTo) {
      (focusTo === 'step'
        ? hero()
        : root.querySelector<HTMLElement>('[data-action="order-continue"]')
      )?.focus();
      setFocusTo(null);
      return;
    }
    if (!stageNow || !stageBefore || stageNow === stageBefore) return;
    const at = document.activeElement;
    const lost = !at || at === document.body || !at.isConnected;
    if (lost && (stageNow === 'steps' || stageNow === 'done')) hero()?.focus();
  });
  const stop = useRef({ aborted: false });
  // The person asked to stop between steps: the step under way is finished, the next is not begun.
  const [stopping, setStopping] = useState(false);
  // What keeps the acceptance of the trust notice, set by the first press and called as the run begins.
  const accepts = useRef<(() => void) | null>(null);
  // The trust notice, ticked on this page: for an order made before the notice was ever accepted.
  const [trustTicked, setTrustTicked] = useState(false);
  const router = useRouter();
  // Whether this server finishes a buy with the cash in its vault: asked only once an order has
  // stopped after its deposit, and the button is not there until the answer is yes.
  const [canFinish, setCanFinish] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [finishFailure, setFinishFailure] = useState<{ text: string; orderId?: string } | null>(
    null,
  );
  const titleId = useId();
  const reasonId = useId();
  const userId = port.userId;
  // A withdrawal that is done is held to the vault: what a confirmed step left behind is said.
  const stayed = useStayed(
    apiFetch,
    live ?? (load.kind === 'read' ? load.order : null),
    record?.terms,
    record?.chain,
  );

  useEffect(() => {
    setRecord(recallOrder(id, userId));
  }, [id, userId]);

  // The order and the person the read on the screen is of. A second look at the same one (the wallet
  // reported again, a step landed) leaves the screen as it is until the answer is here, and an answer
  // that is no read leaves it standing: an order that is being run is never taken off the screen by
  // a look at it.
  const readOf = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `round` reads the order again
  useEffect(() => {
    if (port.status !== 'ready') return;
    let mine = true;
    const of = `${id}|${userId ?? ''}`;
    const again = readOf.current === of;
    if (!again) {
      readOf.current = null;
      setLoad({ kind: 'loading' });
    }
    readOrder(apiFetch, id).then((read) => {
      if (!mine) return;
      if (read.kind === 'read') readOf.current = of;
      setLoad((before) =>
        again && read.kind !== 'read' && before.kind === 'read' ? before : read,
      );
    });
    return () => {
      mine = false;
    };
  }, [id, userId, apiFetch, port.status, round]);

  // An order that stopped for good is the one case a buy may be finished from: only then is the
  // server asked whether it can. Stopped as this page just saw it, or as the order itself says when
  // the page is opened again, here or in another browser.
  const stopped =
    outcome?.status === 'refused' || outcome?.status === 'failed' || outcome?.status === 'expired';
  const seen = live ?? (load.kind === 'read' ? load.order : null);
  const short = seen !== null && stoppedShort(seen);
  // Only a buy or an add can be finished: a withdrawal, a follow or a publish never asks.
  const finishable = !record?.terms || record.terms.kind === 'vault';
  useEffect(() => {
    if ((!stopped && !short) || !finishable) return;
    let mine = true;
    void continuesOrders(apiFetch).then((yes) => {
      if (mine) setCanFinish(yes);
    });
    return () => {
      mine = false;
    };
  }, [stopped, short, finishable, apiFetch]);

  // An order this browser did not make, stopped after its deposit: its plan as the server stores it
  // (the list of the person's plans, then the plan's lines), to finish the buy from here too. Nothing
  // of the first order is offered for signing from it: an order is signed where it was reviewed.
  const [served, setServed] = useState<OrderRecord | null | undefined>(undefined);
  useEffect(() => {
    if (record !== null || load.kind !== 'read' || !userId) return;
    if (!cashIn(load.order) || !stoppedShort(load.order)) return setServed(null);
    let mine = true;
    setServed(undefined);
    void (async () => {
      const listed = recordsOfPlans(await readPersonPlans(apiFetch), userId).find(
        (r) => r.orderId === id,
      );
      const plan = listed ? await readStoredPlan(apiFetch, listed.proposalId) : null;
      if (mine)
        setServed(
          listed && plan && plan !== 'gone' ? { ...listed, lines: plan.proposal.lines } : null,
        );
    })();
    return () => {
      mine = false;
    };
  }, [record, load, userId, id, apiFetch]);

  // The vault as it stands on its chain, read from this app's own node, for the two offers our server's
  // word is not enough for: an order that finishes another from a browser that never reviewed the
  // first (not offered for more cash than the vault holds), and an add of money (not offered once the
  // vault's auto-follow is on: the keeper buys with the cash). Asked only for those, once the order
  // is known to have stopped; `unknown` where there is no node, and then nothing changes.
  const stood = record ?? served ?? null;
  const signer = stood ? port.active(chainFamily(stood.chain)) : null;
  const numbered =
    !stood || !seen
      ? null
      : stood.terms
        ? stood.terms.kind === 'vault'
          ? stood.terms.basketId
          : null
        : planNumberOf(seen.basketId, stood);
  const asked =
    short && signer && numbered !== null && (record === null || record?.terms?.kind === 'vault')
      ? { owner: signer.address, basketId: numbered }
      : null;
  const read = useVaultNow(stood?.chain ?? null, stood ? onMock(port, stood.chain) : false, asked);
  const vaultNow: VaultNow = asked ? read : { state: 'unknown' };

  /**
   * Makes the order that finishes `first` (the order of `from`) with the cash in its vault, held to
   * `trades`, and opens its review. `first` is what the answer is held to for owner, vault and chain:
   * the copy approved here, or the server's own in a browser that never reviewed it (`unseen`), which
   * the new order's review then says.
   */
  async function finish(
    from: OrderRecord,
    first: Pick<OrderDetail, 'id' | 'owner' | 'basketId' | 'legs'>,
    trades: Trade[],
    unseen: boolean,
  ) {
    if (finishing) return;
    // In a card that takes it (the pane of /invest), the order that finishes this one is shown there.
    const open = (orderId: string) => {
      if (!embed?.onFinish) return router.push(`/portfolio/orders/${encodeURIComponent(orderId)}`);
      setFinishing(false);
      embed.onFinish(orderId);
    };
    // An order is finished by one order. Where this browser already has it, that order is opened
    // and nothing is asked for: what the first one left is that order's, and its record, with what
    // the person approved in it, stays as it is.
    const mine = recallOrders(from.userId).find((r) => r.continues?.orderId === from.orderId);
    if (mine) return open(mine.orderId);
    setFinishing(true);
    setFinishFailure(null);
    const o = t.order.outcome;
    const made = await continueOrder(apiFetch, first);
    if (made.kind !== 'placed') {
      setFinishing(false);
      if (made.kind === 'unavailable') return setCanFinish(false);
      // A step had landed and the server has settled it: the order as it now stands is the answer.
      if (made.kind === 'refused' && made.why === 'landed') return setRound((n) => n + 1);
      if (made.kind === 'refused') {
        // Each refusal this app knows in its own words, in the language of the page; one it does
        // not, in the server's. An order that already finishes this one is linked.
        const said = {
          'other-order': o.finishOther,
          working: o.finishWorking,
          'in-flight': o.finishLater,
          'nothing-left': o.finishNothing,
          'cash-short': o.finishShort,
          'not-deposited': o.finishNotDeposited,
          unsupported: o.finishUnsupported,
          landed: '',
          said: o.finishRefused(made.sentence),
        }[made.why];
        return setFinishFailure({ text: said, ...(made.orderId ? { orderId: made.orderId } : {}) });
      }
      setFinishFailure({
        text:
          made.kind === 'busy'
            ? t.shell.slowDown
            : made.kind === 'signed-out'
              ? t.buy.failure.signedOut
              : made.kind === 'unreadable'
                ? t.buy.failure.unreadable
                : t.buy.failure.unreachable,
      });
      return;
    }
    // The server answers the same order while it can still be signed: one this browser kept (in
    // another tab, a moment ago) is not written over.
    if (recallOrder(made.order.id, from.userId)) return open(made.order.id);
    // The new order's record: the same plan and vault, nothing approved yet, and what it is held to.
    const kept = keepOrder({
      orderId: made.order.id,
      userId: from.userId,
      proposalId: from.proposalId,
      chain: from.chain,
      amountUsd: from.amountUsd,
      lines: from.lines,
      approved: null,
      ...(from.linked ? { linked: true as const } : {}),
      // an add's order names its vault through its terms: the next one is held to the same vault
      ...(from.terms ? { terms: from.terms } : {}),
      continues: { orderId: from.orderId, trades, ...(unseen ? { unseen: true as const } : {}) },
    });
    if (!kept) {
      setFinishing(false);
      return setFinishFailure({ text: t.buy.failure.noStore });
    }
    open(made.order.id);
  }

  // The card that holds this screen is told how far the steps are, and how they ended.
  // An approved order read back with every step confirmed (the card took it up again after a reload) is
  // told as done too: no run of this screen will say so.
  const told = useRef<string | null>(null);
  const readDone = load.kind === 'read' && load.order.status === 'done';
  useEffect(() => {
    if (!embed || !record?.approved || running) return;
    const status = outcome?.status ?? (readDone ? 'done' : null);
    if (!status) return;
    const key = `${record.orderId}:${status}`;
    if (told.current === key) return;
    told.current = key;
    if (status === 'done') embed.onDone?.({ orderId: record.orderId });
    else embed.onStopped?.({ orderId: record.orderId });
  }, [embed, record, running, outcome, readDone]);

  // Leaving the page stops the run between steps; what was signed is still reported. The signal is
  // the one of the run under way, read as the screen goes: each press hands the executor a new one.
  useEffect(
    () => () => {
      stop.current.aborted = true;
    },
    [],
  );

  // The same when the screen stays and the order's steps are not on it: the person signed out, the
  // wallet is being read again, the record of what they approved is another person's. A run is only
  // ever under way with its steps shown; where they are not, the executor is told to stop, and it asks
  // the wallet for nothing more (packages/sdk, `signal`).
  const onScreen =
    port.status !== 'loading' &&
    port.status !== 'signed-out' &&
    account.status !== 'loading' &&
    load.kind === 'read' &&
    !!record;
  useEffect(() => {
    if (running && !onScreen) stop.current.aborted = true;
  }, [running, onScreen]);

  const go = useCallback(
    async (again?: { legId: string; signedTimes: number }, first = false) => {
      if (!record) return;
      // The order as the review screen showed it, kept from the moment the person approved it.
      let approved = record.approved;
      // Never run an order that does not deposit what the person typed (order-check.ts).
      const order = approved?.order ?? (load.kind === 'read' ? load.order : null);
      if (!order || !checkOf(order, record, unitsFor(record.chain, onMock(port, record.chain))).ok)
        return;
      if (!approved) {
        if (load.kind !== 'read') return;
        approved = { order: load.order, consents, at: new Date().toISOString() };
        const next = { ...record, approved };
        if (!keepOrder(next)) {
          setOutcome({ status: 'not-runnable', why: 'no-store' });
          return;
        }
        setRecord(next);
      }
      // Approved only once the order is checked and kept: a press that cannot run locks nothing.
      if (first) embed?.onApprove();
      // The first press's acceptance of the trust notice, kept once and only when the run begins.
      const begun = () => {
        accepts.current?.();
        accepts.current = null;
      };
      stop.current = { aborted: false };
      // Each run tells its host how it ended: one that stops as the last one did is told again.
      told.current = null;
      setStopping(false);
      setRunning(true);
      setOutcome(null);
      // A run asked for again ("Try again", "Continue") is under way from the press, before its
      // first step answers: the host is told at once.
      if (!first) embed?.onProgress?.({ orderId: record.orderId, step: 0, of: 0, line: '' });
      const answer = await run({
        order: approved.order,
        plan: {
          proposalId: record.proposalId,
          lines: record.lines,
          userId: record.userId,
          ...(record.linked ? { linked: true } : {}),
        },
        ...(record.terms ? { terms: record.terms } : {}),
        consents: approved.consents,
        ...(again ? { approvedAgain: again } : {}),
        onEvent: (event) => {
          begun();
          setLive(event.order);
          setPhase({ legId: event.legId, phase: event.phase });
          if (embed?.onProgress)
            embed.onProgress(
              progressOf(
                approved.order,
                event.legId,
                unitsFor(record.chain, onMock(port, record.chain)),
                t,
                LOCALE[lang],
              ),
            );
        },
        signal: stop.current,
      });
      // The run began when the executor reached a step (above), or answers that every step is
      // confirmed. One that could not run here, or was refused before any step, accepted nothing.
      if (answer.status === 'done') begun();
      accepts.current = null;
      if ('order' in answer) setLive(answer.order);
      setPhase(null);
      setOutcome(answer);
      setRunning(false);
      // what the person holds changed: whatever shows it reads it again (order-done.ts)
      if (answer.status === 'done') announceOrderDone(record.orderId);
    },
    [record, load, consents, run, port, embed, t, lang],
  );

  // The host that reads the order's quotes is told of each read of it (gate DEPOSIT-ONE-SCREEN).
  const toldOrder = useRef(embed?.onOrder);
  toldOrder.current = embed?.onOrder;
  const readOrderNow = load.kind === 'read' ? load.order : null;
  useEffect(() => {
    if (readOrderNow) toldOrder.current?.(readOrderNow);
  }, [readOrderNow]);

  if (
    embed &&
    (port.status === 'loading' || account.status === 'loading' || load.kind === 'loading')
  )
    // In the card: one quiet line while the order is read, not a card inside the card; at the host's
    // foot, where the order's line of costs will land, when it keeps its press there.
    return embed.foot && embed.compact ? (
      createPortal(
        <div data-ui="invest-reading" className="flex flex-col gap-3">
          <p className="text-body-sm text-muted-foreground">{t.invest.preparing}</p>
          <CostsWait />
        </div>,
        embed.foot,
      )
    ) : (
      <div data-ui="invest-reading" className="flex flex-col gap-4">
        <p className="text-body-sm text-muted-foreground">{t.invest.preparing}</p>
        <StepsWait />
      </div>
    );
  if (port.status === 'loading' || account.status === 'loading' || record === undefined)
    return <OrderScreenWait />;
  if (port.status === 'signed-out')
    return (
      <Notice
        title={t.order.title}
        body={t.order.signedOut}
        href={`/sign-in?next=/portfolio/orders/${encodeURIComponent(id)}`}
        label={t.shell.signIn}
      />
    );
  if (load.kind === 'loading')
    // The order this browser kept says what the page opens with, so its head is already there.
    return (
      <OrderScreenWait
        head={
          record ? (
            <header className="flex flex-col items-start gap-3">
              <ChainBadge chain={record.chain} />
              <h1 id={titleId} className={PAGE_TITLE}>
                {record.approved ? t.order.title : t.order.review.title}
              </h1>
              {!record.approved && (
                <p className="max-w-(--tf-measure-body) text-body-lg">
                  {record.continues ? t.order.review.continuesLead : t.order.review.lead}
                </p>
              )}
            </header>
          ) : undefined
        }
      />
    );
  if (load.kind !== 'read') {
    const body =
      load.kind === 'no-plan' || load.kind === 'signed-out'
        ? t.order.failure.notFound
        : load.kind === 'busy'
          ? t.shell.slowDown
          : load.kind === 'unreadable'
            ? t.order.failure.unreadable
            : t.order.failure.unreachable;
    return (
      <section aria-labelledby={titleId} className="flex flex-col items-start gap-4">
        <h1 id={titleId} className={PAGE_TITLE}>
          {t.order.title}
        </h1>
        <p className="max-w-(--tf-measure-body) text-body">{body}</p>
        <Button variant="secondary" onClick={() => setRound((n) => n + 1)}>
          {t.order.failure.retry}
        </Button>
      </section>
    );
  }
  if (!record) {
    const first = load.order;
    // Made in another browser and stopped after its deposit: the cash is in the vault, and the buy
    // can be finished from here. Anything else of it is signed where it was reviewed.
    if (cashIn(first) && stoppedShort(first)) {
      if (served === undefined) return <OrderScreenWait />;
      const units = served ? unitsFor(served.chain, onMock(port, served.chain)) : null;
      const cash = units?.tokens[units.cash];
      const targets =
        served && units ? targetsOfPlan(served.lines, served.chain, units.cash) : null;
      // What is left, as the server lists it, held to the plan's lines read from the server.
      const trades = units && targets ? leftOfPlan(first, targets, units.cash) : null;
      // Not for more cash than the vault holds, as this app reads it from the chain where it can.
      const spend = (trades ?? []).reduce((sum, trade) => sum + BigInt(trade.amountInRaw), 0n);
      const cashShort = vaultNow.state === 'read' && spend > vaultNow.cashRaw;
      const offer =
        canFinish &&
        served &&
        trades !== null &&
        trades.length > 0 &&
        chainFamily(served.chain) !== 'evm' &&
        vaultNow.state !== 'reading' &&
        !cashShort;
      const put =
        cash && first.depositRaw !== undefined
          ? dollars(Number(first.depositRaw) / 10 ** cash.decimals, lang)
          : null;
      return (
        <section
          aria-labelledby={titleId}
          data-ui="order-stopped-elsewhere"
          className="flex flex-col items-start gap-4"
        >
          <h1 id={titleId} className={PAGE_TITLE}>
            {t.order.title}
          </h1>
          <p data-ui="order-deposit-kept" className="max-w-(--tf-measure-body) text-body">
            {put ? t.order.outcome.stopped(put) : t.order.outcome.depositKept}
          </p>
          {cashShort && trades !== null && trades.length > 0 && (
            <p data-ui="order-cash-short" className="max-w-(--tf-measure-body) text-body-sm">
              {t.order.outcome.finishShort}
            </p>
          )}
          {offer && (
            <p data-ui="order-unseen" className="max-w-(--tf-measure-body) text-body-sm">
              {t.order.outcome.finishNote} {t.order.review.unseen}
            </p>
          )}
          <div data-ui="order-stopped" className="flex flex-wrap items-center gap-3">
            {offer && (
              <Button
                variant="primary"
                busy={finishing}
                busyLabel={t.order.outcome.finishing}
                onClick={() => finish(served, first, trades, true)}
              >
                {t.order.outcome.finish}
              </Button>
            )}
            <Link
              href="/portfolio/monitor"
              className={buttonClass({ variant: offer ? 'secondary' : 'primary' })}
            >
              {t.order.outcome.seePortfolio}
            </Link>
          </div>
          {finishFailure && (
            <p
              role="alert"
              className="flex max-w-(--tf-measure-body) items-start gap-1.5 text-body-sm text-destructive"
            >
              <StatusMark status="off-track" size={12} className="mt-1.5" />
              <span>
                {finishFailure.text}
                {finishFailure.orderId && (
                  <>
                    {' '}
                    <Link
                      href={`/portfolio/orders/${encodeURIComponent(finishFailure.orderId)}`}
                      data-ui="order-finish-other"
                      className={buttonClass({ variant: 'link' })}
                    >
                      {t.order.outcome.openThatOrder}
                    </Link>
                  </>
                )}
              </span>
            </p>
          )}
        </section>
      );
    }
    return (
      <Notice
        title={t.order.title}
        body={t.order.elsewhere}
        href="/invest"
        label={t.plan.backToGoal}
      />
    );
  }

  const shown = record.approved?.order ?? load.order;
  const now = live ?? load.order;
  const chain = record.chain;
  // Every amount on this screen is the order's own, read with units this repository committed, and the
  // order is offered for signing only when it deposits what the person typed (order-check.ts).
  const units = unitsFor(chain, onMock(port, chain));
  const check = checkOf(shown, record, units);
  const buying = isBuy(record);
  const amount = check.ok
    ? dollars(Number(check.depositRaw) / 10 ** check.decimals, lang)
    : dollars(record.amountUsd, lang);
  const cash = units?.tokens[units.cash];
  const depositShown =
    shown.depositRaw === undefined
      ? '—'
      : cash
        ? `${formatRaw(shown.depositRaw, cash.decimals, LOCALE[lang]) ?? shown.depositRaw} ${cash.symbol}`
        : shown.depositRaw;
  const legs = legsInOrder(shown);
  const done = now.status === 'done';
  // Done with a step skipped (a token that could not move) says so: never plainly done.
  const skippedSteps = now.legs.filter((l) => l.status === 'skipped').length;
  // A token a confirmed step was to take whole and the vault still holds (withdraw-stayed.ts).
  const stayedNames =
    stayed.kind === 'read'
      ? stayed.assets.map((asset) => units?.tokens[asset]?.symbol ?? tokenName(asset))
      : [];
  const plainlyDone =
    skippedSteps === 0 &&
    (stayed.kind === 'none' || (stayed.kind === 'read' && stayed.assets.length === 0));
  const doneSentence =
    skippedSteps > 0
      ? t.order.shared.doneExcept(t.chain.names[chain], skippedSteps)
      : stayedNames.length > 0
        ? t.order.shared.doneStayed(
            t.chain.names[chain],
            new Intl.ListFormat(LOCALE[lang], { type: 'conjunction' }).format(stayedNames),
          )
        : stayed.kind === 'reading'
          ? t.withdraw.loading
          : stayed.kind === 'unread'
            ? t.order.shared.doneUnread(t.chain.names[chain])
            : t.order.outcome.done(t.chain.names[chain]);
  const view: OutcomeView | null = outcome ? outcomeView(outcome, t, chain) : null;
  const needed = shown.needsConsent;
  const consentMissing = !record.approved && needed.some((kind) => !consents.includes(kind));
  const current = phase ? stepOf(shown, phase.legId) : 1;
  // In a host's pane (a vault's own page, /invest) the portfolio is the board, as that page's own way
  // back is; the order's own page still leads to the monitor.
  const portfolioHref = embed?.hostEnds ? '/portfolio' : '/portfolio/monitor';
  const terms = record.terms;
  const newOrder = !terms
    ? `/invest/plan/${encodeURIComponent(record.proposalId)}/buy`
    : terms.kind === 'family'
      ? `/products/${encodeURIComponent(terms.slug)}/buy?chain=${chain}`
      : terms.kind === 'follow'
        ? `/products/${encodeURIComponent(terms.slug)}`
        : terms.kind === 'vault'
          ? addMoneyPath(chain, terms.vault)
          : terms.kind === 'withdraw'
            ? `/portfolio/vaults/${encodeURIComponent(chain)}/${encodeURIComponent(terms.vault)}/withdraw`
            : terms.kind === 'retarget'
              ? `/portfolio/vaults/${encodeURIComponent(chain)}/${encodeURIComponent(terms.vault)}/targets`
              : terms.kind === 'rebalance'
                ? rebalancePath(chain, terms.vault)
                : '/products/publish';
  // The swaps the order left undone: what an order that finishes it would make, and is held to.
  // The trades are the approved order's own, step by step: of the API's later answer only where each
  // step stands is read, so an answer that changed a trade cannot widen what the next order may buy.
  // An order that finishes another and was never approved (it ran out of time on its review) has no
  // approved copy: what it left is all it was held to, the trades kept when it was made.
  const left = record.approved
    ? leftOfApproved(record.approved.order, now)
    : (record.continues?.trades ?? []);
  // A deposit that landed stays in the vault as cash, whatever became of the steps after it.
  const deposited = depositLanded(now);

  // Stopped for good with swaps left and their cash in the vault: after this order's deposit landed,
  // or, for an order that finishes another, with the cash that one left. Said by the run that just
  // stopped, or by the order itself when the page is opened again. Where the server can finish it,
  // that is offered first (the flow audit, finding 24). Not on an EVM chain: the route refuses those.
  const halted = !view && !running && stoppedShort(now);
  const stranded =
    !done &&
    !running &&
    (deposited || record.continues !== undefined) &&
    // a buy of a plan, or money added to a vault: both deposit, then swap (order-check.ts)
    (!terms || terms.kind === 'vault') &&
    left.length > 0 &&
    chainFamily(chain) !== 'evm' &&
    (view?.next.kind === 'new-order' || halted);
  // Opened again on an order that goes no further: there is nothing of it left to sign.
  const over = stranded && halted;
  // An add into a vault whose auto-follow is on now, as the chain says: the keeper buys the vault's
  // assets with that cash, so no order is made for it.
  const keeperBuys =
    stranded && terms?.kind === 'vault' && vaultNow.state === 'read' && vaultNow.autoFollow;
  const offerFinish = stranded && canFinish && vaultNow.state !== 'reading' && !keeperBuys;

  // One screen at a time (gate SIGN-ONE-STEP). The review says what changes and its worst case; the
  // steps are signed one to a screen, each named by what it does; the end says what the order did.
  // A deposit in the invest card is one press (INVEST-ONE-PRESS): the card is its review, and its press
  // signs the first step. Any other order is reviewed, then "Continue" leads to its first step.
  const flow = t.order.flow;
  const locale = LOCALE[lang];
  const multipliers =
    terms?.kind === 'withdraw'
      ? Object.fromEntries(terms.items.map((i) => [i.asset, i.multiplier]))
      : undefined;
  const summary = { units, t, locale, ...(multipliers ? { multipliers } : {}) };
  const words = stepWordsOf(shown, summary);
  const onePress = !!embed && buying;
  const stage: 'review' | 'steps' | 'done' =
    done && !running ? 'done' : record.approved || onward || running || view ? 'steps' : 'review';
  // The step on the screen: the one under way, the one the last answer was about, or the first not
  // confirmed yet.
  const answered = outcome && 'legId' in outcome ? outcome.legId : null;
  const onLeg = phase?.legId ?? answered;
  const at = (() => {
    const named = onLeg ? legs.findIndex((leg) => leg.id === onLeg) : -1;
    if (named >= 0) return named;
    const open = legs.findIndex((leg) => {
      const status = (now.legs.find((l) => l.id === leg.id) ?? leg).status;
      return status !== 'confirmed' && status !== 'skipped';
    });
    return open < 0 ? Math.max(0, legs.length - 1) : open;
  })();
  const mock = onMock(port, chain);
  // A skipped step moved nothing: it is never listed as signed, and the strip marks it skipped.
  const skippedAt = legs.flatMap((leg, i) =>
    (now.legs.find((l) => l.id === leg.id) ?? leg).status === 'skipped' ? [i] : [],
  );
  const signed: SignedStep[] = legs.slice(0, at).flatMap((leg, i) => {
    const standing = now.legs.find((l) => l.id === leg.id) ?? leg;
    if (standing.status !== 'confirmed') return [];
    return [
      {
        key: leg.id,
        name: words[i]?.title ?? t.order.kind[leg.kind],
        txId: standing.txId,
        href: standing.txId
          ? explorerUrlFor(leg.chain, standing.txId, mock, mock ? undefined : leg.provenance)
          : null,
      },
    ];
  });
  // What changes, at a glance: the order's one large line, then the targets before and after (a
  // change, a rebalance), where a deposit goes, or what leaves.
  const before = embed?.before ?? null;
  const shares =
    terms?.kind === 'retarget' || terms?.kind === 'rebalance'
      ? shareItems(terms.targets, before, summary)
      : null;
  const picture: Picture | null =
    terms?.kind === 'withdraw'
      ? withdrawPicture(shown, summary)
      : buying
        ? depositPicture(shown, summary)
        : null;
  const leastFigure = terms?.kind === 'withdraw' ? withdrawLeast(shown, summary) : null;
  const reviewHero =
    terms?.kind === 'retarget'
      ? changeHero(terms.targets, before, summary)
      : terms?.kind === 'rebalance'
        ? flow.hero.rebalance
        : terms?.kind === 'withdraw'
          ? flow.hero.withdraw(
              terms.dollars && leastFigure
                ? flow.atLeast(leastFigure.shown).replace(/^./, (c) => c.toLocaleUpperCase(locale))
                : new Intl.ListFormat(locale, { type: 'conjunction' }).format(
                    (picture?.rows ?? []).map((row) => row.name),
                  ),
            )
          : terms?.kind === 'publish'
            ? t.order.shared.publishTitle
            : terms?.kind === 'follow'
              ? t.order.shared.followTitle
              : record.continues
                ? flow.hero.finish
                : buying && shown.depositRaw !== undefined
                  ? flow.hero.deposit(amount)
                  : t.order.review.title;
  const shareOf = (bps: number) =>
    new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(
      bps / 10_000,
    );
  const pointsOf = (bps: number) =>
    flow.picture.points(
      new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(bps / 100),
    );
  // a rebalance sets what the vault holds now beside its targets; a change, its targets before and after
  const shareLabels =
    terms?.kind === 'rebalance'
      ? {
          before: flow.picture.holdsNow,
          after: flow.picture.target,
          unchanged: flow.picture.unchanged,
        }
      : {
          // the targets before the change, never "now": what the vault holds now is another figure
          before: flow.picture.before,
          after: flow.picture.next,
          unchanged: flow.picture.unchanged,
        };

  // The one primary button of the view: sign, carry on, approve a step again, or nothing.
  const next: NextStep | { kind: 'first' } =
    view?.next ?? (record.approved ? { kind: 'run' } : { kind: 'first' });
  const primaryLabel =
    next.kind === 'approve-again'
      ? t.order.outcome.approveAgain(next.step)
      : next.kind === 'run' && view && outcome?.status === 'waiting' && outcome.why === 'stopped'
        ? // the person stopped it between steps: the same order goes on from where it is
          t.order.resume(amount)
        : next.kind === 'run' && view && outcome?.status === 'waiting'
          ? t.order.outcome.lookAgain
          : next.kind === 'run' && view
            ? t.order.outcome.tryAgain
            : next.kind === 'first' && !onePress
              ? // the first signature names its step and amount: "Sign: set the new targets"
                (words[at]?.press ?? flow.press.step)
              : record.approved
                ? // taken up again after a reload: a deposit names its amount, anything else goes on
                  buying
                  ? t.order.resume(amount)
                  : (words[at]?.press ?? flow.press.step)
                : record.continues
                  ? // the invest card's one press, of an order that deposits nothing
                    t.order.outcome.finishSign
                  : t.invest.press(amount);
  // A deposit is never signed for before the trust notice is accepted (DESIGN-VAULT section 13). The
  // invest card makes the order before that, to show its prices, so the order's own page asks too:
  // an order opened here that nobody approved is held until the notice is accepted, as on the card.
  // A plan's own vault follows nothing, so the keeper's limits are not among its short points.
  const keeperTrades = terms !== undefined;
  const trustAsked =
    !embed &&
    buying &&
    !record.approved &&
    !trustAccepted(userId, TRUST_STATUS.textVersion, keeperTrades, chainIsLive(chain));
  // What holds the first press back: in the invest card, the host's reasons; here, the notice.
  const held = record.approved
    ? []
    : embed
      ? embed.blocked
      : trustAsked && !trustTicked
        ? [t.buy.blocked.trust]
        : [];
  // The passkey wallet signs with no window of its own; any other wallet confirms each step in its own.
  const quiet = port.active(chainFamily(chain))?.kind === 'embedded';
  // The passkey wallet signs every step on one press: before it, the screen is the whole order's, its
  // large line the review's and its button the order's ("Sign the change"); the strip says what will
  // happen. Another wallet confirms each step in its own window: each step keeps its own screen.
  const wholeOrder =
    stage === 'steps' && next.kind === 'first' && quiet && !running && !onePress && legs.length > 1;
  const withdrawn = new Intl.ListFormat(locale, { type: 'conjunction' }).format(
    words.flatMap((w) => (w.subject ? [w.subject] : [])),
  );
  // Where every token leaves whole, the button says so once: "Sign: withdraw all of your SPY and
  // NVDA", not "all of your" before each. A button that signs still names its amount (apps/web).
  const outs = legs.flatMap((leg) => leg.withdrawals ?? []);
  const withdrawnNames =
    outs.length > 0 && outs.every((w) => w.amountRaw === null)
      ? flow.allOf(
          new Intl.ListFormat(locale, { type: 'conjunction' }).format([
            ...new Set(outs.map((w) => units?.tokens[w.asset]?.symbol ?? tokenName(w.asset))),
          ]),
        )
      : withdrawn;
  const wholePress =
    terms?.kind === 'retarget'
      ? flow.press.change
      : terms?.kind === 'rebalance'
        ? flow.press.rebalance
        : terms?.kind === 'withdraw'
          ? flow.press.withdraw(
              terms.dollars && leastFigure ? flow.atLeast(leastFigure.shown) : withdrawnNames,
            )
          : terms?.kind === 'publish'
            ? flow.press.publish
            : terms?.kind === 'follow'
              ? flow.press.follow
              : buying
                ? flow.press.deposit(amount)
                : flow.press.step;

  // A withdrawal in dollars: the least its cash step pays, which the check held to the share of the
  // cash reviewed plus every sale's minimum.
  const leastRaw =
    terms?.kind === 'withdraw' && terms.dollars && check.ok
      ? legs.at(-1)?.withdrawals?.[0]?.leastRaw
      : undefined;
  const leastOut =
    leastRaw === undefined
      ? null
      : cash
        ? `${formatRaw(leastRaw, cash.decimals, LOCALE[lang]) ?? leastRaw} ${cash.symbol}`
        : leastRaw;

  // A withdrawal in dollars that stopped with some of its sales landed: which, and the least they
  // brought into the vault, from the minimums the order stated.
  const landedSales =
    terms?.kind === 'withdraw' && terms.dollars && stoppedShort(now)
      ? legs.filter(
          (leg) =>
            leg.kind === 'swap' &&
            (now.legs.find((l) => l.id === leg.id)?.status ?? leg.status) === 'confirmed',
        )
      : [];
  const soldBefore =
    landedSales.length > 0
      ? {
          names: new Intl.ListFormat(LOCALE[lang], { type: 'conjunction' }).format(
            landedSales.flatMap((l) =>
              l.trades.map((x) => units?.tokens[x.sell]?.symbol ?? tokenName(x.sell)),
            ),
          ),
          least: (() => {
            const raw = landedSales
              .flatMap((l) => l.expected)
              .reduce((n, e) => n + BigInt(e.minOutRaw), 0n)
              .toString();
            return cash
              ? `${formatRaw(raw, cash.decimals, LOCALE[lang]) ?? raw} ${cash.symbol}`
              : raw;
          })(),
        }
      : null;

  const stepsBody = (
    <>
      <StatRow>
        {/* an order that finishes another deposits nothing */}
        {buying && !record.continues && <Stat label={t.order.review.deposit}>{depositShown}</Stat>}
        {record.continues && check.ok && <Stat label={t.order.review.fromVault}>{amount}</Stat>}
        {leastOut && (
          <Stat label={t.order.shared.receiveAtLeast}>
            <span data-ui="withdraw-least">{leastOut}</span>
          </Stat>
        )}
        <Stat label={t.order.review.steps}>{legs.length}</Stat>
        {!record.approved && (
          <Stat label={t.order.review.expires} className="max-[620px]:col-span-2">
            <time dateTime={new Date(shown.expiresAt * 1000).toISOString()}>
              {/* the one way this app writes a time: the date, the minute and the zone */}
              {utc(lang, shown.expiresAt)}
            </time>
          </Stat>
        )}
      </StatRow>
      <ol className="flex flex-col divide-y divide-border">
        {legs.map((leg, i) => {
          const standing = now.legs.find((l) => l.id === leg.id) ?? leg;
          return (
            <Step
              key={leg.id}
              n={i + 1}
              leg={leg}
              now={standing}
              phase={phase?.legId === leg.id ? phase.phase : null}
              units={units}
              multipliers={
                terms?.kind === 'withdraw'
                  ? Object.fromEntries(terms.items.map((i) => [i.asset, i.multiplier]))
                  : undefined
              }
              explorer={explorerNameFor(chain, t.chain)}
              mock={onMock(port, chain)}
              money={(value) => dollars(value, lang)}
              t={t}
              locale={LOCALE[lang]}
            />
          );
        })}
      </ol>
    </>
  );

  // Where the step stands, what the last answer said and what is kept: said in the step's own panel.
  const saysSomething =
    (running && (phase !== null || stopping)) || (!running && done) || over || view !== null;
  const statusBlock = saysSomething && (
    <div data-ui="order-status" className="flex flex-col gap-2">
      {running && phase && (
        // Where the step under way is: the strip and the panel say which step it is.
        <p data-ui="sign-phase" className="text-body-sm text-muted-foreground">
          {t.order.phase[phase.phase as keyof Dictionary['order']['phase']]}
        </p>
      )}
      {running && stopping && (
        <p data-ui="invest-stopping" className="text-body-sm">
          {t.invest.stopping}
        </p>
      )}
      {!running && done && !view && <p className="text-body">{doneSentence}</p>}
      {over && (
        <p data-ui="order-deposit-kept" className="max-w-(--tf-measure-body) text-body">
          {t.order.outcome.stopped(amount)}
        </p>
      )}
      {view && (
        <div className="flex max-w-(--tf-measure-body) flex-col gap-1">
          <p
            className={
              view.alarm ? 'flex items-start gap-1.5 text-body text-destructive' : 'text-body'
            }
          >
            {view.alarm && <StatusMark status="off-track" size={12} className="mt-1.5" />}
            {/* An order with a skipped step, or a token left behind, is never said to be plainly done. */}
            <span data-ui={done ? 'order-done' : undefined}>
              {done && !plainlyDone ? doneSentence : view.sentence}
            </span>
          </p>
          {embed && !done && record.approved && buying && (
            // What landed and what did not, in one sentence, from where the API says each step is.
            <p data-ui="invest-landed" className="text-body">
              {landedSentence(shown, now, units, t, LOCALE[lang])}
            </p>
          )}
          {!done && deposited && view.next.kind === 'new-order' && (
            <p data-ui="order-deposit-kept" className="text-body">
              {stranded ? t.order.outcome.stopped(amount) : t.order.outcome.depositKept}
            </p>
          )}
          {/* The check that failed and the guard's own words are for the team: behind a fold. */}
          {(view.check || view.detail) && (
            <details data-ui="order-support">
              <summary className="cursor-pointer text-body-sm text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                {t.order.outcome.forSupport}
              </summary>
              {view.check && (
                <p className="mt-1 font-mono text-source text-muted-foreground">{view.check}</p>
              )}
              {view.detail && (
                <p className="font-mono text-source text-muted-foreground break-words">
                  {view.detail}
                </p>
              )}
            </details>
          )}
        </div>
      )}
    </div>
  );
  // The way on from wherever the order stands: one primary button, the stops and the ends.
  const actions = (
    <div className="flex flex-col items-start gap-2 empty:hidden">
      {!check.ok && (
        <p
          role="alert"
          className="flex max-w-(--tf-measure-body) items-start gap-1.5 text-body text-destructive"
        >
          <StatusMark status="off-track" size={12} className="mt-1.5" />
          <span>
            {check.why === 'units' && !chainReady(chain, onMock(port, chain))
              ? t.order.outcome.notRunnable['no-deployment'](t.chain.names[chain])
              : t.order.mismatch[check.why]}
          </span>
        </p>
      )}
      {soldBefore && (
        // In dollars, stopped after some sales landed: their dollars are in the vault now, and the
        // same share asked again would sell those holdings a second time.
        <div data-ui="withdraw-sold-before" className="flex flex-col items-start gap-3">
          <p className="max-w-(--tf-measure-body) text-body">
            {t.order.shared.soldBefore(soldBefore.names, soldBefore.least)}
          </p>
          <p className="max-w-(--tf-measure-body) text-body-sm">{t.order.shared.notAgain}</p>
          <Link href={newOrder} className={buttonClass({ variant: 'secondary' })}>
            {t.order.shared.tokensInstead}
          </Link>
        </div>
      )}
      {done && terms?.kind === 'withdraw' && (
        // The portfolio reads the vault again from its chain: what stayed, or that it is empty.
        <div data-ui="withdraw-done" className="flex flex-col items-start gap-3">
          {skippedSteps < now.legs.length && (
            <p className="max-w-(--tf-measure-body) text-body">{t.order.shared.withdrawDone}</p>
          )}
          {stayedNames.length > 0 && (
            <p data-ui="withdraw-stayed" className="max-w-(--tf-measure-body) text-body">
              {t.order.shared.stayed(
                new Intl.ListFormat(LOCALE[lang], { type: 'conjunction' }).format(stayedNames),
              )}
            </p>
          )}
          {/* in dollars with a holding left unsold: the tokens themselves, for that part */}
          {terms.dollars && shown.warnings.some((x) => x.code.startsWith('NOT_SOLD:')) && (
            <Link
              data-ui="withdraw-tokens-instead"
              href={newOrder}
              className={buttonClass({ variant: 'secondary' })}
            >
              {t.order.shared.tokensInstead}
            </Link>
          )}
          {/* a host that holds this screen (the vault's own page) has its own way back */}
          {!embed?.hostEnds && (
            <Link href={portfolioHref} className={buttonClass({ variant: 'secondary' })}>
              {t.withdraw.back}
            </Link>
          )}
        </div>
      )}
      {done && terms?.kind === 'follow' && terms.follow !== null && !terms.autoFollow && (
        // Following set the vault's targets and traded nothing: the trades to them are the next press.
        <div data-ui="follow-done" className="flex flex-col items-start gap-3">
          <p className="max-w-(--tf-measure-body) text-body">{t.order.shared.followDone}</p>
          <Link
            href={rebalancePath(chain, terms.vault)}
            data-action="follow-rebalance"
            className={buttonClass({ variant: 'primary' })}
          >
            {t.order.shared.followRebalance}
          </Link>
        </div>
      )}
      {stage === 'review' && trustAsked && check.ok && !done && (
        <TrustNotice
          chain={chain}
          accepted={false}
          checked={trustTicked}
          onCheck={setTrustTicked}
          keeper={keeperTrades}
          fold={Boolean(embed)}
        />
      )}
      {/* An add held to our server's targets, which this app could not read from the chain: said on
            its own line over the button, where it cannot be missed. */}
      {check.ok && !done && terms?.kind === 'vault' && terms.source === 'api' && (
        <p
          data-ui="not-checked"
          className="flex max-w-(--tf-measure-body) items-start gap-1.5 text-body font-medium"
        >
          <StatusMark status="watch" size={12} className="mt-1.5" />
          <span>{t.shared.check.notChecked}.</span>
        </p>
      )}
      {check.ok &&
        !done &&
        !over &&
        next.kind !== 'none' &&
        next.kind !== 'new-order' &&
        next.kind !== 'other-order' && (
          <>
            {stage === 'review' && !onePress && (
              // The review's one button: on to the first step. Nothing is approved by it.
              <Button
                variant="primary"
                data-action="order-continue"
                className={embed ? 'w-full' : 'sm:min-w-64'}
                disabled={consentMissing || held.length > 0}
                aria-describedby={consentMissing || held.length > 0 ? reasonId : undefined}
                onClick={() => {
                  setOnward(true);
                  setFocusTo('step');
                }}
              >
                {flow.continue}
              </Button>
            )}
            {next.kind === 'first' && (stage !== 'review' || onePress) && (
              // Said once before the press: who is asked to sign, and how many times.
              <p
                data-ui="invest-signing"
                className="max-w-(--tf-measure-body) text-body-sm text-muted-foreground"
              >
                {quiet ? t.invest.signs.passkey(legs.length) : t.invest.signs.wallet(legs.length)}
              </p>
            )}
            {(stage !== 'review' || onePress) && (
              <Button
                variant="primary"
                className={embed ? 'w-full' : 'sm:min-w-64'}
                busy={running}
                busyLabel={t.order.signing(current, legs.length)}
                disabled={consentMissing || held.length > 0}
                aria-describedby={consentMissing || held.length > 0 ? reasonId : undefined}
                onClick={() => {
                  // The first press is the approval of what the card showed: the host keeps the
                  // acceptance of the notice with it, before anything is signed.
                  if (next.kind === 'first') {
                    // The notice is accepted by a press that starts: kept in `go`, as the run begins.
                    accepts.current = embed
                      ? embed.onStarted
                      : trustAsked && userId
                        ? () =>
                            acceptTrust(
                              userId,
                              TRUST_STATUS.textVersion,
                              keeperTrades,
                              chainIsLive(chain),
                            )
                        : null;
                  }
                  go(
                    next.kind === 'approve-again'
                      ? { legId: next.legId, signedTimes: next.signedTimes }
                      : undefined,
                    next.kind === 'first',
                  );
                }}
              >
                {wholeOrder ? wholePress : primaryLabel}
              </Button>
            )}
            {embed && running && (
              // Between steps only: a step that is signed is still sent and reported.
              <Button
                variant="secondary"
                disabled={stopping}
                onClick={() => {
                  stop.current.aborted = true;
                  setStopping(true);
                }}
              >
                {t.invest.stop}
              </Button>
            )}
            {stage === 'steps' &&
              !record.approved &&
              !running &&
              !view &&
              !onePress &&
              !embed?.reviewed && (
                // Before the first signature, the review is one press back.
                <Button
                  variant="link"
                  data-action="order-back"
                  onClick={() => {
                    setOnward(false);
                    setFocusTo('review');
                  }}
                >
                  {flow.back}
                </Button>
              )}
          </>
        )}
      {held.length > 0 && !consentMissing && (
        <ul id={reasonId} className="flex max-w-(--tf-measure-body) flex-col gap-1 text-body-sm">
          {held.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
      {consentMissing && (
        <p id={reasonId} className="text-body-sm">
          {t.order.review.consentNeeded}
        </p>
      )}
      {(next.kind === 'new-order' || over) && (
        // With the deposit in the vault, that is where to look first, not at a second deposit.
        <div data-ui="order-stopped" className="flex flex-wrap items-center gap-3">
          {offerFinish && (
            <>
              <Button
                variant="primary"
                busy={finishing}
                busyLabel={t.order.outcome.finishing}
                onClick={() =>
                  finish(
                    record,
                    record.approved?.order ?? now,
                    left,
                    // still not seen here, if it was not and nobody approved it on this device
                    !record.approved && record.continues?.unseen === true,
                  )
                }
              >
                {t.order.outcome.finish}
              </Button>
              <Link href={portfolioHref} className={buttonClass({ variant: 'secondary' })}>
                {t.order.outcome.seePortfolio}
              </Link>
            </>
          )}
          {deposited && !offerFinish && (
            <Link href={portfolioHref} className={buttonClass({ variant: 'primary' })}>
              {t.order.outcome.seePortfolio}
            </Link>
          )}
          {embed ? (
            // In the card: a new order is made in place, for the same amount.
            <Button variant={deposited ? 'secondary' : 'primary'} onClick={embed.onAgain}>
              {t.order.outcome.newOrder}
            </Button>
          ) : (
            <Link
              href={newOrder}
              className={buttonClass({ variant: deposited ? 'secondary' : 'primary' })}
            >
              {t.order.outcome.newOrder}
            </Link>
          )}
        </div>
      )}
      {keeperBuys && (
        <p data-ui="order-keeper-buys" className="max-w-(--tf-measure-body) text-body-sm">
          {t.order.outcome.keeperBuys}
        </p>
      )}
      {offerFinish && (
        <p data-ui="order-finish-note" className="max-w-(--tf-measure-body) text-body-sm">
          {t.order.outcome.finishNote}
        </p>
      )}
      {finishFailure && (
        <p
          role="alert"
          className="flex max-w-(--tf-measure-body) items-start gap-1.5 text-body-sm text-destructive"
        >
          <StatusMark status="off-track" size={12} className="mt-1.5" />
          <span>
            {finishFailure.text}
            {finishFailure.orderId &&
              (embed?.onFinish && recallOrder(finishFailure.orderId, userId) ? (
                <>
                  {' '}
                  <Button
                    variant="link"
                    data-ui="order-finish-other"
                    onClick={() => embed.onFinish?.(finishFailure.orderId as string)}
                  >
                    {t.order.outcome.openThatOrder}
                  </Button>
                </>
              ) : (
                <>
                  {' '}
                  <Link
                    href={`/portfolio/orders/${encodeURIComponent(finishFailure.orderId)}`}
                    data-ui="order-finish-other"
                    className={buttonClass({ variant: 'link' })}
                  >
                    {t.order.outcome.openThatOrder}
                  </Link>
                </>
              ))}
          </span>
        </p>
      )}
      {/* The order is done: the next step is the portfolio it filled, and another buy beside it. */}
      {done && !running && terms?.kind !== 'publish' && !embed?.hostEnds && (
        <div data-ui="order-next" className="flex flex-wrap items-center gap-3">
          {/* a deposit that opened or filled a vault leads to it first (audit F3) */}
          {embed?.endsAt && (
            <Link
              href={embed.endsAt.href}
              data-action="open-vault"
              className={buttonClass({ variant: 'primary' })}
            >
              {embed.endsAt.label}
            </Link>
          )}
          <Link
            href={portfolioHref}
            className={buttonClass({ variant: embed?.endsAt ? 'secondary' : 'primary' })}
          >
            {t.order.outcome.seePortfolio}
          </Link>
          {buying && !embed && (
            <Link href={newOrder} className={buttonClass({ variant: 'secondary' })}>
              {t.order.outcome.buyMore}
            </Link>
          )}
        </div>
      )}
      {next.kind === 'other-order' && (
        <Link
          href={`/portfolio/orders/${encodeURIComponent(next.orderId)}`}
          className={buttonClass({ variant: 'primary' })}
        >
          {t.order.outcome.blockedLink}
        </Link>
      )}
    </div>
  );
  // Every step as it will be signed, to the last unit, with where each stands: one fold away on
  // each screen.
  const allSteps = (label: string) => (
    <Fold ui="order-details" label={label}>
      {/* Inside the invest card the host shows what the buy is held to, over the card. */}
      {terms && !onePress && stage === 'review' && <SharedReview terms={terms} chain={chain} />}
      {stepsBody}
      {embed && (
        <p data-ui="invest-fee" className="text-body-sm text-muted-foreground">
          {shown.fees.length === 0
            ? t.invest.fee.none
            : t.invest.fee.some(
                new Intl.ListFormat(LOCALE[lang], { type: 'conjunction' }).format(
                  shown.fees.map((fee) => `${fee.kind} ${formatBps(fee.bps, LOCALE[lang])}`),
                ),
              )}
        </p>
      )}
    </Fold>
  );
  const strip = (
    <StepStrip
      names={[...words.map((w) => w.name), flow.done]}
      at={stage === 'done' ? legs.length : at}
      label={flow.progress}
      doneWord={flow.doneWord}
      skipped={skippedAt}
      skippedWord={t.order.status.skipped.toLowerCase()}
    />
  );
  const sharesOf = (caption: string, items: ReturnType<typeof shareItems>) => (
    <ShareList
      caption={caption}
      items={items}
      share={shareOf}
      labels={{
        ...shareLabels,
        holding: flow.table.holding,
        change: flow.table.change,
        points: pointsOf,
      }}
    />
  );
  // What a screen reader is told as the order moves, from one region that stays on the screen in
  // every stage: the step under way and its phase, the last answer, the end.
  const phaseWord =
    running && phase ? t.order.phase[phase.phase as keyof Dictionary['order']['phase']] : null;
  const announce = phaseWord
    ? `${flow.stepOf(at + 1, legs.length)}: ${phaseWord}`
    : view
      ? done && !plainlyDone
        ? doneSentence
        : view.sentence
      : done && !running
        ? doneSentence
        : '';

  // The figures beside the line a screen leads with (HOUSE-KIT): said once, in a pill, where they
  // are not live. The invest card says it on its own card.
  const provenance = shown.legs[0]?.provenance;
  const plate = onePress
    ? null
    : provenance === 'sandbox'
      ? { text: t.shell.testNetworkLine, ui: 'sample-tag' }
      : provenance === 'mock'
        ? { text: t.shell.mockAnnounce, ui: 'sample-tag' }
        : null;
  // The review's line: a muted label over one figure, then the small figures of what it trades.
  const heroLabel =
    terms?.kind === 'retarget'
      ? flow.label.change
      : terms?.kind === 'rebalance'
        ? flow.label.rebalance
        : terms?.kind === 'withdraw'
          ? terms.dollars && leastFigure
            ? flow.label.withdrawAtLeast
            : flow.label.withdraw
          : terms?.kind === 'publish' || terms?.kind === 'follow'
            ? flow.label.order
            : record.continues
              ? flow.hero.finish
              : flow.label.deposit;
  const heroFigure =
    terms?.kind === 'withdraw'
      ? terms.dollars && leastFigure
        ? leastFigure.shown
        : // said on its own line: "All of your SPY", never mid-sentence lower case
          withdrawn.charAt(0).toLocaleUpperCase(locale) + withdrawn.slice(1)
      : buying && !record.continues && shown.depositRaw !== undefined
        ? amount
        : reviewHero;
  const costs = orderCosts(shown, summary);
  const reviewStats = [
    ...(costs
      ? [
          {
            label: flow.stat.swapped,
            value: <Rounded figure={costs.swapped} />,
            ui: 'stat-swapped',
          },
          ...(costs.expected
            ? [{ label: flow.stat.expected, value: costs.expected.shown, ui: 'stat-expected' }]
            : []),
          ...(costs.worst
            ? [{ label: flow.stat.worst, value: costs.worst.shown, ui: 'stat-worst' }]
            : []),
        ]
      : []),
    { label: flow.stat.steps, value: String(legs.length), ui: 'stat-steps' },
  ];
  const stepStats = [
    ...(words[at]?.least
      ? [{ label: flow.stat.least, value: words[at]?.least, ui: 'stat-least' }]
      : []),
    ...(words[at]?.under
      ? [{ label: flow.stat.under, value: words[at]?.under, ui: 'stat-under' }]
      : []),
  ];
  const tableWords = {
    holding: flow.table.holding,
    change: flow.table.change,
    amount: flow.table.amount,
  };

  // The order's costs in one line, for a host that shows the amount and each holding's dollars.
  const costsLine = (
    // The host shows the amount and each holding's dollars (gate DEPOSIT-ONE-SCREEN): the
    // order's costs, in one line, over the press.
    <p data-ui="order-costs" className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-body-sm">
      {reviewStats
        .filter((stat) => stat.ui !== 'stat-swapped')
        .map((stat, i) => (
          <span key={stat.ui} data-ui={stat.ui} className="whitespace-nowrap">
            {i > 0 && (
              <span aria-hidden="true" className="mr-2 text-muted-foreground">
                ·
              </span>
            )}
            <span className="text-muted-foreground">{stat.label}</span>{' '}
            <span className="font-medium tabular-nums">{stat.value}</span>
          </span>
        ))}
    </p>
  );

  const stageBody =
    stage === 'review' ? (
      <>
        {embed?.compact ? (
          embed.foot ? null : (
            costsLine
          )
        ) : (
          <>
            <OrderHero label={heroLabel} figure={heroFigure} plate={plate} />
            <OrderStats stats={reviewStats} />
          </>
        )}
        {shares && sharesOf(flow.picture.targets, shares)}
        {/* on the deposit card in a pane, where it goes in one line: the button stays in view (I3) */}
        {!embed?.compact && picture && picture.rows.length > 0 && (
          <AmountList picture={picture} labels={tableWords} compact={onePress} />
        )}
        {shown.warnings.length > 0 && (
          <ul
            aria-label={t.order.review.warnings}
            data-ui="order-warnings"
            className="flex max-w-(--tf-measure-body) flex-col gap-1 text-body-sm"
          >
            {shown.warnings.map((w) => (
              // Keyed by its text as well: nothing holds two warnings to different codes.
              <li key={`${w.code}:${w.text}`} className="flex items-start gap-1.5">
                <StatusMark status="watch" className="mt-1.5" />
                <span>{w.text}</span>
              </li>
            ))}
          </ul>
        )}
        {!record.approved && needed.length > 0 && (
          <fieldset className="flex flex-col gap-2">
            <legend className="pb-1 text-body-sm font-medium">{t.order.review.consents}</legend>
            {needed.map((kind) => (
              <label key={kind} className="inline-flex items-start gap-2 text-body-sm">
                <input
                  type="checkbox"
                  className="mt-1 size-4 accent-primary"
                  checked={consents.includes(kind)}
                  onChange={(e) => {
                    const on = e.currentTarget.checked;
                    setConsents((all) =>
                      on ? [...all.filter((k) => k !== kind), kind] : all.filter((k) => k !== kind),
                    );
                  }}
                />
                <span className="max-w-(--tf-measure-body)">{t.order.review.consent[kind]}</span>
              </label>
            ))}
          </fieldset>
        )}
        {/* a host that keeps its press in view draws it at its own foot, with the costs over it */}
        {embed?.foot
          ? createPortal(
              <>
                {embed.compact && costsLine}
                {actions}
              </>,
              embed.foot,
            )
          : actions}
        {allSteps(flow.details)}
      </>
    ) : stage === 'steps' ? (
      <>
        {strip}
        <SignedSteps
          steps={signed}
          label={flow.signed}
          explorer={explorerNameFor(chain, t.chain)}
          links={t.order.link}
        />
        <StepPanel
          place={flow.stepOf(at + 1, legs.length)}
          label={wholeOrder ? heroLabel : (words[at]?.name ?? t.order.title)}
          hero={wholeOrder ? heroFigure : (words[at]?.hero ?? t.order.title)}
          stats={wholeOrder ? reviewStats : stepStats}
          title={words[at]?.title ?? t.order.title}
          plate={plate}
          status={statusBlock}
        >
          {actions}
          {allSteps(flow.allSteps)}
        </StepPanel>
      </>
    ) : (
      <>
        {strip}
        {embed?.onEnded && <Ended plainly={plainlyDone} onEnded={embed.onEnded} />}
        {/* over "Done", the action the order was: "Change", "Withdrawal" */}
        <OrderHero
          label={
            terms?.kind === 'retarget'
              ? flow.doneLabel.change
              : terms?.kind === 'rebalance' || terms?.kind === 'withdraw'
                ? flow.doneLabel[terms.kind]
                : buying
                  ? flow.doneLabel.deposit
                  : flow.label.order
          }
          // "Done" only where it is plainly done: a step skipped, a token that stayed, or a vault
          // still being read again says the steps ended, as the pane's head does
          figure={plainlyDone ? flow.ended.title : t.shared.vault.page.ended}
          plate={plate}
        />
        {statusBlock}
        {(terms?.kind === 'retarget' || terms?.kind === 'rebalance') &&
          sharesOf(flow.ended.targets, shareItems(terms.targets, null, summary))}
        {actions}
        {allSteps(flow.transactions)}
      </>
    );

  return (
    <div
      ref={shell}
      data-ui="order-screen"
      data-stage={stage}
      className={embed ? 'flex flex-col gap-5' : 'flex flex-col gap-8'}
    >
      <p aria-live="polite" data-ui="order-announce" className="sr-only">
        {announce}
      </p>
      {!embed && (
        <header className="flex flex-col items-start gap-3">
          <ChainBadge chain={chain} />
          <h1 id={titleId} className={PAGE_TITLE}>
            {stage === 'review' ? t.order.review.title : t.order.title}
          </h1>
          {stage === 'review' && (
            <p
              data-ui={record.continues ? 'order-continues' : undefined}
              className="max-w-(--tf-measure-body) text-body-lg"
            >
              {record.continues ? t.order.review.continuesLead : t.order.review.lead}
            </p>
          )}
          {record.continues?.unseen && (
            <p data-ui="order-unseen" className="max-w-(--tf-measure-body) text-body-sm">
              {t.order.review.unseen}
            </p>
          )}
        </header>
      )}

      {embed ? (
        // Inside a host's card (the invest card, a vault's pane): the same screens, under its heading.
        <section
          aria-label={t.order.stepsTitle}
          data-ui="invest-steps"
          className="flex flex-col gap-6"
        >
          {stageBody}
        </section>
      ) : (
        <Panel data-ui="order-panel" aria-labelledby={`${titleId}-panel`}>
          <PanelHead id={`${titleId}-panel`} title={t.order.stepsTitle} />
          <PanelBody>{stageBody}</PanelBody>
        </Panel>
      )}
    </div>
  );
}

/** Tells the host how the order ended, once and again whenever that reading changes. */
function Ended({ plainly, onEnded }: { plainly: boolean; onEnded: (plainly: boolean) => void }) {
  useEffect(() => onEnded(plainly), [plainly, onEnded]);
  return null;
}

function Notice({
  title,
  body,
  href,
  label,
}: {
  title: string;
  body: string;
  href: string;
  label: string;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col items-start gap-4">
      <h1 id={id} className={PAGE_TITLE}>
        {title}
      </h1>
      <p className="max-w-(--tf-measure-body) text-body">{body}</p>
      <Link href={href} className={buttonClass({ variant: 'secondary' })}>
        {label}
      </Link>
    </section>
  );
}

/** One step: what it does as the review showed it, and where it stands now. */
function Step({
  n,
  leg,
  now,
  phase,
  units,
  multipliers,
  explorer,
  mock,
  money,
  t,
  locale,
}: {
  n: number;
  /** A dollar figure in the language of the page. */
  money: (value: number) => string;
  /** The explorer's name, for the link's accessible name. */
  explorer: string;
  /** The chain runs on the mock: its transactions are no network's, and link to the mock's own address. */
  mock: boolean;
  /** As the review showed it: what it may do. */
  leg: Leg;
  /** As the API last said: where it stands. */
  now: Leg;
  phase: string | null;
  /** What each token's raw amount means, from what this repository committed. */
  units: ChainUnits | null;
  /** For a withdrawal: each token's multiplier at the review, which its amounts are shown with. */
  multipliers?: Record<string, string>;
  t: Dictionary;
  locale: string;
}) {
  /** A raw amount of a token in whole units with its symbol, or null when its units are not known. */
  const whole = (raw: string, asset: string, places?: number) => {
    const u = units?.tokens[asset];
    const figure = u ? formatRaw(raw, u.decimals, locale, places ?? Math.min(u.decimals, 6)) : null;
    return u && figure !== null ? `${figure} ${u.symbol}` : null;
  };
  const spend = (raw: string) => (units ? whole(raw, units.cash) : null) ?? raw;
  /** A withdrawal's raw amount as its review showed it: with the token's multiplier then. */
  const shown = (raw: string, asset: string) =>
    shownRaw(BigInt(raw), multipliers?.[asset] ?? '1').toString();
  /** A token by the symbol this repository committed for it, or its id on the chain where none is. */
  const symbol = (asset: string) => units?.tokens[asset]?.symbol ?? tokenName(asset);
  const status = phase
    ? t.order.phase[phase as keyof Dictionary['order']['phase']]
    : t.order.status[now.status];
  const failed = now.status === 'failed';
  // What a swap step receives, where every trade of it spends the chain's cash: its heading.
  const swapsInto =
    leg.kind === 'swap' &&
    units &&
    leg.trades.length > 0 &&
    leg.trades.every((trade) => trade.sell === units.cash)
      ? [...new Set(leg.trades.map((trade) => symbol(trade.buy)))]
      : null;
  return (
    <li data-ui="order-step" data-status={now.status} className="flex flex-col gap-1 py-3">
      <p className="flex flex-wrap items-baseline gap-x-2 text-body">
        <span className="font-medium">
          {t.order.step(n)} ·{' '}
          {leg.trades.length > 0 && leg.kind === 'create_vault'
            ? t.order.kind.create_vault_buy
            : leg.kind === 'create_vault' && !movesCash(leg)
              ? t.order.kind.open_vault
              : leg.trades.length > 0 && leg.kind === 'deposit'
                ? t.order.kind.deposit_buy
                : (stepCalls(leg, t.order.kind) ??
                  (swapsInto
                    ? // a step that spends cash on assets is headed by what it receives; its lines say the rest
                      new Intl.ListFormat(locale, { type: 'conjunction' }).format(swapsInto)
                    : t.order.kind[leg.kind]))}
        </span>
        {leg.cashRaw && <span className="tabular-nums">{spend(leg.cashRaw)}</span>}
        <span aria-hidden="true">·</span>
        <span className={failed ? 'inline-flex items-center gap-1.5 text-status-off' : undefined}>
          {failed && <StatusMark status="off-track" />}
          {status}
          {failed && ` ${t.order.notRetried}`}
        </span>
        {now.txId && (
          <span className="ml-auto inline-flex items-center gap-2">
            <ExplorerLink
              signature={now.txId}
              href={explorerUrlFor(leg.chain, now.txId, mock, mock ? undefined : leg.provenance)}
              explorer={explorer}
              labels={t.order.link}
            />
            <CopyButton value={now.txId} what={t.order.signature} />
          </span>
        )}
      </p>
      {now.status === 'skipped' && leg.withdrawals && (
        <p data-ui="order-skipped" className="max-w-(--tf-measure-body) text-body-sm">
          {t.order.shared.skipped(leg.withdrawals.map((w) => symbol(w.asset)).join(', '))}
        </p>
      )}
      {leg.withdrawals && (
        // What this step takes out, for the owner's own wallet: the amount, or all of the token.
        <ul className="flex flex-col gap-0.5 text-body-sm text-muted-foreground">
          {leg.withdrawals.map((w) => (
            <li key={w.asset} data-ui="order-withdrawal" className="tabular-nums">
              {w.leastRaw !== undefined
                ? // the cash of a withdrawal in dollars: the least it pays, whatever the sales bring
                  t.order.shared.withdrawsAtLeast(
                    whole(w.leastRaw, w.asset, 18) ?? `${w.leastRaw} ${tokenName(w.asset)}`,
                  )
                : w.amountRaw === null
                  ? t.order.shared.withdrawsAll(
                      whole(shown(w.heldRaw, w.asset), w.asset, 18) ??
                        `${w.heldRaw} ${tokenName(w.asset)}`,
                    )
                  : t.order.shared.withdraws(
                      whole(shown(w.amountRaw, w.asset), w.asset, 18) ??
                        `${w.amountRaw} ${tokenName(w.asset)}`,
                    )}
            </li>
          ))}
        </ul>
      )}
      {leg.trades.length === 0 ? null : (
        <ul className="flex flex-col gap-0.5 text-body-sm text-muted-foreground">
          {leg.trades.map((trade, i) => (
            <li key={`${trade.sell}>${trade.buy}:${trade.amountInRaw}`} className="tabular-nums">
              {/* Each side in its own token's units: a sale reads as a sale (trade-line.ts). */}
              {tradeLine({ trade, expected: leg.expected[i], units, t, locale, money })}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
