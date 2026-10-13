'use client';
import { useId } from 'react';
import { Button } from '../../components/ui/Button';
import { cn } from '../../components/ui/cn';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import type { PinSource } from '../../components/ui/provenance';
import { StatusMark } from '../../components/ui/StatusMark';
import { useT } from '../../i18n/I18nProvider';
import { AssetMark } from '../order/PlanView';

// The amount as the amount card takes it (gate AMOUNT-CARD): the figure large in its well, the token
// it moves in beside it, what there is to spend under it with Max, quick amounts, and a quiet line for
// what is wrong. The card and the deposit step of /goal both draw it. Its host decides when a problem
// is said; this only says it.

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

export type AmountChip = {
  key: string;
  label: string;
  /** Pressed now. Left out: a quick amount to type, not a state to hold. */
  on?: boolean;
  onPick: () => void;
  /** The chip's name where its label alone says too little. */
  name?: string;
};

export type AmountWellProps = {
  id?: string;
  label: string;
  text: string;
  onText: (text: string) => void;
  onBlur?: () => void;
  /** The token the money moves in, beside the figure. */
  token: { asset: string; symbol: string; name: string } | null;
  /** What there is: the wallet's balance on a deposit, the vault's value on a withdrawal. */
  balance?: ({ label: string } & AmountBalance) | undefined;
  /** Quick amounts under the field. */
  chips?: readonly AmountChip[] | undefined;
  /** The name of the list of quick amounts, for screen readers. */
  chipsLabel?: string;
  /** What is wrong with the amount, already decided to be said. */
  problem: string | null;
  /** A quiet line that holds nothing. */
  note?: string | null;
  /** A quiet caption under the field: the least and the most. */
  hint?: string;
  locked?: boolean;
};

export function AmountWell({
  id,
  label,
  text,
  onText,
  onBlur,
  token,
  balance,
  chips,
  chipsLabel,
  problem,
  note,
  hint,
  locked = false,
}: AmountWellProps) {
  const t = useT();
  const a = t.amount;
  const auto = useId();
  const amountId = id ?? auto;
  const balanceId = `${amountId}-balance`;
  const problemId = `${amountId}-problem`;
  const hintId = `${amountId}-hint`;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div
        data-ui="amount-well"
        className={cn(
          'flex min-w-0 flex-col gap-2 rounded-md border bg-muted p-4',
          'focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring',
          problem ? 'border-destructive' : 'border-input',
        )}
      >
        <label htmlFor={amountId} className="text-caption font-medium text-muted-foreground">
          {label}
        </label>
        <div className="flex min-w-0 items-center gap-2">
          <span aria-hidden="true" className="shrink-0 font-display text-h3 text-muted-foreground">
            {t.mix.deposit.currency}
          </span>
          <input
            id={amountId}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0"
            disabled={locked}
            value={text}
            aria-invalid={problem ? true : undefined}
            aria-describedby={
              [hint ? hintId : null, balance ? balanceId : null, problem ? problemId : null]
                .filter(Boolean)
                .join(' ') || undefined
            }
            onChange={(e) => onText(e.currentTarget.value)}
            onBlur={onBlur}
            className="h-12 min-w-0 flex-1 bg-transparent font-display text-[2rem] leading-10 font-semibold tabular-nums text-foreground outline-none placeholder:text-muted-foreground disabled:text-muted-foreground"
          />
          {token && (
            <span
              data-ui="amount-token"
              className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-input bg-card pr-3 pl-1 text-body-sm font-semibold"
            >
              <AssetMark asset={token.asset} className="size-7" />
              <span aria-hidden="true">{token.symbol}</span>
              <span className="sr-only">{token.name}</span>
            </span>
          )}
        </div>
        {balance && (
          <p
            id={balanceId}
            data-ui="amount-balance"
            data-state={balance.state}
            className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-body-sm text-muted-foreground"
          >
            {balance.state === 'read' ? (
              <>
                <span>{balance.label}:</span>
                <ProvenancePin
                  value={balance.figure}
                  obs={balance.obs}
                  what={balance.label}
                  className="text-foreground tabular-nums"
                />
                {balance.onMax && (
                  <>
                    <span aria-hidden="true">·</span>
                    <Button
                      variant="link"
                      disabled={locked}
                      aria-label={a.balance.maxLabel(balance.figure)}
                      onClick={balance.onMax}
                    >
                      {a.balance.max}
                    </Button>
                  </>
                )}
              </>
            ) : balance.state === 'reading' ? (
              <span>{a.balance.reading}</span>
            ) : (
              <span>{a.balance.failed}</span>
            )}
          </p>
        )}
      </div>
      {hint && (
        <p id={hintId} className="text-caption text-muted-foreground">
          {hint}
        </p>
      )}
      {chips && chips.length > 0 && (
        <ul aria-label={chipsLabel} data-ui="amount-chips" className="flex flex-wrap gap-2">
          {chips.map((chip) => (
            <li key={chip.key}>
              <Button
                variant="chip"
                pressed={chip.on}
                disabled={locked}
                aria-label={chip.name}
                onClick={chip.onPick}
              >
                {chip.label}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {note && (
        <p data-ui="amount-note" className="text-body-sm text-muted-foreground">
          {note}
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
  );
}
