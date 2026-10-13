'use client';
import { type ChainId, ORDER_LIMITS, type Provenance, type Target } from '@colosseum/schemas';
import { type ReactNode, useState } from 'react';
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
import { AmountCard, type AmountCardProps, type AmountMode } from './AmountCard';
import { maxText, readAmount } from './amount-check';
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
  /** The amount the card opens with, as typed. */
  initialText?: string;
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
  keeperInvests = false,
  into,
  onMode,
  blocked,
  notice,
  source,
  initialText = '',
  running,
  onPressed,
  pressed: resumed = null,
  fact = true,
  headingLevel,
  flow,
}: DepositCardProps) {
  const t = useT();
  const lang = useLang();
  const a = t.amount;
  const locale = LOCALE[lang];
  const [text, setText] = useState(initialText);
  // Taken up after a reload, the deposit is the one its order was made for: no way back to the field.
  const [pressed, setPressed] = useState<number | null>(resumed);
  const takenUp = resumed !== null;
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
    setPressed(at);
    onPressed?.(at);
  }
  function takeBack() {
    setPressed(null);
    onPressed?.(null);
  }

  if (pressed !== null)
    return (
      <div data-ui="deposit-pressed" className="flex min-w-0 flex-col gap-4">
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
  const preview =
    keeperInvests || lines.length > 0
      ? {
          title: a.preview.deposit,
          body: keeperInvests ? (
            <p className="text-body-sm">{a.preview.keeper}</p>
          ) : (
            <ul data-ui="deposit-holds" className="flex flex-col gap-1.5">
              {lines.map((line) => (
                <li key={line.asset} className="flex min-w-0 items-center gap-2 text-body-sm">
                  <AssetMark asset={line.asset} className="size-5" />
                  <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{line.name}</span>
                  <span className="text-muted-foreground tabular-nums">
                    {formatBps(line.weightBps, locale)}
                  </span>
                  <span className="w-24 text-right font-medium tabular-nums">
                    {amount !== null ? dollars((amount * line.weightBps) / 10_000, lang) : '—'}
                  </span>
                </li>
              ))}
            </ul>
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
            value: a.details.slippageValue(formatBps(ORDER_LIMITS.maxSlippageBps, locale)),
          },
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
    ...(source ? [{ term: a.details.source, value: source }] : []),
  ];

  const balanceFigure = read
    ? `${read.cash.amount.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${read.cash.symbol}`
    : '';
  return (
    <AmountCard
      mode="deposit"
      onMode={onMode}
      headingLevel={headingLevel}
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
      details={details}
      notice={notice}
      trust={{ userId, keeper }}
      action={{
        label: amount !== null ? a.press.deposit(dollars(amount, lang)) : a.enter,
        held: amount === null || blocking !== null || !owner,
        reasons: [...blocked, ...(!owner ? [t.buy.blocked.wallet] : [])],
        onPress: () => amount !== null && press(amount),
      }}
    />
  );
}
