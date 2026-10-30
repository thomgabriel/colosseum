'use client';
import type { ChainId } from '@colosseum/schemas';
import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { StatusMark } from '../../components/ui/StatusMark';
import { useLang, useT } from '../../i18n/I18nProvider';
import { dollars } from '../goal/sheet';
import { useApiFetch } from '../wallet/WalletProvider';
import { useTestFundsWords } from './FundingStep';
import { MAX_USD } from './limits';
import { requestTestFunds, TEST_SEND, TEST_SEND_COVERS, type TestFundsOutcome } from './order-api';
import { gasUnitsFor } from './readiness';
import { unitsFor } from './units';

// The faucet at the top of the deposit card, on a test network where our server sends test funds
// (gate FAUCET-TOP, Thom, Oct 30): before any amount is typed, one press asks for up to one send of
// test dollars and the gas a new vault needs, on the person's current chain (POST /v1/testnet/fund
// with no buy named). Once a plan is stored the press names it, so the server sizes the gas for that
// vault's own steps: a vault of many holdings needs more than a top-up leaves. Where that much gas is
// over one send's ceiling, as for 16 holdings from an empty wallet, the press falls back to a top-up,
// and the next one names the plan for the rest. What arrived, or why nothing did, is said under it.
// The card's host shows it only where the wallet's read says test funds are offered, and the funds
// step further down then has no button of its own: one faucet on the screen.

export function TestFundsTop({
  chain,
  mock,
  owner,
  haveUsd,
  plan,
  onSent,
}: {
  chain: ChainId;
  mock: boolean;
  /** The wallet that signs on this chain: what is funded. */
  owner: string;
  /** The wallet's dollars as last read: each press asks for one send over them. Null: not read. */
  haveUsd: number | null;
  /** The plan stored for what is on the card, and its amount. Null: no buy to name yet. */
  plan: { proposalId: string; amountUsd: number } | null;
  /** A send was answered, whether or not it arrived: the host reads the wallet again. */
  onSent: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const apiFetch = useApiFetch();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<TestFundsOutcome | null>(null);
  const units = unitsFor(chain, mock);
  const cashUnits = units ? (units.tokens[units.cash] ?? null) : null;
  const { sent, failed } = useTestFundsWords(outcome, cashUnits, gasUnitsFor(chain), true);

  async function ask() {
    setBusy(true);
    setOutcome(null);
    // one send over what the wallet holds, so a second press adds as much again
    const oneSend = Math.min(Math.floor(haveUsd ?? 0) + TEST_SEND_COVERS, MAX_USD);
    const topUp = () => requestTestFunds(apiFetch, { amountUsd: oneSend, wallet: owner });
    let answer: TestFundsOutcome;
    if (plan) {
      // never over the plan's own amount, which is the most a deposit into it may be
      answer = await requestTestFunds(apiFetch, {
        proposalId: plan.proposalId,
        amountUsd: Math.min(plan.amountUsd, oneSend),
        wallet: owner,
      });
      if (answer.kind === 'too-much') answer = await topUp();
    } else answer = await topUp();
    setBusy(false);
    setOutcome(answer);
    onSent();
  }

  return (
    <div
      data-ui="test-funds-top"
      className="flex min-w-0 flex-col items-start gap-3 border-b border-border pb-5"
    >
      <p className="max-w-(--tf-measure-body) text-body-sm">{t.buy.funding.testTop}</p>
      <Button
        variant="secondary"
        data-action="test-funds-top"
        busy={busy}
        busyLabel={t.buy.funding.testFunding}
        onClick={() => void ask()}
      >
        {/* with a plan named, it sends what that deposit is missing: no amount is promised */}
        {plan
          ? t.buy.funding.testFunds
          : t.buy.funding.testFundsUpTo(dollars(TEST_SEND.maxUsd, lang))}
      </Button>
      <div aria-live="polite" className="flex flex-col gap-1">
        {sent && (
          <p data-ui="test-funds-sent" className="max-w-(--tf-measure-body) text-body-sm">
            {sent}
          </p>
        )}
        {failed && (
          <p
            role="alert"
            className="flex max-w-(--tf-measure-body) items-start gap-1.5 text-body-sm text-destructive"
          >
            <StatusMark status="off-track" size={12} className="mt-1.5" />
            <span>{failed}</span>
          </p>
        )}
      </div>
      <p className="max-w-(--tf-measure-body) text-caption text-muted-foreground">
        {t.buy.funding.testNote}
      </p>
    </div>
  );
}
