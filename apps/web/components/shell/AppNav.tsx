'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAccountControl } from '../../features/account/AccountControl';
import { useWalletPort } from '../../features/wallet/WalletProvider';
import { useT } from '../../i18n/I18nProvider';
import { CompactNav } from '../ui/CompactNav';
import { Mark } from './Mark';
import { ThemeToggle } from './ThemeToggle';

// The product's bar is his landing's compact bar (compact-nav.md, hero-3d.html), compact from the
// start because no product page has a stage: the mark and the wordmark, then his items mapped to the
// product's routes, then the wallet. A solid bar with a hairline, fixed at the top; no glass, no blur.
//
//   Invest      the goal and its plan (/invest)
//   Portfolio   the person's vaults (/portfolio), for someone signed in
//   Analytics   Bearing's analytics (/analytics/stocks), current on every page under /analytics,
//               its methodology too, which its side menu links (no Resources item: Thom, Oct 6)
//   the account one control, the same on the landing's bar (Thom, Oct 9; AccountControl.tsx): a still
//               placeholder until it is known who is here, "Sign in" for nobody, and for a person
//               "Account", opening their wallets (one for each chain they have one on, each with
//               "Copy address" and the explorer) and "Sign out" (AccountMenu.tsx). The bar shows and
//               switches no chain (gate CHAIN-AT-THE-PLAN): where a plan starts is chosen on /invest
//
//   Leaderboard every open vault on the chain ranked by what it made (/leaderboard), for everyone,
//               in the place of Products, which is out of the bar for the demo (Thom, Oct 28): the
//               shelf (/products) and a portfolio's page under it are still there, reached by link
//
// A page's first segment is the name of the item it is under (gate ROUTES-MATCH-NAV, Thom, Oct 14):
// a vault's page, the older monitor and an order's page (/portfolio/orders/{id}) are under Portfolio.
// An order is a deposit into, a withdrawal from or a change of one of the person's vaults, or a
// publish of a vault's targets, so it lights Portfolio even when it was started from Products.
//
// On a phone the links are in the sheet under the menu button, under the same account block (the
// wallets, "Sign out"); the bar's control is the same "Account".
//
// Nothing here is the wallet adapter's button, which renders one thing on the server and another in
// the browser. What the bar shows about the person comes from the wallet port, and it shows nothing
// about them until the port has loaded, so the server and the browser draw the same bar.

/** The product's routes in the bar, his order; `signedIn` marks the one a visitor does not get. */
const ROUTES = [
  // every open vault on the chain, ranked by what it made, for everyone. It stands where Products
  // stood: Products is out of the bar for the demo (Thom, Oct 28), its pages and routes unchanged.
  { href: '/leaderboard', key: 'leaderboard', also: ['/leaderboard'] },
  { href: '/invest', key: 'invest', also: ['/invest'] },
  // the portfolio section's board (/portfolio); a vault's page, an order's and the monitor are under it
  { href: '/portfolio', key: 'portfolio', signedIn: true, also: ['/portfolio'] },
  // Bearing's analytics: every page of the section is under it
  { href: '/analytics/stocks', key: 'analytics', also: ['/analytics'] },
] as const;

/** The page a link stands for is the one in view: its own path, or one under it that it leads to. */
const isCurrent = (pathname: string, route: (typeof ROUTES)[number]) =>
  pathname === route.href ||
  ('also' in route && route.also.some((p) => pathname.startsWith(`${p}/`)));

export function AppNav() {
  const t = useT();
  const pathname = usePathname();
  const port = useWalletPort();
  const account = useAccountControl();
  const signedIn = port.status !== 'signed-out' && port.userId !== null;
  const exact = ROUTES.some((route) => route.href === pathname);
  return (
    <CompactNav
      symbol={<Mark size={24} />}
      wordmark="tenonfi"
      homeLabel={t.shell.home}
      homeHref="/"
      contentId="content"
      compact
      linkAs={Link}
      links={ROUTES.filter((route) => !('signedIn' in route) || signedIn).map((route) => ({
        label: t.shell[route.key],
        href: route.href,
        // the link whose own page this is wins over one it is under
        current: (exact ? pathname === route.href : isCurrent(pathname, route)) && 'page',
      }))}
      action={
        <div className="flex items-center gap-2">
          {/* On a phone the bar has no room for it beside the account: it sits in the menu's sheet. */}
          <span className="hidden sm:contents">
            <ThemeToggle />
          </span>
          <div className="ml-2 flex items-center gap-2">{account.action}</div>
        </div>
      }
      sheetHead={
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">{account.sheetHead}</div>
          <span className="contents sm:hidden">
            <ThemeToggle />
          </span>
        </div>
      }
      labels={{ skip: t.shell.skip, main: t.shell.nav, menu: t.shell.menu }}
    />
  );
}
