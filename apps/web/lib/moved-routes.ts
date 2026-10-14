// The product's pages are named after the bar's item they sit under (gate ROUTES-MATCH-NAV, Thom,
// Oct 14): Products, Invest, Portfolio, Analytics. The addresses they had before still lead to them,
// with their slug, id and query: links already sent, an agent's links, a person's bookmarks.

/** Each old address, as a Next path pattern, and where it is now. */
export const MOVED_ROUTES: readonly { from: string; to: string }[] = [
  { from: '/shelf', to: '/products' },
  { from: '/indexes/:slug', to: '/products/:slug' },
  { from: '/indexes/:slug/buy', to: '/products/:slug/buy' },
  { from: '/publish', to: '/products/publish' },
  { from: '/goal', to: '/invest' },
  { from: '/plan/:id', to: '/invest/plan/:id' },
  { from: '/plan/:id/buy', to: '/invest/plan/:id/buy' },
  { from: '/vaults/:chain/:address', to: '/portfolio/vaults/:chain/:address' },
  { from: '/vaults/:chain/:address/add', to: '/portfolio/vaults/:chain/:address/add' },
  { from: '/vaults/:chain/:address/targets', to: '/portfolio/vaults/:chain/:address/targets' },
  { from: '/vaults/:chain/:address/withdraw', to: '/portfolio/vaults/:chain/:address/withdraw' },
  { from: '/orders/:id', to: '/portfolio/orders/:id' },
  { from: '/monitor', to: '/portfolio/monitor' },
];

/** The redirects of next.config.ts: permanent, and the query goes along as Next passes it. */
export const movedRedirects = () =>
  MOVED_ROUTES.map(({ from, to }) => ({ source: from, destination: to, permanent: true }));

/**
 * Where an old address is now, for a path read from somewhere a redirect never sees, as `?next=` on
 * the sign-in page. A path that never moved comes back as it is.
 */
export function movedPath(path: string): string {
  const segments = path.split('/').slice(1);
  for (const { from, to } of MOVED_ROUTES) {
    const want = from.split('/').slice(1);
    if (want.length !== segments.length) continue;
    const values: Record<string, string> = {};
    const fits = want.every((part, i) => {
      const segment = segments[i] as string;
      if (!part.startsWith(':')) return part === segment;
      values[part.slice(1)] = segment;
      return true;
    });
    if (fits) return to.replace(/:(\w+)/g, (_, name: string) => values[name] as string);
  }
  return path;
}
