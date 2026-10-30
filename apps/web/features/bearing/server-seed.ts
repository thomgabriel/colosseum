import type { BearingChain } from './chain';
import { readKey } from './chain';
import { HEAT_SIZE, inPool, R, type Res, RISK_API, resOf, type SeedAnswer, TAU } from './data';
import { capFact, dexIds } from './dex';
import type { PageId } from './pages';
import { chunksFor } from './sim';
import { regimeAt } from './time';
import type { AssetsBody } from './types';

// The first reads of a Bearing page, made on the server while its HTML is made, so the page arrives
// with them and shows its figures once it hydrates, instead of asking the risk API only then. The same
// paths the page asks (data.ts `R`): the browser's reader keeps them (`seed`) and asks for nothing it
// already has, for the life of the page. So each is read fresh, as the browser would read it: Next's data
// cache would hand the first visitor after a gap an answer of any age (patch-fetch.js), and the banner
// would call the readings stale all visit. The API keeps its own answers (risk-cache.ts), so the host
// works no harder than for a browser's read.
//
// Never in the way: what is not read within `SEED_WAIT_MS` is left to the browser, as before; an
// answer that fails is not handed on; and what is too large to ride in the HTML is left to the browser's
// own read. Left to it as well: `GET /risk/dex`, a healthy batch is too large and it answers 200 with
// failures inside, which the reader would keep; each lending pool's sheet (about 170 kB, 14 pools); and a
// recoverable value, which the API does not keep.

/** How long the page waits for its first reads before it is sent without the rest. */
export const SEED_WAIT_MS = 800;
/** The largest answer handed on with the HTML, in characters of JSON. */
export const SEED_MAX_CHARS = 120_000;
/** The most characters handed on in all, so the page stays light. */
export const SEED_TOTAL_CHARS = 600_000;
/** Reads out at once from the server. */
const SEED_AT_ONCE = 8;

/** The sale the simulation opens on (BearingProvider's first `ui.sim`). */
export const SIM_FIRST = { asset: 'TSLAx', size: 100_000 };

type Fetcher = typeof fetch;

/** One read: its answer when it came in time and is small enough, else null. */
async function readOne(
  path: string,
  fetcher: Fetcher,
  signal: AbortSignal,
): Promise<SeedAnswer | null> {
  try {
    const r = await fetcher(`${RISK_API}${path}`, { signal, cache: 'no-store' });
    const text = await r.text();
    if (r.status < 200 || r.status >= 300 || text.length > SEED_MAX_CHARS) return null;
    return { path, status: r.status, body: JSON.parse(text) };
  } catch {
    return null;
  }
}

/** The answers of the paths, in order, each null where it was not read in time or not kept. */
async function readAll(paths: readonly string[], fetcher: Fetcher, signal: AbortSignal) {
  const got = new Map<string, SeedAnswer | null>();
  await inPool(
    paths,
    SEED_AT_ONCE,
    async (p) => {
      got.set(p, await readOne(p, fetcher, signal));
    },
    () => signal.aborted,
  );
  return paths.map((p) => got.get(p) ?? null);
}

const asRes = <T>(a: SeedAnswer | null): Res<T> =>
  a
    ? (resOf(a.status, a.body) as Res<T>)
    : { ok: false, status: 0, body: null, reason: 'api_error' };

/**
 * The first reads of a page on a chain, as the page itself would ask them: the chain's lists, then
 * what the page reads from them. Settles within `SEED_WAIT_MS` with whatever came in.
 */
export async function seedFor(
  page: PageId,
  chain: BearingChain,
  fetcher: Fetcher = fetch,
  now: Date = new Date(),
): Promise<SeedAnswer[]> {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), SEED_WAIT_MS);
  const out: SeedAnswer[] = [];
  const keep = (as: readonly (SeedAnswer | null)[]) => {
    for (const a of as) if (a) out.push(a);
  };
  try {
    const solana = chain === 'solana';
    const lending = solana && (page === 'lending' || page === 'stablecoins');
    const first = [
      R.assets(TAU, chain),
      R.chains(TAU),
      ...(solana ? [R.recorded()] : []),
      ...(lending ? [R.lendList()] : []),
    ];
    const [assetsA, ...rest] = await readAll(first, fetcher, stop.signal);
    keep([assetsA, ...rest]);
    const assets = asRes<AssetsBody>(assetsA);
    const then: string[] = [];
    if (assets.ok) {
      const body = assets.body;
      const byId = new Map(body.assets.map((a) => [a.symbol, a]));
      if (page === 'commodities')
        for (const id of dexIds(body, 'commodities'))
          then.push(R.heatmap(readKey(byId.get(id), id), HEAT_SIZE));
      if (page === 'simulation') {
        const a = byId.get(SIM_FIRST.asset);
        if (a) {
          const key = readKey(a, a.symbol);
          const n = SIM_FIRST.size;
          const chunks = chunksFor(n, capFact(a, regimeAt(now), body));
          then.push(R.sheet(key, n), R.split(key, n));
          if (chunks) then.push(R.sheet(key, n / chunks), R.split(key, n / chunks));
        }
      }
    }
    if (then.length) keep(await readAll(then, fetcher, stop.signal));
  } finally {
    clearTimeout(timer);
  }
  // Within the page's budget: the lists first, as they were read.
  let total = 0;
  return out.filter((a) => {
    const size = JSON.stringify(a.body).length;
    if (total + size > SEED_TOTAL_CHARS) return false;
    total += size;
    return true;
  });
}
