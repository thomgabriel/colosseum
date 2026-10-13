'use client';
import type { ChainId, Target } from '@colosseum/schemas';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { useT } from '../../i18n/I18nProvider';
import { keepOrder } from '../order/order-record';
import { displayName } from '../order/plain';
import { onMock } from '../order/readiness';
import { useApiFetch, useWalletPort } from '../wallet/WalletProvider';
import { isVaultOf } from './chain-recipe';
import { type RebalanceFailure, rebalanceVault } from './rebalance-api';
import type { SharedTerms } from './terms';

// The first moment of "Rebalance" on a vault's own page: our server is asked for the order that brings
// the vault to the targets it has (rebalance-api.ts), and the pane's host is handed it. Nothing is
// typed and nothing is chosen: the press on the page is the ask, and the order's own screen is the
// review, with every trade and its minimum, before anything is signed. The order is kept with what it
// is held to: the vault, and the targets this page read, which the trades may reach and no other.

type State =
  | { kind: 'asking' }
  | { kind: 'on-target' }
  | { kind: 'failed'; sentence: string; again: boolean };

export function RebalanceStart({
  chain,
  vault,
  targets,
  onOrder,
}: {
  chain: ChainId;
  vault: { address: string; owner: string; basketId: string };
  /** The vault's targets above zero, as the page read them. */
  targets: Target[];
  onOrder: (orderId: string) => void;
}) {
  const t = useT();
  const r = t.shared.vault.page.rebalancing;
  const api = useApiFetch();
  const port = useWalletPort();
  const [state, setState] = useState<State>({ kind: 'asking' });
  const [round, setRound] = useState(0);
  // One ask per press: a pane mounted twice in development asks once.
  const asked = useRef<number | null>(null);
  const handed = useRef(onOrder);
  handed.current = onOrder;

  // biome-ignore lint/correctness/useExhaustiveDependencies: asked once per opening, and again on "Try again"
  useEffect(() => {
    if (asked.current === round) return;
    asked.current = round;
    let mine = true;
    let answered = false;
    setState({ kind: 'asking' });
    const say = (failure: RebalanceFailure): State => {
      if (failure.kind === 'refused') {
        const unpriced = failure.issues
          .filter((issue) => issue.startsWith('NO_PRICE:'))
          .map((issue) => displayName(issue.slice('NO_PRICE:'.length), t.plan));
        if (failure.issues.includes('AUTO_FOLLOW_ON'))
          return { kind: 'failed', sentence: r.keeper, again: false };
        if (failure.issues.includes('NO_TARGETS'))
          return { kind: 'failed', sentence: r.noTargets, again: false };
        if (unpriced.length)
          return { kind: 'failed', sentence: r.noPrice(unpriced.join(', ')), again: true };
        return { kind: 'failed', sentence: r.said(failure.error), again: true };
      }
      if (failure.kind === 'not-yours' || failure.kind === 'signed-out')
        return { kind: 'failed', sentence: r.notYours, again: false };
      if (failure.kind === 'read-only')
        return { kind: 'failed', sentence: r.readOnly, again: false };
      if (failure.kind === 'busy')
        return { kind: 'failed', sentence: t.shell.slowDown, again: true };
      return { kind: 'failed', sentence: r.unreachable, again: true };
    };
    (async () => {
      // The plan number the steps name has to be this vault's own, as the guard derives its address.
      if (
        !port.userId ||
        isVaultOf(chain, onMock(port, chain), vault.owner, vault.basketId, vault.address) === false
      ) {
        answered = true;
        return setState({ kind: 'failed', sentence: r.notYours, again: false });
      }
      const answer = await rebalanceVault(api, chain, vault.address, vault.owner);
      if (!mine) return;
      answered = true;
      if (answer.kind !== 'ok') return setState(say(answer));
      if (answer.value.status === 'on_target') return setState({ kind: 'on-target' });
      const terms: SharedTerms = {
        kind: 'rebalance',
        vault: vault.address,
        basketId: vault.basketId,
        targets,
        trades: answer.value.order.legs
          .slice()
          .sort((a, b) => a.seq - b.seq)
          .flatMap((leg) => leg.trades),
      };
      const kept = keepOrder({
        orderId: answer.value.order.id,
        userId: port.userId,
        proposalId: '',
        chain,
        amountUsd: 0,
        lines: [],
        terms,
        approved: null,
      });
      if (!kept) return setState({ kind: 'failed', sentence: r.noStore, again: false });
      handed.current(answer.value.order.id);
    })();
    return () => {
      mine = false;
      if (!answered) asked.current = null;
    };
  }, [api, chain, vault.address, vault.owner, vault.basketId, round]);

  if (state.kind === 'asking')
    return (
      <p data-ui="rebalance-asking" role="status" className="text-body-sm text-muted-foreground">
        {r.preparing}
      </p>
    );
  if (state.kind === 'on-target')
    return (
      <p
        data-ui="rebalance-on-target"
        role="status"
        className="max-w-(--tf-measure-body) text-body"
      >
        {r.onTarget}
      </p>
    );
  return (
    <div data-ui="rebalance-failed" className="flex flex-col items-start gap-3">
      <p role="alert" className="max-w-(--tf-measure-body) text-body-sm text-destructive">
        {state.sentence}
      </p>
      {state.again && (
        <Button
          variant="secondary"
          data-action="rebalance-again"
          onClick={() => setRound((n) => n + 1)}
        >
          {r.again}
        </Button>
      )}
    </div>
  );
}
