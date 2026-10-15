'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { HoneyFog } from '../../components/shell/HoneyFog';
import { CHAIN_NAMES } from '../../components/ui/ChainBadge';
import { cn } from '../../components/ui/cn';
import { Disclaimer } from '../../components/ui/Disclaimer';
import { formatAge } from '../../components/ui/format';
import { PAGE_TITLE } from '../../components/ui/heading';
import { Icon } from '../../components/ui/Icon';
import { Skeleton } from '../../components/ui/Skeleton';
import { MENU_BUTTON, MENU_MARK, MENU_ROW, MENU_TEXT } from '../../components/ui/side-menu';
import { Segmented } from '../../components/ui/TimeChart';
import { useLang } from '../../i18n/I18nProvider';
import { type Mode, useBearing } from './BearingProvider';
import { BEARING_CHAINS, isBearingChain, onChain } from './chain';
import { RISK_API } from './data';
import { hhmm } from './format';
import { href, METHODOLOGY, PAGES } from './pages';
import { useFmt, useWords } from './parts';
import { etLabel, regimeAt } from './time';

// The frame of Bearing's analytics (Rodrigo's Analytics 2.0): a retractable side menu beside the page,
// 220px open and a 56px rail closed, a bar with a drawer under 900px; the head with the page's one
// line and the banner that says whether the figures are live or stale; the disclaimer under the page.
// The menu remembers whether it was closed, on this browser only. It stays in view under the app's
// fixed bar (AppNav, his compact bar), as his sat under his.

const SIDE_KEY = 'tf-an2-side';
const NARROW = '(max-width: 899px)';
const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

export function BearingShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { chain } = useBearing();
  const t = useWords();
  const lang = useLang();
  const current = pathname.split('/')[2] ?? 'stocks';
  const page =
    current === METHODOLOGY
      ? t.pages.methodology
      : t.pages[PAGES.find((p) => p.id === current)?.id ?? 'stocks'];
  const [collapsed, setCollapsed] = useState(false);

  // On a phone the menu starts closed, as a drawer; elsewhere it opens as it was left.
  useEffect(() => {
    const narrow = window.matchMedia(NARROW).matches;
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(SIDE_KEY);
    } catch {
      // the menu works without storage
    }
    setCollapsed(narrow || saved === '1');
  }, []);
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(SIDE_KEY, next ? '1' : '0');
    } catch {
      // the menu works without storage
    }
  };
  const followed = () => {
    if (window.matchMedia(NARROW).matches && !collapsed) setCollapsed(true);
  };

  return (
    <div
      data-ui="bearing"
      data-collapsed={collapsed || undefined}
      className={cn(
        'grid grid-cols-[minmax(0,1fr)]',
        MENU_TEXT,
        collapsed
          ? 'min-[900px]:grid-cols-[56px_minmax(0,1fr)]'
          : 'min-[900px]:grid-cols-[220px_minmax(0,1fr)]',
      )}
    >
      <aside
        aria-label={t.menu.region}
        className="z-20 border-b border-border bg-card px-4 py-2 min-[900px]:sticky min-[900px]:top-[calc(env(safe-area-inset-top,0px)+80px)] min-[900px]:max-h-[calc(100dvh-96px)] min-[900px]:self-start min-[900px]:overflow-auto min-[900px]:border-r min-[900px]:border-b-0 min-[900px]:px-2 min-[900px]:py-3"
      >
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-controls="bearing-nav"
          onClick={toggle}
          className={cn(
            MENU_BUTTON,
            'min-[900px]:w-full',
            collapsed && 'min-[900px]:justify-center min-[900px]:px-0',
            FOCUS,
          )}
        >
          <Icon name="Menu" size={16} />
          <span className={cn(collapsed && 'min-[900px]:sr-only')}>
            {collapsed ? t.menu.show : t.menu.hide}
          </span>
        </button>
        <nav
          id="bearing-nav"
          aria-label={t.menu.nav}
          className={cn(collapsed && 'max-[899px]:hidden')}
        >
          <ul className="mt-2 grid list-none gap-0.5 p-0 min-[900px]:mt-4">
            {PAGES.map((p) => (
              <li key={p.id}>
                <Link
                  href={onChain(href(p.id), chain)}
                  title={t.pages[p.id].label}
                  onClick={followed}
                  aria-current={p.id === current ? 'page' : undefined}
                  className={cn(
                    MENU_ROW,
                    collapsed && 'min-[900px]:justify-center min-[900px]:px-0',
                    FOCUS,
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      MENU_MARK,
                      p.id === current ? 'text-foreground' : 'text-muted-foreground',
                    )}
                  >
                    {p.mark}
                  </span>
                  <span className={cn(collapsed && 'min-[900px]:sr-only')}>
                    {t.pages[p.id].label}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          <p className={cn('mt-6 px-2.5 text-caption', collapsed && 'min-[900px]:hidden')}>
            <Link
              href={onChain(href(METHODOLOGY), chain)}
              aria-current={current === METHODOLOGY ? 'page' : undefined}
              onClick={followed}
              className={cn(
                'inline-flex min-h-6 items-center underline decoration-1 underline-offset-[3px] hover:decoration-2',
                FOCUS,
              )}
            >
              {t.pages.methodology.label}
            </Link>
          </p>
        </nav>
      </aside>
      <div className="min-w-0 px-0 pt-2 min-[900px]:px-[clamp(16px,3vw,40px)] min-[900px]:pt-4">
        {/* The page's head on the honey fog, as the landing's hero (Rodrigo, Oct 8). */}
        <div
          data-ui="bearing-head"
          className="relative isolate -mx-3 overflow-hidden px-3 pt-4 pb-1 min-[900px]:mx-0 min-[900px]:rounded-lg"
        >
          <HoneyFog className="pointer-events-none absolute inset-0 -z-10 size-full" />
          <div className="font-condensed text-b-head font-medium text-muted-foreground">
            {t.head}
          </div>
          <h1 className={cn(PAGE_TITLE, 'mt-2 mb-4')}>{page.lede}</h1>
          <ChainToggle />
          <Banner />
        </div>
        {children}
        <Disclaimer lang={lang} heading={t.notAdvice} className="mt-8" />
      </div>
    </div>
  );
}

/** Which chain every figure on the page is read for: named in the address; the pages' own filter. */
export function ChainToggle() {
  const { chain, setChain } = useBearing();
  const t = useWords();
  return (
    <div data-ui="bearing-chain" className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
      <Segmented
        label={t.chain.label}
        options={BEARING_CHAINS.map((c) => ({ id: c, label: CHAIN_NAMES[c] }))}
        value={chain}
        onChange={(c) => {
          if (isBearingChain(c)) setChain(c);
        }}
      />
    </div>
  );
}

/** What a banner not shown lays out in place of the newest reading's time and its age. */
const STAND_IN_READING = '2026-01-01T00:00:00Z';
const STAND_IN_AGE_S = 4 * 3600;

/**
 * Live or stale, said once for the whole page; or that the API did not answer. Every state is laid out
 * in the same cell and only the one in force is seen, so the box is as tall as the tallest at any width
 * and in either language: nothing under it moves when the readings come, turn stale or stop.
 */
export function Banner() {
  const { mode, newest, clock } = useBearing();
  const t = useWords();
  const fm = useFmt();
  const w = t.banner;
  const now = new Date(clock.now || Date.parse(STAND_IN_READING));
  const time = newest ? hhmm(newest) : w.unknownTime;
  const longestRegime = Object.values(t.regimes).reduce((a, b) => (b.length > a.length ? b : a));
  const stale = (seen: boolean) =>
    newest || !seen
      ? w.stale(
          fm.second(newest ?? STAND_IN_READING),
          formatAge(newest ? (clock.now - Date.parse(newest)) / 1000 : STAND_IN_AGE_S)?.short ??
            w.unknownAge,
        )
      : w.noReading;
  const states: Record<Mode, (seen: boolean) => ReactNode> = {
    // While the readings come the page's own wait says in words what is awaited: here, two bars.
    loading: () => (
      <>
        <Skeleton className="mt-1 h-3.5 w-56 max-w-full" />
        <Skeleton className="mt-1 h-3 w-40 max-w-full" />
      </>
    ),
    live: (seen) => (
      <>
        <b className="font-semibold">{w.live(time)}</b>
        <span className="font-mono text-b-meta text-muted-foreground">
          {w.now(seen ? t.regimes[regimeAt(now)] : longestRegime, etLabel(now, t.heat.days))}
        </span>
      </>
    ),
    stale: (seen) => (
      <>
        <b className="font-semibold">{stale(seen)}</b>
        <span>{w.staleAll}</span>
      </>
    ),
    none: () => (
      <>
        <b className="font-semibold">{w.down(RISK_API)}</b>
        <span>{w.downAll}</span>
      </>
    ),
  };
  const loading = mode === 'loading';
  return (
    <div
      data-ui="bearing-banner"
      data-mode={mode}
      role={loading ? undefined : 'status'}
      aria-hidden={loading ? 'true' : undefined}
      className="mt-3 grid border border-l-2 border-border border-l-primary px-3 py-2"
    >
      {(Object.keys(states) as Mode[]).map((m) => (
        <div
          key={m}
          data-ui={m === mode ? 'bearing-banner-said' : undefined}
          aria-hidden={m === mode ? undefined : 'true'}
          className={cn(
            'col-start-1 row-start-1 flex flex-wrap items-baseline gap-x-3 gap-y-1',
            m !== mode && 'invisible',
          )}
        >
          {states[m](m === mode)}
        </div>
      ))}
    </div>
  );
}
