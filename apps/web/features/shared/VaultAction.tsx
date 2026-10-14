'use client';
import type { ChainId, VaultResponse } from '@colosseum/schemas';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Panel, PanelBody, PanelHead } from '../../components/ui/Panel';
import { useT } from '../../i18n/I18nProvider';
import type { AmountMode } from '../amount/AmountCard';
import { VaultMixFlow } from '../mix/VaultMixFlow';
import type { OrderEmbed } from '../order/invest-words';
import { OrderScreen } from '../order/OrderScreen';
import { latestOf, recallOrder, recallOrders } from '../order/order-record';
import { AddMoneyScreen } from '../portfolio/AddMoneyScreen';
import { sameAddress } from '../portfolio/vault-name';
import { RebalanceStart } from './RebalanceStart';
import type { SharedTerms } from './terms';
import { WithdrawScreen } from './WithdrawScreen';

// An action on the vault's own page, in its right pane (gate VAULT-PAGE-ACTIONS): a deposit, a
// withdrawal, or new weights, from the first choice to the last signed step, with no other page. Nothing
// that decides what is signed is here. The deposit is the card the add-money page mounts
// (AddMoneyScreen → InvestCard, gate INVEST-ONE-PRESS), with its test-network line or sample hatch, what
// the person is trusting, the wallet's check and the order as our server made it. The withdrawal is the
// withdrawal page's own choice and review (WithdrawScreen), and the weights the editor's own
// (VaultMixFlow); the order each makes is drawn by the order's own screen (OrderScreen), which checks it
// against what was reviewed, runs the guard on every step and never sends a reverted step again.
//
// The pane is laid out as the deposit on /goal is (features/mix/DepositSign.tsx): a heading that takes
// the focus, the amount as a fact once it is pressed, the end over the steps it sums up, and the way
// back whenever no step is being signed.

/**
 * What can take the pane. `apply` is a change proposed in the conversation, once its order is made;
 * `rebalance` trades the vault to the targets it has, and changes nothing else.
 */
export type ActionKind = 'deposit' | 'withdraw' | 'weights' | 'apply' | 'rebalance';
export type OpenAction = {
  kind: ActionKind;
  /** The order the action made, once there is one. */
  orderId: string | null;
  /** Approved before the page was opened again: taken up from the order's own record. */
  resumed?: boolean;
  /** Which opening of the pane this is: an answer for another opening is not this one's. */
  token?: number;
};
/** Where an open action stands: before the press, its steps being signed, stopped short, or done. */
export type ActionPhase = 'open' | 'signing' | 'stopped' | 'done';

const TERMS: Record<ActionKind, SharedTerms['kind']> = {
  deposit: 'vault',
  withdraw: 'withdraw',
  weights: 'retarget',
  apply: 'retarget',
  rebalance: 'rebalance',
};
/** The words of each action's pane: the weights, by hand or from the conversation, are one change. */
export const paneOf = (kind: ActionKind) =>
  kind === 'weights' || kind === 'apply' ? 'change' : kind;

/** A vault's targets above zero, as its read gives them: what a rebalance trades to. */
export const targetsOfVault = (vault: VaultResponse['vault']) =>
  vault.positions
    .filter((position) => position.targetBps > 0)
    .map((position) => ({ asset: position.asset, weightBps: position.targetBps }));

const keyOf = (userId: string, chain: ChainId, address: string) =>
  `tf-vault-action:1:${encodeURIComponent(userId)}:${chain}:${address}`;

/**
 * The action the person approved on this page before it was opened again: only one whose order this
 * browser kept for this person, approved, for this vault and of that kind. Anything else is dropped.
 */
export function recallAction(userId: string, chain: ChainId, address: string): OpenAction | null {
  const key = keyOf(userId, chain, address);
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const read = JSON.parse(raw) as Partial<OpenAction>;
    const record = typeof read.orderId === 'string' ? recallOrder(read.orderId, userId) : null;
    if (
      read.kind &&
      read.kind in TERMS &&
      record?.approved &&
      record.chain === chain &&
      record.terms?.kind === TERMS[read.kind] &&
      'vault' in record.terms &&
      sameAddress(chain, record.terms.vault, address)
    )
      return { kind: read.kind, orderId: record.orderId, resumed: true };
    localStorage.removeItem(key);
  } catch {
    // storage blocked or unreadable: nothing is taken up
  }
  return null;
}

/** Keeps the approved action's ids beside the vault, so a reload finds its order again; null forgets. */
export function keepAction(
  userId: string,
  chain: ChainId,
  address: string,
  open: OpenAction | null,
) {
  try {
    if (open?.orderId)
      localStorage.setItem(
        keyOf(userId, chain, address),
        JSON.stringify({ kind: open.kind, orderId: open.orderId }),
      );
    else localStorage.removeItem(keyOf(userId, chain, address));
  } catch {
    // storage full or blocked: the action is still on the pane for this visit
  }
}

export function VaultAction({
  read,
  userId,
  open,
  phase,
  onOrder,
  onPhase,
  onRestart,
  onLeave,
  onFinished,
  onMode,
}: {
  read: VaultResponse;
  userId: string;
  open: OpenAction;
  phase: ActionPhase;
  /** The action made its order, or the person approved one: kept from the press on. */
  onOrder: (orderId: string, approved: boolean) => void;
  onPhase: (phase: ActionPhase) => void;
  /** Back to the action's first choice, for another order. */
  onRestart: () => void;
  /** Back to the holdings, leaving what stopped where it is. */
  onLeave: () => void;
  /** Done, and the person goes back to the vault: it is read again. */
  onFinished: () => void;
  /** Deposit | Withdraw on the amount card: the other action takes the pane. Left out: no switch. */
  onMode?: (mode: AmountMode) => void;
}) {
  const t = useT();
  const p = t.shared.vault.page;
  const words = p.panes[paneOf(open.kind)];
  const titleId = useId();
  const { chain, vault } = read;
  // A deposit's amount was pressed on its card: from then on the pane's own heading is back.
  const [entered, setEntered] = useState(false);
  // The pane took the holdings' place: its heading takes the focus, so it is read from the top. Where
  // the amount card is the pane's first thing, the card is the heading and its amount takes the focus.
  useEffect(() => {
    const title = document.getElementById(titleId);
    title?.setAttribute('tabindex', '-1');
    title?.focus();
  }, [titleId]);

  const record = open.orderId ? recallOrder(open.orderId, userId) : null;
  const pressed = phase !== 'open';
  // A deposit taken up again is for the amount its order was made for; any other is typed on the card.
  const amount = open.kind === 'deposit' && open.resumed ? (record?.amountUsd ?? null) : null;

  // What the order's own screen tells this pane, whoever holds it.
  // An order that finishes a deposit that stopped took the card: it deposits nothing, so the amount
  // typed for the first one is not said of it, now or after a reload.
  const [followed, setFollowed] = useState(false);
  // Which screen of the order is on the pane: its review, its steps, or its end (SIGN-ONE-STEP).
  const [orderStage, setOrderStage] = useState<'review' | 'steps' | 'done' | null>(null);
  // The order ended plainly: every step confirmed, nothing left behind. Only then is "done" said over it.
  const [plainly, setPlainly] = useState(false);
  const finishes =
    followed || (record ? latestOf(record, recallOrders(userId)).continues !== undefined : false);
  const told = {
    onProgress: (progress: { orderId: string }) => {
      onOrder(progress.orderId, true);
      onPhase('signing');
    },
    // not approved yet: the pane is the person's again until they press
    onFollowUp: () => {
      setFollowed(true);
      onPhase('open');
    },
    onDone: () => onPhase('done'),
    onStopped: () => onPhase('stopped'),
    onEnded: setPlainly,
  };

  const backToVault = (
    <div data-ui="vault-action-done" className="flex flex-col gap-3">
      <Button variant="primary" className="w-full" data-action="back-to-vault" onClick={onFinished}>
        {p.backToVault}
      </Button>
    </div>
  );
  // The way back, whenever no step is being signed; what was sent stays sent. Before the first
  // signature the steps have "Back to the review" of their own: one way back.
  const wayBack = phase !== 'signing' &&
    phase !== 'done' &&
    !(
      phase === 'open' &&
      orderStage === 'steps' &&
      !open.resumed &&
      paneOf(open.kind) !== 'change'
    ) && (
      <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-body-sm">
        {phase === 'stopped' && <span className="text-muted-foreground">{words.stopped}</span>}
        <Button variant="link" data-action="leave-action" onClick={onLeave}>
          {p.backToHoldings}
        </Button>
      </p>
    );
  // The pane's title, and the one line under it where one is said.
  const titleText =
    phase === 'done'
      ? plainly
        ? p.doneTitle[paneOf(open.kind)]
        : p.ended
      : finishes
        ? p.finish.title
        : open.orderId || pressed
          ? words.signTitle
          : words.title;
  const lead =
    // the amount card says what a deposit and a withdrawal do: no line over it (gate AMOUNT-CARD),
    // only one that says the pane was taken up again or finishes another
    phase !== 'done' &&
    (finishes ||
      open.resumed ||
      (!open.orderId && !(open.kind === 'deposit' || open.kind === 'withdraw')))
      ? // an order that finishes a deposit adds no money: never said as a deposit of the amount
        finishes
        ? p.finish.lead
        : open.resumed
          ? words.resumed
          : words.lead
      : null;
  let body: ReactNode;
  if (open.kind === 'deposit')
    body = (
      // The amount card (gate AMOUNT-CARD) in the pane: its press hands the amount to the invest
      // card, which the card's line then sits over.
      <AddMoneyScreen
        chain={chain}
        address={vault.address}
        embedded={{
          amount,
          hostEnds: true,
          // the page's own holdings are what this deposit goes into: not drawn a second time
          bare: true,
          entry: {
            ...(onMode ? { onMode } : {}),
            // A deposit taken up again is for the amount its order was made for.
            pressed: open.resumed ? amount : null,
            // An order that finishes a deposit deposits nothing: the amount is not said of it.
            fact: !finishes,
            title: words.title,
            onPressed: (at) => setEntered(at !== null),
          },
          ...(open.resumed && open.orderId ? { resumeOrder: open.orderId } : {}),
          ...told,
        }}
      />
    );
  else if (!open.orderId)
    body =
      open.kind === 'withdraw' ? (
        <WithdrawScreen
          chain={chain}
          address={vault.address}
          embedded={{
            onOrder: (orderId) => onOrder(orderId, false),
            title: words.title,
            ...(onMode ? { onMode } : {}),
          }}
        />
      ) : open.kind === 'rebalance' ? (
        <RebalanceStart
          chain={chain}
          vault={vault}
          targets={targetsOfVault(vault)}
          onOrder={(orderId) => onOrder(orderId, false)}
        />
      ) : (
        <VaultMixFlow
          chain={chain}
          vault={vault}
          seed={vault.positions
            .filter((position) => position.targetBps > 0)
            .map((position) => ({ assetId: position.asset, weightBps: position.targetBps }))}
          from="person"
          provenance={read.provenance}
          onClose={onLeave}
          onOrder={(orderId) => onOrder(orderId, false)}
        />
      );
  else {
    const embed: OrderEmbed = {
      blocked: [],
      onApprove: () => {
        if (open.orderId) onOrder(open.orderId, true);
        onPhase('signing');
      },
      onStarted: () => {},
      onAgain: onRestart,
      hostEnds: true,
      onStage: setOrderStage,
      // a change was reviewed before its order was made (ChangeReview): its steps come next
      ...(paneOf(open.kind) === 'change' && !open.resumed ? { reviewed: true } : {}),
      // what the vault aims at, or holds, as this page read it: the review sets the order's targets
      // beside it (gate SIGN-ONE-STEP)
      ...(paneOf(open.kind) === 'change'
        ? { before: targetsOfVault(vault) }
        : open.kind === 'rebalance'
          ? {
              before: vault.positions.map((position) => ({
                asset: position.asset,
                weightBps: position.weightBps,
              })),
            }
          : {}),
      ...told,
    };
    body = (
      <>
        {/* the order's screen says what changes, then each step on its own (gate SIGN-ONE-STEP); what
            the order is held to, as its review showed it, is in its details */}
        {/* the house kit's panel (HOUSE-KIT): the pane's title its head, the order's screens in it;
            whether the figures are live is the order's own pill */}
        <Panel data-ui="pane-panel" aria-labelledby={titleId}>
          <PanelHead id={titleId} title={<span data-ui="pane-title">{titleText}</span>} />
          <PanelBody>
            {lead && (
              <p className="max-w-(--tf-measure-body) text-body-sm text-muted-foreground">{lead}</p>
            )}
            <OrderScreen key={open.orderId} id={open.orderId} embed={embed} />
            {phase === 'done' && backToVault}
            {wayBack}
          </PanelBody>
        </Panel>
      </>
    );
  }

  const done = phase === 'done';
  // Done, the one way on: inside the order's card, or under the deposit's card, which is not this pane's.
  const doneInCard = open.kind !== 'deposit' && open.orderId !== null;
  // The amount card heads the pane while it is shown (gate AMOUNT-CARD, one rule for both actions).
  const cardHeads =
    phase === 'open' &&
    !finishes &&
    !open.resumed &&
    ((open.kind === 'deposit' && !entered) || (open.kind === 'withdraw' && !open.orderId));
  return (
    <section
      data-ui="vault-action-pane"
      data-kind={open.kind}
      data-state={phase}
      // named by the amount card's title while the card heads the pane, by the pane's own after
      {...(cardHeads ? { 'aria-label': words.title } : { 'aria-labelledby': titleId })}
      className="flex min-w-0 flex-col gap-4"
    >
      {!doneInCard && !cardHeads && (
        <header className="flex min-w-0 flex-col gap-2">
          <h2
            id={titleId}
            tabIndex={-1}
            data-ui="pane-title"
            className="font-display text-h4 font-semibold outline-none"
          >
            {titleText}
          </h2>
          {lead && (
            <p className="max-w-(--tf-measure-body) text-body-sm text-muted-foreground">{lead}</p>
          )}
        </header>
      )}
      {body}
      {/* The end, under what the order did (gate SIGN-ONE-STEP: a short screen, not a long card). How
          it ended is the order's own sentence, above, which never says plainly done of a step that
          was skipped or a token that stayed (OrderScreen): nothing here says more than it does. */}
      {done && !doneInCard && backToVault}
      {/* the way back, under the order's own button where its panel is on the pane */}
      {!doneInCard && wayBack}
    </section>
  );
}
