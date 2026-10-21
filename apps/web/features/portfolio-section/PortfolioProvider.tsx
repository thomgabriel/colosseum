'use client';
import { REBALANCES_MAX } from '@colosseum/schemas';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ApiFetch } from '../account/person';
import { onOrderDone } from '../order/order-done';
import { useApiFetch, useWalletPort } from '../wallet/WalletProvider';
import {
  type ExposureAnswer,
  type PlansAnswer,
  type RebalancesAnswer,
  readExposure,
  readPlans,
  readRebalances,
  type SectionRead,
} from './api';

// The reads of the portfolio section, held while a person moves between its pages: the plans, the
// exposure and the rebalances of the signed-in person, each asked once when they are known and again
// on "Read again", when the window has the focus back and when an order ends (order-done.ts). As the monitor reads (features/portfolio/use-portfolio.ts): an answer is kept under
// who asked for it and is shown to nobody else, and one that lands after the person changed is
// dropped. Each read stands on its own, so a route that fails leaves the other pages their answers.
// A plan's own page asks for its vault's history itself, with `useSectionRead`.

/** Who there is to read for. Nothing is asked until someone is signed in and their wallets are known. */
export type Person = 'loading' | 'signed-out' | 'signed-in';

/** One read as a page sees it: nobody to ask for, on its way, or what came of it. */
export type Reading<T> = { kind: 'idle' } | { kind: 'reading' } | SectionRead<T>;

export type PortfolioSection = {
  person: Person;
  /** The throwaway wallet of development, which a real API has no account for. */
  throwaway: boolean;
  /** GET /v1/portfolio/plans, for every vault of the person's. */
  plans: Reading<PlansAnswer>;
  /** GET /v1/portfolio/exposure, over every vault of the person's. */
  exposure: Reading<ExposureAnswer>;
  /** GET /v1/portfolio/rebalances, the newest `REBALANCES_ASKED` entries. */
  rebalances: Reading<RebalancesAnswer>;
  /** Asks all of them afresh, and every read a page made with `useSectionRead`. */
  again: () => void;
  /** True while a read of the provider's is on its way. */
  busy: boolean;
};

/** How many rebalance entries the section asks for: the most one answer has. */
export const REBALANCES_ASKED = REBALANCES_MAX;

type ReadFn<T> = (apiFetch: ApiFetch) => Promise<SectionRead<T>>;

// One object each, so a page that waits is not drawn again for nothing.
const IDLE = { kind: 'idle' } as const;
const READING = { kind: 'reading' } as const;

const allPlans: ReadFn<PlansAnswer> = (apiFetch) => readPlans(apiFetch);
const allExposure: ReadFn<ExposureAnswer> = (apiFetch) => readExposure(apiFetch);
const allRebalances: ReadFn<RebalancesAnswer> = (apiFetch) =>
  readRebalances(apiFetch, { limit: REBALANCES_ASKED });

/**
 * One question, asked for one person. It is asked once for each (`who`, `scope`, `round`), and what
 * comes back is kept under who asked and what was asked: an answer that lands for anybody or anything
 * else is dropped. While it is asked again the last answer for the same person and question stays.
 */
function useKeyedRead<T>(
  who: string | null,
  round: number,
  scope: string | null,
  read: ReadFn<T>,
  /** A round asked for by the window's focus or an ended order: a failed answer keeps the last read. */
  quiet = false,
): { reading: Reading<T>; busy: boolean } {
  const apiFetch = useApiFetch();
  const [answer, setAnswer] = useState<{
    who: string;
    scope: string;
    outcome: SectionRead<T>;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const wanted = useRef('');
  const held = useRef(answer);
  held.current = answer;
  // The call of the moment: a new function is not a new question, only a new `scope` is.
  const latest = useRef({ read, apiFetch });
  useEffect(() => {
    latest.current = { read, apiFetch };
  });

  const key = who !== null && scope !== null ? JSON.stringify([who, scope, round]) : '';
  // biome-ignore lint/correctness/useExhaustiveDependencies: `quiet` is how this round was asked, read as it starts
  useEffect(() => {
    wanted.current = key;
    // Nobody to read for, or nothing asked: nothing is on its way, whatever was.
    if (key === '' || who === null || scope === null) {
      setBusy(false);
      return;
    }
    setBusy(true);
    const kept = quiet;
    latest.current.read(latest.current.apiFetch).then((outcome) => {
      if (wanted.current !== key) return;
      const last = held.current;
      // Read again by itself, it answered no figures (busy, unreachable): the ones shown stay.
      const keep =
        kept &&
        outcome.kind !== 'read' &&
        last?.who === who &&
        last.scope === scope &&
        last.outcome.kind === 'read';
      if (!keep) setAnswer({ who, scope, outcome });
      setBusy(false);
    });
  }, [key, who, scope]);

  const same = answer !== null && answer.who === who && answer.scope === scope ? answer : null;
  const reading: Reading<T> = who === null || scope === null ? IDLE : same ? same.outcome : READING;
  return { reading, busy };
}

const SectionContext = createContext<PortfolioSection | null>(null);
/** Who is asked for and which round of asking it is: what a page's own read joins. */
const AskedContext = createContext<{ who: string | null; round: number; quiet: boolean } | null>(
  null,
);

/** The window's focus reads the section again at most this often. */
export const FOCUS_READ_MS = 30_000;

export function PortfolioProvider({ children }: { children: ReactNode }) {
  const port = useWalletPort();
  const [round, setRound] = useState(0);
  // A passkey sign-in that is still owed a wallet is `loading` with its person known: the server
  // answers the chains of the wallets it is shown, so nothing is asked until they are all there.
  const who = port.status === 'ready' ? port.userId : null;

  // Whether this round was asked for by the person ("Read again") or by itself (the focus, an order).
  const [quiet, setQuiet] = useState(false);
  const plans = useKeyedRead(who, round, 'plans', allPlans, quiet);
  const exposure = useKeyedRead(who, round, 'exposure', allExposure, quiet);
  const rebalances = useKeyedRead(who, round, 'rebalances', allRebalances, quiet);

  const asked = useRef(0);
  const again = useCallback(() => {
    asked.current = Date.now();
    setQuiet(false);
    setRound((n) => n + 1);
  }, []);
  // The figures change while the section is open: an order ends in this tab or another, or the person
  // comes back from another window. Each reads the section again for whoever is signed in, the focus
  // at most every 30 seconds; the answers on the screen stay until new ones land, and stay when the
  // new answer has no figures (busy, unreachable).
  useEffect(() => {
    if (who === null) return;
    asked.current = Date.now();
    const refresh = () => {
      asked.current = Date.now();
      setQuiet(true);
      setRound((n) => n + 1);
    };
    const focused = () => {
      if (Date.now() - asked.current >= FOCUS_READ_MS) refresh();
    };
    const stop = onOrderDone(refresh);
    window.addEventListener('focus', focused);
    return () => {
      stop();
      window.removeEventListener('focus', focused);
    };
  }, [who]);
  const person: Person =
    port.status === 'signed-out' ? 'signed-out' : who === null ? 'loading' : 'signed-in';
  const busy = plans.busy || exposure.busy || rebalances.busy;

  const section = useMemo<PortfolioSection>(
    () => ({
      person,
      throwaway: port.test,
      plans: plans.reading,
      exposure: exposure.reading,
      rebalances: rebalances.reading,
      again,
      busy,
    }),
    [person, port.test, plans.reading, exposure.reading, rebalances.reading, again, busy],
  );
  const askedFor = useMemo(() => ({ who, round, quiet }), [who, round, quiet]);

  return (
    <SectionContext.Provider value={section}>
      <AskedContext.Provider value={askedFor}>{children}</AskedContext.Provider>
    </SectionContext.Provider>
  );
}

/** The section's reads, for a page under `PortfolioProvider`. */
export function usePortfolioSection(): PortfolioSection {
  const section = useContext(SectionContext);
  if (!section) throw new Error('usePortfolioSection is used under <PortfolioProvider>');
  return section;
}

/**
 * A read of a page's own, for the signed-in person: a plan's page asks for its vault's history this
 * way, and may ask for the other routes narrowed to its vault. `scope` says what is asked, the route
 * and its query in one text: a new scope is a new question, and null asks nothing. `read` is called
 * once for each scope and each "Read again", with the API of the moment; it need not be the same
 * function between renders. The answer follows the provider's rule: kept for who asked, dropped when
 * the person or the scope moves.
 */
export function useSectionRead<T>(
  scope: string | null,
  read: (apiFetch: ApiFetch) => Promise<SectionRead<T>>,
): { reading: Reading<T>; busy: boolean } {
  const asked = useContext(AskedContext);
  if (!asked) throw new Error('useSectionRead is used under <PortfolioProvider>');
  return useKeyedRead(asked.who, asked.round, scope, read, asked.quiet);
}
