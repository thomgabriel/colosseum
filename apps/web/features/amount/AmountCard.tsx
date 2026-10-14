'use client';
import { type ChainId, type Provenance, TRUST_STATUS } from '@colosseum/schemas';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { cn } from '../../components/ui/cn';
import { Hint } from '../../components/ui/Hint';
import { Icon } from '../../components/ui/Icon';
import { Panel, PanelBody, PanelHead, PanelStat, Plate, StatGrid } from '../../components/ui/Panel';
import { useT } from '../../i18n/I18nProvider';
import { acceptTrust, trustAccepted } from '../order/order-record';
import { chainIsLive } from '../order/readiness';
import { type AmountBalance, type AmountChip, AmountWell } from './AmountWell';
import { TrustCompact } from './TrustCompact';

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

/** `title`: what a pointer resting on it shows, such as the vault's address under its name. */
export type IntoOption = { value: string; label: string; title?: string };

export type { AmountBalance, AmountChip } from './AmountWell';

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
    /** The name of the list of quick amounts, for screen readers. */
    chipsLabel?: string;
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
  /**
   * The labelled figures, in sight as a grid (label over figure, as the portfolio board sets them).
   * `wide` takes a whole row (an address).
   */
  details?: readonly { term: string; value: ReactNode; wide?: boolean }[];
  /** What the details do not say as figures, in words, behind one fold. */
  more?: { label: string; body: ReactNode } | null;
  /** A quiet line under the button: where what the card is held to was read. */
  foot?: ReactNode;
  /** Said over the button and never folded: a read that failed, a vault that differs. */
  notice?: ReactNode;
  /** The trust notice, where this action needs it: a deposit. Left out: none. */
  trust?: {
    userId: string | null;
    keeper: boolean;
    /** The box as its host keeps it, where the card may be drawn again under the person. */
    ticked?: boolean;
    onTick?: (ticked: boolean) => void;
  } | null;
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
  /** The card's heading level, under the screen's own heading. */
  headingLevel?: 2 | 3;
  /** The card's title, where the screen says more than the action ("Deposit into your vault"). */
  title?: string;
  /** The card is the pane's first thing: the amount takes the focus, so it is typed at once. */
  focusOnOpen?: boolean;
  /** The way back out of the pane the card heads, in its head on the right. */
  leave?: { label: string; onLeave: () => void };
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
  more,
  foot,
  notice,
  trust,
  action,
  locked = false,
  headingLevel = 2,
  title,
  focusOnOpen = false,
  leave,
  className,
}: AmountCardProps) {
  const t = useT();
  const a = t.amount;
  const titleId = useId();
  const amountId = useId();
  const reasonsId = useId();
  const trustId = useId();
  const intoId = useId();
  const intoHintId = useId();
  const [tickedHere, setTickedHere] = useState(false);
  const ticked = trust?.ticked ?? tickedHere;
  const setTicked = trust?.onTick ?? setTickedHere;
  const [viewTrust, setViewTrust] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, as the card opens
  useEffect(() => {
    if (focusOnOpen) document.getElementById(amountId)?.focus();
  }, []);

  // Said once the amount has been still for a moment, never on the first digit. Not on leaving the
  // field: the line it adds would move the card under the press that left it (the trust box's tick).
  const text = field?.text ?? '';
  const [settled, setSettled] = useState(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a pause after each change of the text
  useEffect(() => {
    setSettled(false);
    const timer = setTimeout(() => setSettled(true), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [text]);
  const problem = field?.problem && settled ? field.problem : null;

  const keeper = trust?.keeper ?? true;
  const live = chainIsLive(chain);
  const accepted = trust
    ? trustAccepted(trust.userId, TRUST_STATUS.textVersion, keeper, live)
    : true;
  const trustHeld = trust ? !accepted && !ticked : false;
  const held = action.held === true || action.reasons.length > 0 || trustHeld || locked;
  const describedBy =
    [
      problem ? `${amountId}-problem` : null,
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

  const modes: readonly AmountMode[] = ['deposit', 'withdraw'];
  const choosable = into?.onChange !== undefined && into.options.length > 1;
  // What the figures are, in the kit's one quiet pill, as the portfolio board says it (MOCK-QUIET):
  // "Test network" for a test network's real reads, "Sample figures" for the mock's. Beside the
  // amount's label, or in the head where there is no amount. The long line of BUY-STEPS is the order
  // card's, after the press.
  const plate =
    provenance === 'sandbox' ? (
      <Plate ui="data-note">{t.shell.testNetworkLine}</Plate>
    ) : provenance === 'mock' ? (
      <Plate ui="sample-plate">{t.shell.mockAnnounce}</Plate>
    ) : null;
  const tabs = onMode && (
    <fieldset data-ui="amount-modes" className="inline-flex rounded-md border border-input p-0.5">
      <legend className="sr-only">{a.modes.label}</legend>
      {modes.map((m) => (
        <button
          key={m}
          type="button"
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
  );
  return (
    // A panel of the house kit (HOUSE-KIT): its head names the action, Deposit | Withdraw on its
    // right; the amount and what it leads to; then what stands between the person and the press.
    <Panel
      as="section"
      aria-labelledby={titleId}
      data-ui="amount-panel"
      data-provenance={provenance ?? undefined}
      className={cn('@container/amount w-full', className)}
    >
      <PanelHead
        id={titleId}
        level={headingLevel}
        title={title ?? a.modes[mode]}
        {...(tabs ? { tabs } : {})}
        actions={
          (!field && plate) || leave ? (
            <>
              {!field && plate}
              {leave && (
                <Button
                  variant="link"
                  data-action="leave-action"
                  className="text-body-sm"
                  onClick={leave.onLeave}
                >
                  {leave.label}
                </Button>
              )}
            </>
          ) : undefined
        }
      />
      <PanelBody>
        {/* Desktop first: in a card as wide as its pane, the amount on the left and what it leads to on
            the right, as the portfolio board sets its figure beside its chart; one column when narrow. */}
        <div
          data-ui="amount-card"
          data-mode={mode}
          className={cn(
            'grid min-w-0 gap-x-8 gap-y-4',
            preview && '@2xl/amount:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]',
          )}
        >
          <div className="flex min-w-0 flex-col gap-4">
            {into && (
              <div data-ui="amount-into" className="flex min-w-0 flex-col gap-1.5">
                <div className="flex min-w-0 items-center justify-between gap-3">
                  {choosable ? (
                    <label htmlFor={intoId} className="shrink-0 text-body-sm text-muted-foreground">
                      {into.label}
                    </label>
                  ) : (
                    <span className="shrink-0 text-body-sm text-muted-foreground">
                      {into.label}
                    </span>
                  )}
                  {choosable ? (
                    <span className="relative min-w-0">
                      <select
                        id={intoId}
                        value={into.value}
                        disabled={locked}
                        aria-describedby={into.hint ? intoHintId : undefined}
                        onChange={(e) => into.onChange?.(e.currentTarget.value)}
                        className={cn(
                          'h-9 max-w-full appearance-none truncate rounded-md border border-input bg-card pr-9 pl-3 text-body-sm font-medium text-foreground',
                          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                          'hover:bg-secondary disabled:text-muted-foreground',
                        )}
                      >
                        {into.options.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                      <Icon
                        name="ChevronDown"
                        size={16}
                        className="pointer-events-none absolute top-2.5 right-3 text-muted-foreground"
                      />
                    </span>
                  ) : (
                    <IntoValue option={into.options.find((o) => o.value === into.value)} />
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
              <AmountWell
                id={amountId}
                label={field.label}
                text={field.text}
                onText={field.onText}
                token={field.token}
                balance={field.balance}
                chips={field.chips}
                chipsLabel={field.chipsLabel}
                problem={problem}
                note={!problem && field.note && settled ? field.note : null}
                plate={plate}
                locked={locked}
              />
            )}

            {choice}
          </div>

          {preview && (
            <div data-ui="amount-preview" className="flex min-w-0 flex-col gap-1.5">
              <p className="text-body-sm font-medium text-muted-foreground">{preview.title}</p>
              {preview.body}
            </div>
          )}
        </div>
      </PanelBody>
      <PanelBody className="border-t border-border">
        <div className="flex min-w-0 flex-col gap-4">
          {details && details.length > 0 && (
            // The figures behind one fold, in a grid as the portfolio board sets them: one click away,
            // and the card's button stays in sight with its amount.
            <details data-ui="amount-details" className="group">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-sm text-body-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
                <span className="font-medium">{a.details.summary}</span>
                <Icon
                  name="ChevronDown"
                  size={16}
                  className="transition-transform group-open:rotate-180"
                />
              </summary>
              <div className="mt-3">
                <StatGrid>
                  {details.map((d) => (
                    <PanelStat key={d.term} label={d.term} wide={d.wide}>
                      <span className="[overflow-wrap:anywhere]">{d.value}</span>
                    </PanelStat>
                  ))}
                </StatGrid>
              </div>
              {more && (
                <div data-ui="amount-more" className="mt-3 flex flex-col gap-2 text-body-sm">
                  <p className="font-medium">{more.label}</p>
                  {more.body}
                </div>
              )}
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
                className="rounded-md border border-border px-3.5 py-3"
              >
                <TrustCompact
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
                    <TrustCompact
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
            {foot && (
              <div data-ui="amount-foot" className="pt-1 text-body-sm">
                {foot}
              </div>
            )}
          </div>
        </div>
      </PanelBody>
    </Panel>
  );
}

/** The one place money goes or comes from, by name, with what lies under the name on hover. */
function IntoValue({ option }: { option: IntoOption | undefined }) {
  if (!option) return null;
  const name = <span className="min-w-0 truncate text-body-sm font-medium">{option.label}</span>;
  return option.title ? (
    <Hint tip={<span className="font-mono text-source break-all">{option.title}</span>}>
      {name}
    </Hint>
  ) : (
    name
  );
}
