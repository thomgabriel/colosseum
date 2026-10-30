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
// with no buy named). What arrived, or why nothing did, is said under it in the words the funds step
// uses. The card's host shows it only where the wallet's read says test funds are offered, and the
// funds step further down then has no button of its own: one faucet on the screen.

export function TestFundsTop({
  chain,
  mock,
  owner,
  haveUsd,
  onSent,
}: {
  chain: ChainId;
  mock: boolean;
  /** The wallet that signs on this chain: what is funded. */
  owner: string;
  /** The wallet's dollars as last read: each press asks for one send over them. Null: not read. */
  haveUsd: number | null;
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
  const { sent, failed } = useTestFundsWords(outcome, cashUnits, gasUnitsFor(chain));

  async function ask() {
    setBusy(true);
    setOutcome(null);
    const answer = await requestTestFunds(apiFetch, {
      // one send over what the wallet holds, so a second press adds as much again
      amountUsd: Math.min(Math.floor(haveUsd ?? 0) + TEST_SEND_COVERS, MAX_USD),
      wallet: owner,
    });
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
        {t.buy.funding.testFundsUpTo(dollars(TEST_SEND.maxUsd, lang))}
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
