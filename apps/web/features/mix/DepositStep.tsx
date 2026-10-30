'use client';
import {
  type ChainId,
  chainFamily,
  type MixLine,
  type MixReview,
  type OrderDetail,
  type Provenance,
} from '@colosseum/schemas';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { StatusMark } from '../../components/ui/StatusMark';
import { LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { AmountWell } from '../amount/AmountWell';
import { maxText, shownBalance } from '../amount/amount-check';
import { useWalletBalance } from '../amount/use-balance';
import { dollars, parseNumber } from '../goal/sheet';
import { MAX_USD, MIN_USD } from '../order/limits';
import { displayName } from '../order/plain';
import { rememberPlan } from '../order/plan-store';
import { onMock } from '../order/readiness';
import { TestFundsTop } from '../order/TestFundsTop';
import { unitsFor } from '../order/units';
import { useApiFetch, useWalletPort } from '../wallet/WalletProvider';
import { DepositFacts, DepositSummary } from './DepositFacts';
import { type DepositHost, DepositSign } from './DepositSign';
import { type QuotePrice, quotePrices } from './deposit-facts';
import { useFailureText } from './failure';
import { MixLines, type MixRow } from './MixLines';
import { MixReviewAck, useTicks } from './MixReviewCard';
import { acceptedOf, cashLeft, mixOf, sameMix, unticked } from './mix';
import { acceptGoalMix } from './mix-api';
import { linesOf, WeightEditor, type Weights, weightsOf } from './WeightEditor';

// The deposit of a new goal, on one screen (gate DEPOSIT-ONE-SCREEN, Thom, Oct 28, amending
// DEPOSIT-STEP and DEPOSIT-IN-PLACE): after the conversation proposes a vault, one card takes the
// amount, shows what goes into each holding with the facts that matter for it (the price the vault
// buys at beside the reference feed's, the exit as Analytics measured it), the costs of the order in
// one line, the trust notice the first time, and one press that signs every step. Then the same card
// shows the progress and the end. Nobody leaves the conversation to deposit, and there is no second
// or third screen of the same table.
//
// Fewer screens, not fewer checks. What the amount becomes in each asset is our server's own check of
// this mix at this amount (`confirm: false`), never worked out here. Once it is in and every warning
// is confirmed (one box for all of them), the server checks every line again at today's prices and
// stores the plan (`confirm: true` with the review's hash; a review whose figures moved comes back
// instead, and its warnings are confirmed again). The order is then made for that plan by the invest
// card (InvestCard, gate INVEST-ONE-PRESS) inside this one: the wallet's check, the notice, the order
// check, the guard on every step's bytes, the minimums pinned in the approved order are all its own,
// unchanged. A plan is stored by itself for a few amounts only; after that the person asks.
//
// There is no form: the mix is the conversation's and is changed there, the amount starts from the
// sum the person wrote there, and the goal and the risk the person said there are sent with the check
// (one they did not say is worked out by the server, gate DEPOSIT-DERIVE) but never shown as a label:
// the card says measured facts of the vault at this amount instead (Thom, Oct 28).
// Editing a weight by hand is behind its own control, closed until asked for, and a mix edited that
// way is marked and is the one checked.

export type Goal = 'grow' | 'income' | 'protect';
export type Risk = 'low' | 'medium' | 'high';
/** What the person said in the conversation, as the server served it. Null: not said. */
export type Purpose = { goal: Goal | null; risk: Risk | null };

/** How long the amount has to be still before the server is asked what it becomes in each asset. */
export const CHECK_MS = 500;
/**
 * How many plans the step stores by itself, one for each amount or review the person settles on.
 * Each is followed by an order, whose quotes count in the API's `build` budget the run itself needs
 * (INVEST-ONE-PRESS): after these, the person asks for today's prices again.
 */
export const AUTO_STORES = 4;

type Checked =
  | { key: string; review: MixReview }
  | { key: string; failure: string; invalid: boolean };

/** A plan our server stored for one check of this mix at this amount: `key` is the check and its hash. */
type Stored = { key: string; planId: string; amountUsd: number };

export function DepositStep({
  chain,
  userId,
  allocations,
  said,
  amountText,
  onAmountText,
  provenance,
  onChangeMix,
  onClose,
  waiting = false,
  host,
}: {
  chain: ChainId;
  userId: string;
  allocations: readonly (MixLine & { symbol?: string })[];
  /**
   * The goal and risk the person said in the conversation. Null is sent as not said, and the server
   * works it out from the mix (DEPOSIT-DERIVE); this screen never fills one in.
   */
  said: Purpose;
  /** The amount as typed, kept by the host so another proposal does not empty it. */
  amountText: string;
  onAmountText: (text: string) => void;
  /** What the chain's figures are, for the card's sample mark. */
  provenance: Provenance | null;
  /** Back to the conversation's box, with this proposal kept: weights are changed by saying so. */
  onChangeMix: () => void;
  /** Back to the proposal as the conversation showed it. */
  onClose: () => void;
  /** The conversation is working on a reply: the mix may be about to change, so nothing is stored. */
  waiting?: boolean;
  /** Told as the deposit is approved, signed and done, so the conversation holds its box. */
  host: DepositHost;
}) {
  const t = useT();
  const lang = useLang();
  const d = t.mix.deposit;
  const api = useApiFetch();
  const port = useWalletPort();
  const failureText = useFailureText();
  const titleId = useId();
  const editorId = useId();
  const reasonId = useId();
  const [weights, setWeights] = useState<Weights | null>(null);
  const [editing, setEditing] = useState(false);
  const [checked, setChecked] = useState<Checked | null>(null);
  // Asked again by hand after a check that did not get through.
  const [round, setRound] = useState(0);
  // The plan our server stored for the check on the screen, and the one a press approved: from the
  // press on, the card is that deposit's, whatever is typed or answered after.
  const [stored, setStored] = useState<Stored | null>(null);
  const [pinned, setPinned] = useState<Stored | null>(null);
  const [storing, setStoring] = useState<string | null>(null);
  const [storeFailure, setStoreFailure] = useState<{ key: string; text: string } | null>(null);
  // The review our server answered to a store, in place of a plan: its figures moved.
  const [moved, setMoved] = useState<string | null>(null);
  // The check the person asked to store by hand, past the ones stored by themselves.
  const [asked, setAsked] = useState<string | null>(null);
  const stores = useRef(0);
  const storingFor = useRef<string | null>(null);
  // The quotes of the order on the card, for the plan they are of.
  const [quotes, setQuotes] = useState<{
    planId: string;
    prices: Map<string, QuotePrice>;
  } | null>(null);
  // The plan an order is being made for now, as the invest card says.
  const [placingFor, setPlacingFor] = useState<string | null>(null);
  // The reader's clock, for the age of a measurement, read again once a minute.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  // The amount has been still for a moment, or the field was left: only then is it said to be wrong.
  const [settled, setSettled] = useState(false);
  const [tried, setTried] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  // The card's foot, where the press and the order's costs are drawn (sticky where the pane scrolls).
  const [foot, setFoot] = useState<HTMLDivElement | null>(null);
  // The step opens with the one thing to type. An amount filled in from the conversation is
  // selected, so what the person types replaces it.
  useEffect(() => {
    const input = root.current?.querySelector<HTMLInputElement>('[data-ui="amount-well"] input');
    input?.focus();
    input?.select();
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a pause after each change of the text
  useEffect(() => {
    setSettled(false);
    const timer = setTimeout(() => setSettled(true), CHECK_MS);
    return () => clearTimeout(timer);
  }, [amountText]);

  // Read as the buy screen reads an amount: in Portuguese "100,50" is a hundred dollars and fifty cents.
  const typed = parseNumber(amountText, lang);
  const amount = typed !== null && typed >= MIN_USD && typed <= MAX_USD ? typed : null;
  const amountError =
    (!amountText.trim() || !settled) && !tried
      ? undefined
      : typed === null || Number.isNaN(typed)
        ? d.errors.notAmount
        : typed < MIN_USD
          ? d.errors.belowMin
          : typed > MAX_USD
            ? d.errors.aboveMax
            : undefined;

  const mock = onMock(port, chain);
  const units = unitsFor(chain, mock);
  // The wallet's dollars on this chain, read once: what Max types and what the field says is there.
  const owner = port.active(chainFamily(chain))?.address ?? null;
  // Read again once test funds were asked for at the top of the card (gate FAUCET-TOP).
  const [funded, setFunded] = useState(0);
  const wallet = useWalletBalance(owner ? 'wallet' : null, owner, chain, mock, funded);
  // The last read, kept while the wallet is read again, so the faucet and what it said stay put.
  const [lastRead, setLastRead] = useState<Extract<typeof wallet, { kind: 'read' }> | null>(null);
  if (wallet.kind === 'read' && lastRead !== wallet) setLastRead(wallet);
  // The faucet at the top: a test network where our server sends test funds, before the press.
  const faucet = lastRead !== null && lastRead.provenance === 'sandbox' && lastRead.testFunds;
  const cash = units?.cash ?? null;
  const start = allocations
    .filter((line) => line.assetId !== cash)
    .map(({ assetId, weightBps }) => ({ assetId, weightBps }));
  const shown = weights ?? weightsOf(start);
  const lines = cash ? linesOf(shown, cash) : null;
  // Edited means the person changed a weight, whether or not the weights add up yet.
  const edited = weights !== null && !(lines !== null && sameMix(lines, start));
  const broken = weights !== null && lines === null;

  const body =
    amount !== null && lines && cash
      ? {
          version: 1 as const,
          origin: edited ? ('person' as const) : ('model' as const),
          language: lang,
          goal: said.goal,
          risk: said.risk,
          amountUsd: amount,
          allocations: mixOf(lines, cash),
        }
      : null;
  const key = body ? JSON.stringify(body) : null;
  const sending = useRef({ key, body, failureText });
  sending.current = { key, body, failureText };

  // What the amount becomes in each asset: asked of the server once the amount and the weights have
  // been still for a moment. Only the answer to what is on the screen now is shown.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for everything that is sent, `round` asks again
  useEffect(() => {
    if (key === null || pinned) return;
    const timer = setTimeout(async () => {
      const asking = sending.current.body;
      if (!asking) return;
      const answer = await acceptGoalMix(api, chain, {
        ...asking,
        confirm: false,
        acceptedWarnings: [],
      });
      // An answer about what is no longer on the screen is nobody's.
      if (sending.current.key !== key) return;
      setChecked((old) =>
        old?.key === key && 'review' in old
          ? old
          : answer.kind === 'ok'
            ? { key, review: answer.value.review }
            : {
                key,
                failure: sending.current.failureText(answer),
                invalid: answer.kind === 'invalid',
              },
      );
    }, CHECK_MS);
    return () => clearTimeout(timer);
  }, [key, api, chain, round]);

  const current = checked && checked.key === key ? checked : null;
  const live = current && 'review' in current ? current.review : null;
  const refused = current && 'failure' in current ? current : null;
  const [ticked, tick] = useTicks(live);
  // Every warning of the check on the screen is confirmed: there is nothing more to ask before it is
  // stored. A check with none is confirmed as it stands.
  const acked = live !== null && unticked(live, ticked).length === 0;
  const storeKey = live && key ? `${key}|${live.reviewHash}` : null;

  // Once the check is in and confirmed, our server checks every line again at today's prices and
  // stores the plan the order is made for. A few by themselves; after that, on asking.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `storeKey` stands for the check, its hash and the amount
  useEffect(() => {
    if (!storeKey || !body || !live || !acked || waiting || pinned) return;
    if (stored?.key === storeKey || storeFailure?.key === storeKey) return;
    if (storingFor.current === storeKey) return;
    if (stores.current >= AUTO_STORES && asked !== storeKey) return;
    storingFor.current = storeKey;
    stores.current += 1;
    setStoring(storeKey);
    const of = key;
    void acceptGoalMix(api, chain, {
      ...body,
      confirm: true,
      acceptedWarnings: acceptedOf(live, ticked),
      reviewHash: live.reviewHash,
    }).then((answer) => {
      // Another store took its place, or the amount changed: the answer, and its plan, are nobody's.
      if (storingFor.current !== storeKey) return;
      storingFor.current = null;
      setStoring(null);
      if (sending.current.key !== of) return;
      if (answer.kind !== 'ok')
        return setStoreFailure({ key: storeKey, text: sending.current.failureText(answer) });
      if (answer.value.status === 'review') {
        // The figures moved since the check: the new one is shown, its warnings to confirm again.
        setMoved(answer.value.review.reviewHash);
        setChecked({ key: of as string, review: answer.value.review });
        return;
      }
      const { proposalId, proposal } = answer.value;
      rememberPlan({ id: proposalId, userId, proposal, rollUp: null });
      setStored({ key: storeKey, planId: proposalId, amountUsd: body.amountUsd });
    });
  }, [storeKey, acked, waiting, pinned, stored, storeFailure, asked, api, chain]);

  const ready = stored && stored.key === storeKey && acked ? stored : null;
  // The deposit on the card: the one approved, else the plan stored for what is on the screen.
  const plan = pinned ?? ready;
  const pressed = pinned !== null;
  const prices = plan && quotes?.planId === plan.planId ? quotes.prices : null;
  // the pool price is said to be on its way only while an order is actually being made for the plan
  const quoting = plan !== null && prices === null && placingFor === plan.planId;
  const capped =
    storeKey !== null &&
    acked &&
    !waiting &&
    !ready &&
    storing !== storeKey &&
    storeFailure?.key !== storeKey &&
    stores.current >= AUTO_STORES &&
    asked !== storeKey;

  const nameOf = (asset: string) =>
    allocations.find((line) => line.assetId === asset)?.symbol ??
    units?.tokens[asset]?.symbol ??
    displayName(asset, t.plan);
  const lineOf = (asset: string) => live?.lines.find((line) => line.assetId === asset) ?? null;
  const held = (lines ?? start).filter((line) => line.weightBps > 0);
  const left = cashLeft(held);
  const factsOf = (asset: string) => {
    const line = lineOf(asset);
    return line && line.cls !== 'cash' ? (
      <DepositFacts line={line} quote={prices?.get(asset) ?? null} quoting={quoting} now={now} />
    ) : undefined;
  };
  const rows: MixRow[] = [
    ...held.map((line) => ({
      assetId: line.assetId,
      name: nameOf(line.assetId),
      weightBps: line.weightBps,
      amountUsd: lineOf(line.assetId)?.amountUsd ?? null,
      facts: factsOf(line.assetId),
    })),
    ...(cash && left > 0
      ? [
          {
            assetId: cash,
            name: t.mix.review.cash,
            weightBps: left,
            amountUsd: lineOf(cash)?.amountUsd ?? null,
          },
        ]
      : []),
  ];
  // Why there is no press yet, in the order a person would fix it.
  const blocked = !cash
    ? t.mix.failure.readOnly
    : waiting
      ? d.blocked.reply
      : !lines
        ? d.blocked.weights
        : amount === null
          ? d.blocked.amount
          : refused
            ? d.blocked.refused
            : !live
              ? d.blocked.checking
              : !acked
                ? d.blocked.ack
                : capped
                  ? d.blocked.ask
                  : null;
  const storeFailed = storeFailure && storeFailure.key === storeKey ? storeFailure.text : null;
  // once the order is on the card, its own line of costs says where things stand
  const status =
    refused || plan
      ? null
      : // while the plan is stored the press says so; this line stays as it was, so nothing moves
        live
        ? d.checked
        : key !== null
          ? d.checking
          : amount === null
            ? amountError
              ? null
              : d.needAmount
            : null;

  /** What the conversation is told, with the plan a press approves pinned to the card. */
  const hostOf = (of: Stored): DepositHost => ({
    onOpen: (open) => {
      setPinned((was) => was ?? of);
      host.onOpen(open);
    },
    onRunning: host.onRunning,
    onLeave: host.onLeave,
  });

  return (
    <div ref={root} data-ui="deposit-step" data-pressed={pressed || undefined} className="min-w-0">
      <Card
        as="section"
        aria-labelledby={titleId}
        mock={provenance !== null && provenance !== 'live'}
        mockLabels={{
          announce: provenance === 'mock' ? t.shell.mockAnnounce : t.shell.testNetworkLine,
        }}
      >
        <CardHeader id={titleId} title={d.title} level={2} meta={t.chain.names[chain]} />
        <CardBody className="flex min-w-0 flex-col gap-5">
          {!pressed && faucet && owner && (
            <TestFundsTop
              chain={chain}
              mock={mock}
              owner={owner}
              haveUsd={lastRead?.cash.amount ?? null}
              plan={plan ? { proposalId: plan.planId, amountUsd: plan.amountUsd } : null}
              onSent={() => setFunded((n) => n + 1)}
            />
          )}
          {!pressed && (
            <>
              <div className="flex min-w-0 flex-col gap-2">
                {/* The amount card's field (gate AMOUNT-CARD): the figure large, the chain's dollar
                    beside it, and the wallet's balance with Max; no quick amounts (Thom, Oct 28). */}
                <AmountWell
                  label={t.amount.field.deposit}
                  onBlur={() => setSettled(true)}
                  text={amountText}
                  onText={onAmountText}
                  token={
                    cash && units?.tokens[cash]
                      ? {
                          asset: cash,
                          symbol: units.tokens[cash].symbol,
                          name: t.amount.token(units.tokens[cash].symbol),
                        }
                      : null
                  }
                  balance={
                    !owner
                      ? undefined
                      : wallet.kind === 'read'
                        ? {
                            label: t.amount.balance.wallet,
                            state: 'read',
                            figure: shownBalance(
                              wallet.cash.amount,
                              wallet.cash.symbol,
                              LOCALE[lang],
                            ),
                            obs: wallet.cash.obs,
                            ...(wallet.cash.amount >= MIN_USD
                              ? {
                                  onMax: () =>
                                    onAmountText(
                                      maxText(Math.min(wallet.cash.amount, MAX_USD), lang),
                                    ),
                                }
                              : {}),
                          }
                        : wallet.kind === 'failed'
                          ? { label: t.amount.balance.wallet, state: 'failed' }
                          : { label: t.amount.balance.wallet, state: 'reading' }
                  }
                  problem={amountError ?? null}
                />
              </div>

              <div className="flex min-w-0 flex-col gap-2">
                <h3 className="flex flex-wrap items-baseline gap-x-3 text-caption font-medium">
                  {d.mix}
                  {edited && (
                    <span data-ui="deposit-edited" className="font-normal text-muted-foreground">
                      {d.edited}
                    </span>
                  )}
                </h3>
                {/* measured facts of this vault at this amount, once the server checked it */}
                {live && !broken && <DepositSummary review={live} />}
                {broken ? (
                  <p data-ui="deposit-broken" className="text-body-sm">
                    {d.brokenMix}
                  </p>
                ) : (
                  <MixLines rows={rows} caption={d.mix} amounts narrow />
                )}
                {status && !broken && (
                  <p
                    role="status"
                    data-ui="deposit-check"
                    className="text-caption text-muted-foreground"
                  >
                    {status}
                  </p>
                )}
                {live && moved === live.reviewHash && (
                  <p
                    role="status"
                    data-ui="deposit-moved"
                    className="flex items-start gap-1.5 text-body-sm"
                  >
                    <StatusMark status="watch" className="mt-1.5" />
                    <span>{t.mix.review.changed}</span>
                  </p>
                )}
                {refused && (
                  <div
                    role="alert"
                    data-ui="deposit-refused"
                    className="flex max-w-(--tf-measure-body) flex-col items-start gap-2 text-body-sm"
                  >
                    <p className="flex items-start gap-1.5 text-destructive">
                      <StatusMark status="off-track" size={12} className="mt-1.5" />
                      <span className="whitespace-pre-line">
                        {refused.failure}
                        {refused.invalid && `\n${d.invalidNext}`}
                      </span>
                    </p>
                    {!refused.invalid && (
                      <Button
                        variant="secondary"
                        data-action="deposit-check-again"
                        onClick={() => {
                          setChecked(null);
                          setRound((n) => n + 1);
                        }}
                      >
                        {d.checkAgain}
                      </Button>
                    )}
                  </div>
                )}
              </div>

              {live && live.warnings.length > 0 && (
                // Every warning in one short list with one box for all of them (gate SIGN-ONE-STEP):
                // the plan is stored only once it is ticked, and a review whose figures moved starts
                // with it unticked.
                <MixReviewAck review={live} ticked={ticked} onTick={tick} named={nameOf} />
              )}
            </>
          )}

          {!pressed && cash && (
            <div className="flex min-w-0 flex-col gap-3 border-t border-border pt-4">
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
                <Button variant="secondary" data-action="change-mix" onClick={onChangeMix}>
                  {d.changeMix}
                </Button>
                <Button
                  variant="link"
                  data-action="edit-by-hand"
                  aria-expanded={editing}
                  aria-controls={editorId}
                  onClick={() => setEditing((open) => !open)}
                >
                  {d.editByHand}
                </Button>
                {edited && (
                  <Button variant="link" data-action="reset-mix" onClick={() => setWeights(null)}>
                    {d.reset}
                  </Button>
                )}
                <Button variant="link" onClick={onClose}>
                  {d.backToProposal}
                </Button>
              </div>
              <div id={editorId} hidden={!editing} className="flex min-w-0 flex-col gap-3">
                {editing && (
                  <>
                    <p className="max-w-(--tf-measure-body) text-body-sm">{d.editorLead}</p>
                    <WeightEditor
                      plain
                      chain={chain}
                      mock={mock}
                      cash={cash}
                      value={shown}
                      onChange={setWeights}
                      names={Object.fromEntries(
                        allocations.flatMap((line) =>
                          line.symbol ? [[line.assetId, line.symbol]] : [],
                        ),
                      )}
                    />
                  </>
                )}
              </div>
            </div>
          )}
          {plan && (
            <div className="min-w-0">
              <DepositSign
                key={plan.planId}
                inline
                chain={chain}
                planId={plan.planId}
                amountUsd={plan.amountUsd}
                waiting={waiting}
                host={hostOf(plan)}
                faucetAbove={faucet}
                readAgain={funded}
                onLeave={onClose}
                foot={pressed ? null : foot}
                onQuoting={(now: boolean) =>
                  setPlacingFor((was) => (now ? plan.planId : was === plan.planId ? null : was))
                }
                onOrder={(order: OrderDetail | null) =>
                  setQuotes(
                    order ? { planId: plan.planId, prices: quotePrices(order, units) } : null,
                  )
                }
              />
            </div>
          )}
          {!pressed && (
            // The press, the order's costs and what holds the press, at the foot of the card: where
            // the pane scrolls, this stays in view under the rows (audit I3), so the one screen never
            // hides its button. The order's own screen draws them here (OrderScreen, `embed.foot`).
            <div
              ref={setFoot}
              data-ui="deposit-foot"
              // held, as the steps above it are, while a reply is on its way (DEPOSIT-IN-PLACE)
              inert={waiting}
              className="flex min-w-0 flex-col gap-3 empty:hidden md:sticky md:bottom-0 md:z-10 md:-mx-6 md:-mb-6 md:rounded-b-lg md:border-t md:border-border md:bg-card md:px-6 md:pt-4 md:pb-6"
            >
              {!plan && (
                <div className="flex flex-col items-start gap-3">
                  <Button
                    variant="primary"
                    data-action="deposit-press"
                    busy={storing !== null && storing === storeKey}
                    busyLabel={d.saving}
                    busyMark
                    disabled
                    aria-describedby={blocked !== null ? reasonId : undefined}
                    onDisabledClick={() => setTried(true)}
                  >
                    {amount === null ? d.press : t.invest.press(dollars(amount, lang))}
                  </Button>
                  {/* the line keeps its room while it has nothing to say, so the press never
                      moves as the reason comes and goes */}
                  <p id={reasonId} role="status" className="min-h-[1lh] text-body-sm">
                    {blocked !== null && (blocked !== d.blocked.amount || tried) ? blocked : ''}
                  </p>
                  {capped && (
                    <Button
                      variant="secondary"
                      data-action="deposit-again"
                      onClick={() => setAsked(storeKey)}
                    >
                      {d.again}
                    </Button>
                  )}
                  {storeFailed && (
                    <div
                      role="alert"
                      data-ui="deposit-store-failed"
                      className="flex max-w-(--tf-measure-body) flex-col items-start gap-2 text-body-sm"
                    >
                      <p className="flex items-start gap-1.5 text-destructive">
                        <StatusMark status="off-track" size={12} className="mt-1.5" />
                        <span className="whitespace-pre-line">{storeFailed}</span>
                      </p>
                      <Button
                        variant="secondary"
                        onClick={() => {
                          setStoreFailure(null);
                          setAsked(storeKey);
                        }}
                      >
                        {d.checkAgain}
                      </Button>
                    </div>
                  )}
                  <p className="max-w-(--tf-measure-body) text-caption text-muted-foreground">
                    {d.next} {d.balance}
                  </p>
                </div>
              )}
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
