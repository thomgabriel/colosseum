'use client';
import type { ChainId } from '@colosseum/schemas';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useLang, useT } from '../../i18n/I18nProvider';
import { useAccount } from '../account/AccountProvider';
import { switchFailure } from '../account/chain-failure';
import { dollars as goalDollars } from '../goal/sheet';
import { recallOrders } from '../order/order-record';
import { goalLine } from '../order/plain';
import { vaultValueSource } from '../portfolio/portfolio';
import type { PortfolioState } from '../portfolio/use-portfolio';
import { goalOfVault } from '../portfolio/vault-goal';
import { vaultTitle as nameOfVault } from '../portfolio/vault-name';
import { type PlansAnswer, readPlans } from '../portfolio-section/api';
import { snapshotPin } from '../portfolio-section/pins';
import { vaultTitle } from '../portfolio-section/vault-title';
import { useWords } from '../portfolio-section/words';
import { readLocal } from '../vault-conversation/storage';
import { useApiFetch, useWalletPort } from '../wallet/WalletProvider';
import { ConversationRail, ConversationSheet } from './ConversationRail';
import { type DraftRow, mergeRows, type VaultRow } from './conversation-list';
import {
  type ConversationIndex,
  conversationName,
  conversationStoreKey,
  deleteConversation,
  depositPlan,
  linkPlan,
  newConversationId,
  readIndex,
  renameConversation,
  type SavedConversation,
  touch,
  writeIndex,
} from './conversations';
import { GoalChain, plannable } from './GoalChain';
import { GoalConversation, goalConversationKey, LeaveDeposit } from './GoalConversation';

const NONE: ConversationIndex = { current: 'main', items: [] };

/**
 * `/invest` is the strategy conversation, keyed to the person, the chain of the plan and its network.
 * Beside it the conversations panel (ConversationRail, Thom, Oct 14; the picker before it was Rodrigo's,
 * Oct 8) lists the person's drafts kept in this browser and their vaults, each with its chain: the list
 * mixes chains (gate CHAIN-AT-THE-PLAN). A draft is named by the name the person gave it, else its first
 * request (title.ts); a vault by its goal, as the portfolio overview names it, and it opens its own
 * page, where its owner-only conversation is (VaultScreen). A draft a deposit went from is listed as the
 * vault that deposit opened. The chain of a new plan is chosen beside the box (GoalChain). Guided
 * investing is not offered here (staging #195).
 */
export function GoalEntry({ portfolio }: { portfolio: PortfolioState }) {
  const t = useT();
  const w = t.goal.explore.picker;
  const words = useWords();
  const apiFetch = useApiFetch();
  const pickerId = useId();
  // On a phone the panel's button is drawn in the conversation's head (PAGE-SHELL), which is keyed and
  // drawn again on a pick, a change of chain or a sign-in. Focus that was on it, or in its sheet, goes
  // back to it in the new head, not to the page's body: this holds the key it was on then.
  const pickerHeld = useRef<string | null>(null);
  const { account, chain: current, choose, view } = useAccount();
  const port = useWalletPort();
  // A deposit is open on the conversation's pane (approved, not every step confirmed; fresh, stopped
  // or taken up again after a reload). The conversation then stays on the deposit's chain whatever
  // moves the account's (another tab, the person read again): a plan lives on one chain, and its pane is
  // not taken from under its steps. Every way this page itself leaves it asks first.
  const [deposit, setDeposit] = useState<{
    open: boolean;
    signing: boolean;
    chain: ChainId | null;
  }>({ open: false, signing: false, chain: null });
  const [pending, setPending] = useState<{ go: () => void } | null>(null);
  // The conversation has its draft beside it: the rail folds to give it the room.
  const [drafting, setDrafting] = useState(false);
  const chain = deposit.open && deposit.chain ? deposit.chain : current;
  const shown = useRef(chain);
  shown.current = chain;
  /** Leaves the open deposit, by the person's word: the pane goes with the conversation. */
  const leave = () => setDeposit({ open: false, signing: false, chain: null });
  const network = chain ? port.network(chain) : null;
  const userId = port.userId;
  /** Where this browser keeps the person's conversations of one chain and its network. */
  const baseOf = (on: ChainId) => {
    const provenance = port.network(on)?.provenance;
    return userId && provenance ? goalConversationKey(userId, on, provenance) : null;
  };
  const base = chain ? baseOf(chain) : null;
  // The other chains a plan of theirs can start on: their saved conversations are listed too.
  const others = plannable(account, port).filter((on) => on !== chain);
  const otherBases = others.map((on) => `${on}=${baseOf(on) ?? ''}`).join('|');
  // The index is the one of the chain on screen from the first render on that chain: a conversation of
  // the chain before is never drawn on this one, not even for a frame.
  const [held, setHeld] = useState<{ base: string | null; index: ConversationIndex }>({
    base: null,
    index: NONE,
  });
  const index = held.base === base ? held.index : base ? readIndex(base) : NONE;
  const setIndex = (next: ConversationIndex) => setHeld({ base, index: next });
  const [elsewhere, setElsewhere] = useState<
    { chain: ChainId; base: string; item: SavedConversation }[]
  >([]);
  useEffect(() => {
    setHeld({ base, index: base ? readIndex(base) : NONE });
    setElsewhere(
      otherBases.split('|').flatMap((pair) => {
        const [on, key] = pair.split('=') as [ChainId, string | undefined];
        return key ? readIndex(key).items.map((item) => ({ chain: on, base: key, item })) : [];
      }),
    );
  }, [base, otherBases]);
  // The person's vaults, as the portfolio overview reads them: its title for each, its newest value
  // with its pin, and the plan it was opened from. Read again when a deposit on this page closes.
  const lang = useLang();
  const signedIn = port.status === 'ready' && account.status === 'ready' && Boolean(userId);
  const [plans, setPlans] = useState<PlansAnswer | null>(null);
  const [readAgain, setReadAgain] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `readAgain` asks for the vaults again
  useEffect(() => {
    if (!signedIn) {
      setPlans(null);
      return;
    }
    let live = true;
    readPlans(apiFetch).then(
      (read) => {
        if (live) setPlans(read.kind === 'read' ? read.answer : null);
      },
      () => {
        if (live) setPlans(null);
      },
    );
    return () => {
      live = false;
    };
  }, [signedIn, userId, apiFetch, readAgain]);
  // What the panel lists: each draft by the name given it, else by its first request ("New
  // conversation" while the one on screen has no words), and each vault by its goal.
  const [now, setNow] = useState(() => Date.now());
  // biome-ignore lint/correctness/useExhaustiveDependencies: a deposit that opens or closes writes or takes away the ids a draft keeps (`depositing`), read from this browser
  const rows = useMemo(() => {
    const draft = (
      on: ChainId,
      at: string,
      item: SavedConversation | null,
      id: string,
      current: boolean,
    ): DraftRow => {
      const written = item ? Date.parse(item.updatedAt) : Number.NaN;
      return {
        kind: 'draft',
        key: `draft:${on}:${id}`,
        chain: on,
        base: at,
        id,
        title: item?.name || conversationName(at, id, current ? w.current : w.untitled),
        at: Number.isFinite(written) ? written : null,
        current,
        planId: item?.planId ?? depositPlan(at, id),
        kept: item !== null,
        depositing: depositPlan(at, id) !== null,
      };
    };
    const drafts: DraftRow[] = [
      ...(chain && base
        ? [
            draft(
              chain,
              base,
              index.items.find((item) => item.id === index.current) ?? null,
              index.current,
              true,
            ),
            ...index.items
              .filter((item) => item.id !== index.current)
              .map((item) => draft(chain, base, item, item.id, false)),
          ]
        : []),
      // another chain's, read while that chain was not the one on screen: never this chain's again
      ...elsewhere
        .filter(({ base: at }) => at !== base)
        .map(({ chain: on, base: at, item }) => draft(on, at, item, item.id, false)),
    ];
    // Every vault the portfolio read lists, and any the plans read lists besides: the plans read names
    // it, times it and values it where it can, as the overview does; else its own name, its goal as
    // this browser's orders kept it, or its number, and its value as the portfolio read priced it.
    const planned = new Map(
      (plans?.chains ?? []).flatMap((entry) =>
        entry.plans.map(
          (plan) => [String(`${plan.chain}:${plan.address}`), { entry, plan }] as const,
        ),
      ),
    );
    const records = recallOrders(userId);
    const chainName = (on: ChainId) => port.network(on)?.name ?? t.chain.names[on];
    const read =
      portfolio.kind === 'answered' && portfolio.outcome.kind === 'read'
        ? portfolio.outcome.chains.flatMap((entry) =>
            entry.vaults.map((vault) => ({ entry, vault })),
          )
        : [];
    const fromPlan = (key: string): VaultRow | null => {
      const found = planned.get(key);
      if (!found) return null;
      const { entry, plan } = found;
      const placed = plan.plan ? Date.parse(plan.plan.placedAt) : Number.NaN;
      return {
        kind: 'vault',
        key: `vault:${key}`,
        chain: plan.chain,
        address: plan.address,
        title: vaultTitle(plan, {
          t,
          words: words.overview.card,
          lang,
          chainName: chainName(plan.chain),
        }).sentence,
        at: Number.isFinite(placed) ? placed : null,
        current: false,
        value: plan.newest
          ? {
              usd: plan.newest.valueUsd,
              obs: snapshotPin(plan.newest, entry.provenance, plan.provenance),
            }
          : null,
        planId: plan.plan?.proposalId ?? null,
      };
    };
    const vaults: VaultRow[] = [
      ...read.map(({ entry, vault }) => {
        const key = `${vault.chain}:${vault.address}`;
        const known = fromPlan(key);
        const goal = goalOfVault(vault, records)?.goal.sheet;
        return {
          kind: 'vault' as const,
          key: `vault:${key}`,
          chain: vault.chain,
          address: vault.address,
          title:
            known?.title ??
            vault.name ??
            (goal
              ? goalLine(goal, t, goalDollars(goal.amountUsd, lang), (usd) =>
                  goalDollars(usd, lang),
                )
              : nameOfVault(vault, t.portfolio.actions, chainName(vault.chain))),
          at: known?.at ?? null,
          current: false as const,
          value: known?.value ?? {
            usd: vault.valueUsd,
            obs: vaultValueSource(entry, vault, t.portfolio.vault.valueMethod),
          },
          planId: known?.planId ?? vault.planId ?? null,
        };
      }),
      ...[...planned.keys()]
        .filter((key) => !read.some(({ vault }) => `${vault.chain}:${vault.address}` === key))
        .flatMap((key) => fromPlan(key) ?? []),
    ];
    return mergeRows(drafts, vaults);
  }, [base, chain, index, elsewhere, plans, portfolio, userId, lang, t, w, words, port, deposit]);
  // How long ago each row was written is said against a clock that moves while the page is open.
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(tick);
  }, []);
  // The chain was moved from the control beside the box: focus goes back to it once it is drawn again.
  const refocus = useRef(false);
  const [said, setSaid] = useState('');
  // A saved conversation of another chain was opened, which moved where new plans start: said on
  // the page, and so is a move that was not stored.
  const [moved, setMoved] = useState('');
  const [problem, setProblem] = useState('');
  const root = useRef<HTMLDivElement>(null);
  // Words typed before the first message go with a change of chain made beside the box.
  const carried = useRef<{ chain: ChainId; text: string } | null>(null);
  useEffect(() => {
    if (carried.current && carried.current.chain !== chain) carried.current = null;
  }, [chain]);
  const nameOf = (on: ChainId) => port.network(on)?.name ?? t.chain.names[on];

  /** A new plan on `next`: the chain is stored, and an empty conversation opens there. */
  async function startOn(next: ChainId, sure = false) {
    if (deposit.open && !sure) {
      setPending({ go: () => void startOn(next, true).catch(() => {}) });
      return;
    }
    if (sure) leave();
    const there = baseOf(next);
    if (there) {
      const kept = readIndex(there);
      // The conversation last open there has words: it stays saved, and a new one takes its place.
      if (readLocal(conversationStoreKey(there, kept.current)).transcript.length > 0)
        writeIndex(there, { ...kept, current: newConversationId() });
    }
    refocus.current = true;
    carried.current = {
      chain: next,
      text:
        root.current?.querySelector<HTMLTextAreaElement>('[data-ui="goal-chat"] textarea')?.value ??
        '',
    };
    setMoved('');
    setProblem('');
    try {
      await choose(next);
    } catch (e) {
      carried.current = null;
      throw e;
    }
    setSaid(t.chain.choice.done(nameOf(next)));
  }

  function pick(value: string, sure = false) {
    if (deposit.open && !sure && value !== 'current')
      return setPending({ go: () => pick(value, true) });
    if (sure) leave();
    carried.current = null;
    setMoved('');
    setProblem('');
    if (value === 'new' && base) {
      // The conversation on screen stays in the saved list; a new, empty one takes its place.
      const next = { ...index, current: newConversationId() };
      writeIndex(base, next);
      setIndex(next);
      return;
    }
    if (value.startsWith('conversation:')) {
      const [, on, id] = value.split(':') as [string, ChainId, string];
      const there = baseOf(on);
      if (!there || !id) return;
      if (on === chain) {
        const next = { ...index, current: id };
        writeIndex(there, next);
        setIndex(next);
        return;
      }
      // A conversation of another chain is opened on its chain: a plan never changes chain.
      writeIndex(there, { ...readIndex(there), current: id });
      choose(on).then(
        () => setMoved(t.chain.choice.opened(nameOf(on))),
        (e: unknown) => setProblem(switchFailure(t, e, nameOf(on))),
      );
      return;
    }
  }
  /** A draft renamed in the panel: the index of its own chain keeps the name. */
  function rename(row: DraftRow, name: string) {
    const kept = renameConversation(row.base, readIndex(row.base), row.id, name);
    if (row.base === base) setIndex(kept);
    else
      setElsewhere((now) =>
        now.map((one) =>
          one.base === row.base
            ? { ...one, item: kept.items.find((item) => item.id === one.item.id) ?? one.item }
            : one,
        ),
      );
  }
  /**
   * A draft deleted from this browser, and said; the one on screen gives way to a new, empty one. One
   * with a deposit's ids kept beside it is not deleted (`deleteConversation`): the panel says so first.
   */
  function remove(row: DraftRow) {
    const was = readIndex(row.base);
    const kept = deleteConversation(row.base, was, row.id);
    if (kept === was) return;
    setSaid(w.removed(row.title));
    if (row.base === base) setIndex(kept);
    else
      setElsewhere((now) =>
        now.filter((one) => !(one.base === row.base && one.item.id === row.id)),
      );
  }
  // The panel's rows and what it does, for the rail and for the phone's sheet alike.
  const panel = {
    rows,
    now,
    onNew: () => pick('new'),
    onOpen: (row: DraftRow) => {
      if (!row.current) pick(`conversation:${row.chain}:${row.id}`);
    },
    onRename: rename,
    onDelete: (row: DraftRow) => remove(row),
  };
  const headKey = `${port.userId}:${chain}:${network?.provenance}:${index.current}`;
  // after every draw of the head
  useEffect(() => {
    const held = pickerHeld.current;
    if (held === null || held === headKey) return;
    pickerHeld.current = null;
    const button = document.getElementById(pickerId);
    if (button && document.activeElement !== button) button.focus();
  });
  return (
    <div className="flex min-w-0 flex-col gap-4 md:min-h-0 md:flex-1 lg:grid lg:grid-cols-[auto_minmax(0,1fr)] lg:gap-6">
      <ConversationRail {...panel} drafting={drafting} />
      <div ref={root} className="flex min-w-0 flex-col gap-4 md:min-h-0 md:flex-1">
        <span role="status" data-ui="goal-chain-said" className="sr-only">
          {said}
        </span>
        {pending && deposit.open && (
          <LeaveDeposit
            signing={deposit.signing}
            onLeave={() => {
              const { go } = pending;
              setPending(null);
              go();
            }}
            onStay={() => setPending(null)}
          />
        )}
        {/* There before its words, so a screen reader hears them when they come. */}
        <p
          role="status"
          data-ui="goal-chain-moved"
          className={moved ? 'text-caption text-muted-foreground' : 'sr-only'}
        >
          {moved}
        </p>
        {problem && (
          <p role="alert" data-ui="goal-chain-problem" className="text-caption text-destructive">
            {problem}
          </p>
        )}
        <GoalConversation
          key={headKey}
          account={view}
          userId={port.userId}
          chain={chain}
          provenance={network?.provenance ?? null}
          ready={port.status === 'ready' && account.status === 'ready' && network?.on === true}
          conversationId={index.current}
          onSaved={(title) => {
            if (!base) return;
            setHeld((now) => {
              const was = now.base === base ? now.index : readIndex(base);
              return { base, index: touch(base, was, was.current, title) };
            });
          }}
          carried={carried}
          onDrafting={setDrafting}
          // Under 1024px the panel is a sheet, opened from this button in the conversation's title row.
          picker={
            <ConversationSheet
              {...panel}
              id={pickerId}
              onChosen={() => {
                pickerHeld.current = headKey;
              }}
            />
          }
          onDeposit={(state) => {
            // The plan a deposit from this conversation is for: the vault it opens stands for it in the
            // panel, once that vault is read.
            if (state.planId && base)
              setHeld((now) => {
                const was = now.base === base ? now.index : readIndex(base);
                return { base, index: linkPlan(base, was, was.current, state.planId as string) };
              });
            // a deposit that closes may have opened a vault: the panel reads them again
            if (deposit.open && !state.open) setReadAgain((n) => n + 1);
            setDeposit((now) => {
              return state.open
                ? {
                    open: true,
                    signing: state.signing,
                    chain: now.open ? now.chain : shown.current,
                  }
                : now.open
                  ? { open: false, signing: false, chain: null }
                  : now;
            });
          }}
          chainControl={(state) => (
            <GoalChain {...state} on={chain} refocus={refocus} onChoose={startOn} />
          )}
        />
      </div>
    </div>
  );
}
