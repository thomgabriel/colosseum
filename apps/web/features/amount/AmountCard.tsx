'use client';
import { type ChainId, type Provenance, TRUST_STATUS } from '@colosseum/schemas';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Card, CardBody } from '../../components/ui/Card';
import { cn } from '../../components/ui/cn';
import { Select } from '../../components/ui/Field';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import type { PinSource } from '../../components/ui/provenance';
import { StatusMark } from '../../components/ui/StatusMark';
import { useT } from '../../i18n/I18nProvider';
import { acceptTrust, trustAccepted } from '../order/order-record';
import { AssetMark } from '../order/PlanView';
import { chainIsLive } from '../order/readiness';
import { TrustNotice } from '../order/TrustNotice';

// The amount card (gate AMOUNT-CARD, Thom, Oct 13): where a deposit or a withdrawal starts, as the
// familiar deposit card of a DeFi app. One card: Deposit | Withdraw where both apply, where the money
// goes (or comes from), the amount large with its token beside it and what there is to spend under it
// with Max, what the vault will hold or what reaches the wallet, the details folded, the trust notice
// above the button the first time and one quiet line after, and the one primary button that names the
// action and the amount. What is wrong with the amount is said under the field, quietly, once it has
// been still for a moment, never as a sentence under a disabled button.
//
// The card decides nothing about an order. Its host reads the figures, says what is wrong, and is told
// of the press; what happens after it is the order's own flow (features/order), unchanged. The trust
// notice is accepted here as the person presses, per person and version of its text, where the order
// flow reads it (order-record.ts): this browser, until the API's consent route exists.

export type AmountMode = 'deposit' | 'withdraw';

/** How long the amount has to be still before what is wrong with it is said. */
export const SETTLE_MS = 500;

export type IntoOption = { value: string; label: string };

export type AmountBalance =
  | { state: 'reading' }
  | { state: 'failed' }
  | {
      state: 'read';
      /** The figure as shown: "1,234.56 USDC". */
      figure: string;
      obs: PinSource;
      /** Types the whole of it. Left out: no Max. */
      onMax?: () => void;
    };

export type AmountChip = { key: string; label: string; on: boolean; onPick: () => void };

export type AmountCardProps = {
  mode: AmountMode;
  /** Deposit | Withdraw at the top: where both apply. Left out, the card is the one action. */
  onMode?: (mode: AmountMode) => void;
  chain: ChainId;
  chainName: string;
  /** What the chain's figures are: the hatch and its line on the mock, a tag on a test network. */
  provenance: Provenance | null | undefined;
  /** Where the money goes ("Into") or comes from ("From"), above the amount. */
  into?: {
    label: string;
    value: string;
    options: readonly IntoOption[];
    /** Left out, or one option only: shown as a fact, not a choice. */
    onChange?: (value: string) => void;
    /** A sentence under it on what the choice means. */
    hint?: string;
  };
  /** The amount as typed, in dollars. Null: no field (a choice that moves no money). */
  field: {
    label: string;
    text: string;
    onText: (text: string) => void;
    /** The token the money moves in, beside the figure. */
    token: { asset: string; symbol: string; name: string } | null;
    /** What there is: the wallet's balance on a deposit, the vault's value on a withdrawal. */
    balance?: { label: string } & AmountBalance;
    /** Quick amounts under the field (25% · 50% · 75% · Max). */
    chips?: readonly AmountChip[];
    /** What is wrong with the amount, in the card's words. Said once it has been still. */
    problem: string | null;
    /** A quiet line under the field that holds nothing: short, with a way to fill it on the next step. */
    note?: string | null;
  } | null;
  /** Under the field, between it and the details: a choice of the host's (tokens or dollars). */
  choice?: ReactNode;
  /** What the deposit leads to or what the withdrawal pays: "Your vault will hold", "You get". */
  preview?: { title: string; body: ReactNode } | null;
  /** The compact details, folded. */
  details?: readonly { term: string; value: ReactNode }[];
  /** Said over the button and never folded: a read that failed, a vault that differs. */
  notice?: ReactNode;
  /** The trust notice, where this action needs it: a deposit. Left out: none. */
  trust?: { userId: string | null; keeper: boolean } | null;
  action: {
    label: string;
    onPress: () => void;
    /** The host's own reasons the press is held: said under the button. */
    reasons: readonly string[];
    /** The amount (or the host) is not ready: held with no sentence of its own. */
    held?: boolean;
    busy?: boolean;
    busyLabel?: string;
  };
  /** The person pressed and the order is under way: nothing on the card changes. */
  locked?: boolean;
  /** The card's title where it has no Deposit | Withdraw: a level under the screen's own heading. */
  headingLevel?: 2 | 3;
  className?: string;
};

export function AmountCard({
  mode,
  onMode,
  chain,
  chainName,
  provenance,
  into,
  field,
  choice,
  preview,
  details,
  notice,
  trust,
  action,
  locked = false,
  headingLevel = 2,
  className,
}: AmountCardProps) {
  const Title = headingLevel === 3 ? 'h3' : 'h2';
  const t = useT();
  const a = t.amount;
  const titleId = useId();
  const amountId = useId();
  const balanceId = useId();
  const problemId = useId();
  const reasonsId = useId();
  const trustId = useId();
  const intoId = useId();
  const intoHintId = useId();
  const [ticked, setTicked] = useState(false);
  const [viewTrust, setViewTrust] = useState(false);

  // Said once the amount has been still for a moment, or the field was left: never on the first digit.
  const text = field?.text ?? '';
  const [settled, setSettled] = useState(true);
  const [left, setLeft] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a pause after each change of the text
  useEffect(() => {
    setSettled(false);
    const timer = setTimeout(() => setSettled(true), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [text]);
  const problem = field?.problem && (settled || left) ? field.problem : null;

  const keeper = trust?.keeper ?? true;
  const live = chainIsLive(chain);
  const accepted = trust
    ? trustAccepted(trust.userId, TRUST_STATUS.textVersion, keeper, live)
    : true;
  const trustHeld = trust ? !accepted && !ticked : false;
  const held = action.held === true || action.reasons.length > 0 || trustHeld || locked;
  const describedBy =
    [
      problem ? problemId : null,
      action.reasons.length > 0 ? reasonsId : null,
      trustHeld ? trustId : null,
    ]
      .filter(Boolean)
      .join(' ') || undefined;

  function press() {
    if (held) return;
    // Kept as the person presses, so the order's own flow does not ask a second time.
    if (trust && !accepted && ticked && trust.userId)
      acceptTrust(trust.userId, TRUST_STATUS.textVersion, keeper, live);
    action.onPress();
  }

  const sample = provenance === 'mock';
  const modes: readonly AmountMode[] = ['deposit', 'withdraw'];
  const choosable = into?.onChange !== undefined && into.options.length > 1;
  return (
    <Card
      as="section"
      aria-labelledby={titleId}
      mock={sample}
      mockLabels={{ announce: t.shell.mockAnnounce }}
      className={cn('mx-auto w-full max-w-[30rem]', className)}
    >
      <CardBody className="flex flex-col gap-4">
        <div data-ui="amount-card" data-mode={mode} className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            {onMode ? (
              <fieldset
                data-ui="amount-modes"
                className="inline-flex rounded-md border border-input p-0.5"
              >
                <legend className="sr-only">{a.modes.label}</legend>
                {modes.map((m) => (
                  <button
                    key={m}
                    type="button"
                    id={m === mode ? titleId : undefined}
                    aria-pressed={m === mode}
                    disabled={locked}
                    onClick={() => m !== mode && onMode(m)}
                    className={cn(
                      'h-8 rounded-sm px-3 text-body-sm font-semibold transition-colors',
                      'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                      m === mode
                        ? 'bg-honey-tint text-honey-text'
                        : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
                    )}
                  >
                    {a.modes[m]}
                  </button>
                ))}
              </fieldset>
            ) : (
              <Title id={titleId} className="font-display text-h4 font-semibold">
                {a.modes[mode]}
              </Title>
            )}
            {provenance === 'sandbox' && (
              // A test network's figures are real reads, not samples: one tag says where they are
              // from (BUY-STEPS), never a plate on a figure.
              <span
                data-ui="data-note"
                className="rounded-sm border border-border px-2 py-0.5 text-caption text-muted-foreground [overflow-wrap:anywhere]"
              >
                {t.buy.steps.note.testNetwork(chainName)}
              </span>
            )}
          </div>

          {into && (
            <div data-ui="amount-into" className="flex min-w-0 flex-col gap-1">
              <div className="flex min-w-0 items-center gap-3">
                {choosable ? (
                  <label htmlFor={intoId} className="shrink-0 text-body-sm text-muted-foreground">
                    {into.label}
                  </label>
                ) : (
                  <span className="shrink-0 text-body-sm text-muted-foreground">{into.label}</span>
                )}
                {choosable ? (
                  <Select
                    id={intoId}
                    value={into.value}
                    disabled={locked}
                    aria-describedby={into.hint ? intoHintId : undefined}
                    onChange={(e) => into.onChange?.(e.currentTarget.value)}
                    className="min-w-0 flex-1"
                  >
                    {into.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <span className="min-w-0 text-body-sm font-medium [overflow-wrap:anywhere]">
                    {into.options.find((o) => o.value === into.value)?.label ?? into.value}
                  </span>
                )}
              </div>
              {into.hint && (
                <p id={intoHintId} className="text-caption text-muted-foreground">
                  {into.hint}
                </p>
              )}
            </div>
          )}

          {field && (
            <div className="flex min-w-0 flex-col gap-2">
              <div
                data-ui="amount-well"
                className={cn(
                  'flex min-w-0 flex-col gap-2 rounded-md border bg-muted p-4',
                  'focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring',
                  problem ? 'border-destructive' : 'border-input',
                )}
              >
                <label
                  htmlFor={amountId}
                  className="text-caption font-medium text-muted-foreground"
                >
                  {field.label}
                </label>
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="shrink-0 font-display text-h3 text-muted-foreground"
                  >
                    {t.mix.deposit.currency}
                  </span>
                  <input
                    id={amountId}
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="0"
                    disabled={locked}
                    value={field.text}
                    aria-invalid={problem ? true : undefined}
                    aria-describedby={
                      [field.balance ? balanceId : null, problem ? problemId : null]
                        .filter(Boolean)
                        .join(' ') || undefined
                    }
                    onChange={(e) => {
                      setLeft(false);
                      field.onText(e.currentTarget.value);
                    }}
                    onBlur={() => setLeft(true)}
                    className="h-12 min-w-0 flex-1 bg-transparent font-display text-[2rem] leading-10 font-semibold tabular-nums text-foreground outline-none placeholder:text-muted-foreground disabled:text-muted-foreground"
                  />
                  {field.token && (
                    <span
                      data-ui="amount-token"
                      className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-input bg-card pr-3 pl-1 text-body-sm font-semibold"
                    >
                      <AssetMark asset={field.token.asset} className="size-7" />
                      <span aria-hidden="true">{field.token.symbol}</span>
                      <span className="sr-only">{field.token.name}</span>
                    </span>
                  )}
                </div>
                {field.balance && (
                  <p
                    id={balanceId}
                    data-ui="amount-balance"
                    data-state={field.balance.state}
                    className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-body-sm text-muted-foreground"
                  >
                    {field.balance.state === 'read' ? (
                      <>
                        <span>{field.balance.label}:</span>
                        <ProvenancePin
                          value={field.balance.figure}
                          obs={field.balance.obs}
                          what={field.balance.label}
                          className="text-foreground tabular-nums"
                        />
                        {field.balance.onMax && (
                          <>
                            <span aria-hidden="true">·</span>
                            <Button
                              variant="link"
                              disabled={locked}
                              aria-label={a.balance.maxLabel(field.balance.figure)}
                              onClick={field.balance.onMax}
                            >
                              {a.balance.max}
                            </Button>
                          </>
                        )}
                      </>
                    ) : field.balance.state === 'reading' ? (
                      <span>{a.balance.reading}</span>
                    ) : (
                      <span>{a.balance.failed}</span>
                    )}
                  </p>
                )}
              </div>
              {field.chips && field.chips.length > 0 && (
                <div data-ui="amount-chips" className="flex flex-wrap gap-2">
                  {field.chips.map((chip) => (
                    <Button
                      key={chip.key}
                      variant="chip"
                      pressed={chip.on}
                      disabled={locked}
                      onClick={chip.onPick}
                    >
                      {chip.label}
                    </Button>
                  ))}
                </div>
              )}
              {!problem && field.note && (settled || left) && (
                <p data-ui="amount-note" className="text-body-sm text-muted-foreground">
                  {field.note}
                </p>
              )}
              {problem && (
                <p
                  id={problemId}
                  data-ui="amount-problem"
                  className="flex items-start gap-1.5 text-body-sm text-destructive"
                >
                  <StatusMark status="off-track" size={12} className="mt-1.5" />
                  <span>{problem}</span>
                </p>
              )}
            </div>
          )}

          {choice}

          {preview && (
            <div
              data-ui="amount-preview"
              className="flex min-w-0 flex-col gap-2 rounded-md border border-border p-4"
            >
              <p className="text-caption font-medium text-muted-foreground">{preview.title}</p>
              {preview.body}
            </div>
          )}

          {details && details.length > 0 && (
            <details data-ui="amount-details" className="group/details">
              <summary className="w-fit cursor-pointer text-body-sm font-medium text-honey-text underline decoration-1 underline-offset-4 hover:decoration-2">
                {a.details.summary}
              </summary>
              <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-body-sm">
                {details.map((d) => (
                  <div key={d.term} className="contents">
                    <dt className="text-muted-foreground">{d.term}</dt>
                    <dd className="min-w-0 [overflow-wrap:anywhere]">{d.value}</dd>
                  </div>
                ))}
              </dl>
            </details>
          )}

          {notice}

          {trust &&
            (!accepted ? (
              // The first time: the four points, the whole list one click away and the box to tick,
              // just over the button it holds.
              <div
                id={trustId}
                data-ui="amount-trust"
                data-state="ask"
                className="rounded-md border border-border p-4"
              >
                <TrustNotice
                  chain={chain}
                  accepted={false}
                  checked={ticked}
                  onCheck={setTicked}
                  keeper={keeper}
                />
              </div>
            ) : (
              <div data-ui="amount-trust" data-state="accepted" className="flex flex-col gap-3">
                <p className="text-body-sm text-muted-foreground">
                  {a.trust.accepted}
                  {' · '}
                  <Button
                    variant="link"
                    aria-expanded={viewTrust}
                    onClick={() => setViewTrust((open) => !open)}
                  >
                    {viewTrust ? a.trust.hide : a.trust.view}
                  </Button>
                </p>
                {viewTrust && (
                  <div className="rounded-md border border-border p-4">
                    <TrustNotice
                      chain={chain}
                      accepted
                      checked={false}
                      onCheck={() => {}}
                      keeper={keeper}
                    />
                  </div>
                )}
              </div>
            ))}

          <div className="flex flex-col gap-2">
            <Button
              variant="primary"
              data-action={`amount-${mode}`}
              className="w-full"
              disabled={held}
              busy={action.busy}
              busyLabel={action.busyLabel}
              aria-describedby={describedBy}
              onClick={press}
            >
              {action.label}
            </Button>
            {action.reasons.length > 0 && (
              <ul
                id={reasonsId}
                data-ui="amount-reasons"
                className="flex flex-col gap-1 text-body-sm text-muted-foreground"
              >
                {action.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </CardBody>
    </Card>
  );
}
