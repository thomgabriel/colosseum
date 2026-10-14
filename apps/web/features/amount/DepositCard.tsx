'use client';
import {
  type ChainId,
  chainFamily,
  ORDER_DEFAULT_SLIPPAGE_BPS,
  type Provenance,
  type Target,
} from '@colosseum/schemas';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import { LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { dollars } from '../goal/sheet';
import { formatBps, tokenName } from '../order/amounts';
import { MAX_USD, MIN_USD } from '../order/limits';
import type { BuyOf } from '../order/order-api';
import { AssetMark } from '../order/PlanView';
import { displayName } from '../order/plain';
import { unitsFor } from '../order/units';
import { holdingsOf, type Vault } from '../portfolio/portfolio';
import { Composition } from '../shared/Composition';
import { AmountCard, type AmountCardProps, type AmountMode } from './AmountCard';
import { maxText, readAmount, shownBalance } from './amount-check';
import { useWalletBalance } from './use-balance';

// A deposit on the amount card (gate AMOUNT-CARD): the amount in dollars with the token it is paid in,
// the wallet's balance read from the chain with Max, what the vault will hold at that amount, the
// details folded, the trust notice, and "Deposit $250". The press hands the amount to the host's order
// flow (the invest card, features/order), which this card then sits over as one line, "Deposit of
// $250 · Change", until the person approves the order there. Nothing here makes or signs an order.

export type DepositFlow = (
  amount: number,
  /** The order flow chose another amount ("Deposit $900 instead"): the card's line follows it. */
  change: (amount: number) => void,
) => ReactNode;

export type DepositCardProps = {
  chain: ChainId;
  chainName: string;
  mock: boolean;
  /** What the chain's figures are, before the wallet is read. */
  provenance: Provenance | null | undefined;
  /** The wallet that signs, on this chain. Null: nobody to read or deposit for. */
  owner: string | null;
  userId: string | null;
  /** What the deposit is into, as the funding read and the order name it. */
  buyOf: BuyOf;
  /** What the amount is split into, by weight; the rest stays as cash. Null: not split here. */
  holdings: readonly Target[] | null;
  /** The keeper may trade the vault: its limits are among the trust notice's points. */
  keeper: boolean;
  /**
   * What the vault holds now, where the deposit goes into one that exists: each holding's value as
   * read, in dollars (null with no price), its share now, and the vault's value. Left out: a new vault.
   */
  held?: {
    rows: readonly { asset: string; valueUsd: number | null; weightBps: number; cash?: boolean }[];
    totalUsd: number;
  } | null;
  /** The way back out of the pane the card heads. */
  leave?: { label: string; onLeave: () => void };
  /** The deposit lands as cash for the keeper to invest (auto-follow on): said in the preview. */
  keeperInvests?: boolean;
  into?: AmountCardProps['into'];
  onMode?: (mode: AmountMode) => void;
  /** The host's reasons no deposit can be made yet: said under the button. */
  blocked: readonly string[];
  /** Over the button, never folded: a read that failed or differs. */
  notice?: ReactNode;
  /** Where what is deposited into was read, in the details. */
  source?: ReactNode;
  /** A quiet line under the button, and under the order once pressed: where the vault was read. */
  foot?: ReactNode;
  /** The amount the card opens with, as typed. */
  initialText?: string;
  /**
   * The amount as typed and the trust box, kept by the host: a host whose card is drawn again under
   * the person (a reread of what is deposited into) keeps what they typed and ticked.
   */
  entry?: {
    text: string;
    onText: (text: string) => void;
    ticked: boolean;
    onTick: (ticked: boolean) => void;
  };
  /** The person's steps are being signed: the card's line loses its way back. */
  running: boolean;
  /** The amount was pressed (a number) or taken back (null): the host locks what it must. */
  onPressed?: (amount: number | null) => void;
  /** An amount pressed before the card was mounted again (a deposit taken up after a reload). */
  pressed?: number | null;
  /**
   * The line that says the amount once it is pressed. Off for an order that finishes another, which
   * deposits nothing.
   */
  fact?: boolean;
  /** The card's title level, under the screen's own heading. */
  headingLevel?: 2 | 3;
  /** The card's title, where the screen says more than the action. */
  title?: string;
  /** The amount takes the focus as the card opens. */
  focusOnOpen?: boolean;
  flow: DepositFlow;
};

export function DepositCard({
  chain,
  chainName,
  mock,
  provenance,
  owner,
  userId,
  buyOf,
  holdings,
  keeper,
  held = null,
  leave,
  keeperInvests = false,
  into,
  onMode,
  blocked,
  notice,
  source,
  foot,
  initialText = '',
  entry,
  running,
  onPressed,
  pressed: resumed = null,
  fact = true,
  headingLevel,
  title,
  focusOnOpen,
  flow,
}: DepositCardProps) {
  const t = useT();
  const lang = useLang();
  const a = t.amount;
  const locale = LOCALE[lang];
  const [textHere, setTextHere] = useState(initialText);
  const text = entry?.text ?? textHere;
  const setText = entry?.onText ?? setTextHere;
  // Taken up after a reload, the deposit is the one its order was made for: no way back to the field.
  const [pressed, setPressed] = useState<number | null>(resumed);
  const takenUp = resumed !== null;
  // The press takes the card's button away: the focus goes to what took its place, the line that says
  // the amount (or the order's own card under it), never to the page. Not on a deposit taken up again.
  const after = useRef<HTMLDivElement>(null);
  const pressedHere = useRef(false);
  useEffect(() => {
    if (pressed === null || !pressedHere.current) return;
    pressedHere.current = false;
    after.current?.focus();
  }, [pressed]);
  // Read for the field only: once the amount is pressed, the invest card reads the wallet itself.
  const balance = useWalletBalance(owner && pressed === null ? buyOf : null, owner, chain, mock);
  const read = balance.kind === 'read' ? balance : null;
  const units = unitsFor(chain, mock);
  const cashAsset = read?.cash.asset ?? units?.cash ?? null;
  const symbol =
    read?.cash.symbol ??
    (cashAsset ? (units?.tokens[cashAsset]?.symbol ?? tokenName(cashAsset)) : null);
  const figures = read?.provenance ?? provenance;
  const { amount, problem, over } = readAmount(
    text,
    lang,
    { least: MIN_USD, most: MAX_USD, available: read ? read.cash.amount : null, of: 'balance' },
    t,
  );
  // Short, where the next step offers a way to fill the wallet (test funds, or the mock's own): said,
  // and the press not held, so the person reaches that way. Anywhere else, a short wallet holds it.
  const fillable = read !== null && (read.testFunds || read.provenance === 'mock');
  const blocking = over && !fillable ? problem : over ? null : problem;

  function press(at: number) {
    pressedHere.current = true;
    setPressed(at);
    onPressed?.(at);
  }
  function takeBack() {
    setPressed(null);
    onPressed?.(null);
  }

  if (pressed !== null)
    return (
      <div
        ref={after}
        tabIndex={-1}
        data-ui="deposit-pressed"
        className="flex min-w-0 flex-col gap-4 outline-none"
      >
        {fact && (
          <p
            data-ui="deposit-fact"
            className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-body"
          >
            <span>
              {a.pressed(dollars(pressed, lang))}
              {into && (
                <span className="text-muted-foreground">
                  {' · '}
                  {into.options.find((o) => o.value === into.value)?.label ?? into.value}
                </span>
              )}
            </span>
            {!running && !takenUp && (
              <Button variant="link" data-action="amount-change" onClick={takeBack}>
                {a.change}
              </Button>
            )}
          </p>
        )}
        {foot}
        {flow(pressed, (next) => {
          setText(maxText(next, lang));
          press(next);
        })}
      </div>
    );

  const total = holdings?.reduce((sum, h) => sum + h.weightBps, 0) ?? 0;
  const lines =
    holdings && !keeperInvests
      ? [
          ...holdings.map((h) => ({
            asset: h.asset,
            name: displayName(h.asset, t.plan),
            weightBps: h.weightBps,
          })),
          ...(total < 10_000 && cashAsset
            ? [{ asset: cashAsset, name: a.preview.cash, weightBps: 10_000 - total }]
            : []),
        ]
      : [];
  // What the vault will hold at this amount, once there is one, as the shared composition compares it:
  // a new vault's "Now" empty, an existing one's its shares today, each against its shares after the
  // deposit at the vault's weights. The after shares are worked out from the vault's values as read
  // with its prices; where a holding has no price, the comparison is left out and the weights stand.
  const afterShares = (() => {
    if (amount === null) return null;
    const priced = held && held.rows.every((r) => r.valueUsd !== null) && held.totalUsd > 0;
    if (!held || !priced)
      return lines.map(
        (line): { asset: string; name: string; bps: number; beforeBps?: number } => ({
          asset: line.asset,
          name: line.name,
          bps: line.weightBps,
        }),
      );
    const total = held.totalUsd + amount;
    const keys = [...new Set([...held.rows.map((r) => r.asset), ...lines.map((l) => l.asset)])];
    return keys.map((asset) => {
      const now = held.rows.find((r) => r.asset === asset);
      const line = lines.find((l) => l.asset === asset);
      const value = (now?.valueUsd ?? 0) + (amount * (line?.weightBps ?? 0)) / 10_000;
      return {
        asset,
        name: line?.name ?? (now?.cash ? a.preview.cash : displayName(asset, t.plan)),
        bps: Math.round((value / total) * 10_000),
        beforeBps: now?.weightBps ?? 0,
      };
    });
  })();
  const preview =
    amount !== null && (keeperInvests || (afterShares && afterShares.length > 0))
      ? {
          title: a.preview.deposit,
          body: keeperInvests ? (
            <p className="text-body-sm">{a.preview.keeper}</p>
          ) : (
            <div data-ui="deposit-holds">
              <Composition
                mode="compare"
                size="compact"
                labels={{ caption: a.preview.deposit }}
                items={(afterShares ?? []).map((item) => ({
                  key: item.asset,
                  name: item.name,
                  asset: item.asset,
                  cash: item.asset === cashAsset,
                  bps: item.bps,
                  ...(item.beforeBps !== undefined ? { beforeBps: item.beforeBps } : {}),
                }))}
              />
            </div>
          ),
        }
      : null;

  const details: NonNullable<AmountCardProps['details']> = [
    { term: a.details.least, value: dollars(MIN_USD, lang) },
    { term: a.details.most, value: dollars(MAX_USD, lang) },
    ...(holdings && holdings.length > 0 && !keeperInvests
      ? [
          {
            term: a.details.slippage,
            value: a.details.slippageValue(formatBps(ORDER_DEFAULT_SLIPPAGE_BPS, locale)),
          },
          // An EVM vault's swaps have limits of their own, per token, in the deployment: said in
          // words, so a larger deposit is not a surprise at the next step.
          ...(chainFamily(chain) === 'evm'
            ? [{ term: a.details.tradeLimits, value: a.details.tradeLimitsValue, wide: true }]
            : []),
        ]
      : []),
    ...(read
      ? [
          {
            term: a.details.fee,
            value: (
              <ProvenancePin
                value={a.details.feeValue(
                  `${read.fee.amount.toLocaleString(locale, { maximumFractionDigits: 6 })} ${read.fee.symbol}`,
                )}
                labelValue={`${read.fee.amount.toLocaleString(locale, { maximumFractionDigits: 6 })} ${read.fee.symbol}`}
                obs={read.fee.obs}
                what={a.details.fee}
                className="whitespace-normal"
              />
            ),
          },
        ]
      : []),
    ...(source ? [{ term: a.details.source, value: source, wide: true }] : []),
  ];

  const balanceFigure = read ? shownBalance(read.cash.amount, read.cash.symbol, locale) : '';
  return (
    <AmountCard
      mode="deposit"
      onMode={onMode}
      headingLevel={headingLevel}
      {...(title ? { title } : {})}
      {...(focusOnOpen ? { focusOnOpen } : {})}
      {...(leave ? { leave } : {})}
      chain={chain}
      chainName={chainName}
      provenance={figures}
      into={into}
      field={{
        label: a.field.deposit,
        text,
        onText: setText,
        token: cashAsset && symbol ? { asset: cashAsset, symbol, name: a.token(symbol) } : null,
        balance: !owner
          ? undefined
          : read
            ? {
                label: a.balance.wallet,
                state: 'read',
                figure: balanceFigure,
                obs: read.cash.obs,
                ...(read.cash.amount >= MIN_USD
                  ? { onMax: () => setText(maxText(Math.min(read.cash.amount, MAX_USD), lang)) }
                  : {}),
              }
            : balance.kind === 'failed'
              ? { label: a.balance.wallet, state: 'failed' }
              : { label: a.balance.wallet, state: 'reading' },
        problem: blocking,
        note:
          over && fillable
            ? read?.provenance === 'mock'
              ? a.errors.overSample
              : a.errors.overFunded
            : null,
      }}
      preview={preview}
      // the figures once there is an amount to hold them to: no closed fold over nothing
      {...(amount !== null ? { details } : {})}
      notice={notice}
      foot={foot}
      trust={{
        userId,
        keeper,
        ...(entry ? { ticked: entry.ticked, onTick: entry.onTick } : {}),
      }}
      action={{
        // with no amount yet, the button names the action alone, never a sentence of what is missing
        label: amount !== null ? a.press.deposit(dollars(amount, lang)) : a.modes.deposit,
        held: amount === null || blocking !== null || !owner,
        reasons: [...blocked, ...(!owner ? [t.buy.blocked.wallet] : [])],
        onPress: () => amount !== null && press(amount),
      }}
    />
  );
}

/** What a vault of the person's holds now, as the deposit card compares it: from its portfolio row. */
export function heldOf(vault: Vault): NonNullable<DepositCardProps['held']> {
  return {
    rows: holdingsOf(vault).map((row) => ({
      asset: row.asset,
      valueUsd: row.valueUsd === null ? null : Number(row.valueUsd),
      weightBps: row.weightBps,
      cash: 'cash' in row && row.cash === true,
    })),
    totalUsd: Number(vault.valueUsd),
  };
}
