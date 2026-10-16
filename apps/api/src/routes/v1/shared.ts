import { metaHash } from '@colosseum/basket';
import {
  CEILING_METHOD,
  ChainError,
  CreatorLimitsQuery,
  CreatorLimitsResponse,
  DISCLAIMER,
  FamilyResponse,
  FamilyRouteParams,
  OrderError,
  type RecipeVersionView,
  SharedChainQuery,
  type SharedFamily,
  type SharedRecipe,
  ShelfResponse,
  VersionsResponse,
} from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { ChainEntry } from '../../orders/chains';
import { Refusal, refusing } from '../../orders/errors';
import {
  allFamilies,
  familyBySlug,
  recipeView,
  type StoredFamily,
  type StoredRecipe,
  syncVersions,
  versionView,
} from '../../orders/families';
import { figuresOf } from '../../orders/figures';
import type { OrderDeps } from '../../orders/legs';
import type { PlanInputs } from '../../orders/personalize';
import { autoFollowOffer, readRecipe } from '../../orders/shared';

// The shared-portfolio reads (API-3, DESIGN-VAULT sections 6 and 11): the shelf, a shared portfolio's
// page and its versions. Nobody has to sign in: they are the same for everyone. Publishing and
// following are orders (POST /v1/orders).

/** The adapter of a chain the server runs, or null for one that is off: its recipes are not served. */
function entryOf(deps: OrderDeps, recipe: StoredRecipe): ChainEntry | null {
  try {
    return deps.chains.get(recipe.chain);
  } catch (e) {
    if (e instanceof Refusal) return null;
    throw e;
  }
}

type Versions = {
  active: RecipeVersionView;
  pending: RecipeVersionView | null;
  source: 'chain' | 'cache';
  observedAt: string;
};

/** The versions as the server last stored them, or null when it has none in effect. */
function cached(recipe: StoredRecipe): Versions | null {
  const active = recipe.versions.find((v) => v.status === 'active');
  if (!active) return null;
  const pending = recipe.versions.find((v) => v.status === 'pending');
  const newest = Math.max(...recipe.versions.map((v) => v.createdAt.getTime()));
  return {
    active: versionView(active),
    pending: pending ? versionView(pending) : null,
    source: 'cache',
    observedAt: new Date(newest).toISOString(),
  };
}

/**
 * The versions as the chain has them now, written to the store on the way. A chain that does not
 * answer gives the stored ones; a chain that has no such recipe gives none.
 */
async function onChain(
  deps: OrderDeps,
  entry: ChainEntry,
  recipe: StoredRecipe,
): Promise<Versions | null> {
  let read: Awaited<ReturnType<typeof readRecipe>>;
  try {
    read = await readRecipe(entry, recipe.onchainId);
  } catch (e) {
    if (e instanceof ChainError) return cached(recipe);
    throw e;
  }
  if (!read) return null;
  await syncVersions(deps.db, recipe.id, read);
  return {
    active: recipeView(read.active, 'active'),
    pending: read.pending ? recipeView(read.pending, 'pending') : null,
    source: 'chain',
    observedAt: deps.now().toISOString(),
  };
}

/** How long a chain's figures are served as read, and how long, older, they are served while read again. */
export const SHELF_FRESH_MS = 10 * 60_000;
export const SHELF_STALE_MS = 60 * 60_000;
/**
 * How long a read of a chain's figures is waited for. Past it the read is given up: the answers that
 * waited get no figures and what was kept stays. No statement timeout is set on the pool, so a query on a
 * connection gone quiet would otherwise hold every answer behind it. A failed read is not tried again
 * before this long has passed, so a shelf of many recipes does not read again for each one.
 */
export const SHELF_READ_MS = 60_000;

/** `work`, or a rejection once `ms` have passed without its answer (as read-cache.ts, which /v1 does not reach). */
function within<T>(ms: number, work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no answer')), ms);
    timer.unref?.();
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/** What the shelf is told when a chain's figures cannot be read. */
export type FiguresError = (chain: string, err: unknown) => void;

type Inputs = Awaited<ReturnType<PlanInputs>>;
/**
 * The plan inputs of a chain (the stored yields, Bearing's sell depth), as the shelf and a portfolio's
 * page read them. A read that fails is no figures, never a failed answer.
 */
type Figures = (entry: ChainEntry) => Promise<Inputs | null>;

/**
 * The plan inputs of each chain, kept for every answer of the shelf and of a portfolio's page. Reading
 * them is a few queries, two more per listed token, and Bearing's curves built from what they read: the
 * first shelf after a start took a minute on the host (Oct 15). Fresh for `SHELF_FRESH_MS` they are
 * served as they are; older, up to `SHELF_STALE_MS`, they are served while one read brings them up to
 * date; past that an answer waits for the read. Answers that come together share one read. Each figure
 * keeps its own reading's source and time (figures.ts), so a kept one never passes for newer than it is.
 */
function keptFigures(
  deps: OrderDeps,
  planInputs: PlanInputs,
  opts: { readMs: number; onError: FiguresError },
): Figures {
  const kept = new Map<
    string,
    { at: number; inputs?: Inputs; read?: Promise<Inputs | null>; failedAt?: number }
  >();
  const now = () => deps.now().getTime();
  const read = (entry: ChainEntry) => {
    const e = kept.get(entry.chain) ?? { at: 0 };
    kept.set(entry.chain, e);
    if (e.read) return e.read;
    if (e.failedAt !== undefined && now() - e.failedAt < opts.readMs) return Promise.resolve(null);
    // Its age counts from when the read began: nothing it holds is newer than that.
    const began = now();
    const reading = (async () => {
      try {
        const inputs = await within(
          opts.readMs,
          (async () =>
            planInputs({
              db: deps.db,
              chain: entry.chain,
              assets: await entry.adapter.listAssets(),
              provenance: entry.provenance,
            }))(),
        );
        e.inputs = inputs;
        e.at = began;
        e.failedAt = undefined;
        return inputs;
      } catch (err) {
        e.failedAt = now();
        opts.onError(entry.chain, err);
        return null;
      }
    })();
    e.read = reading;
    void reading.finally(() => {
      if (e.read === reading) e.read = undefined;
    });
    return reading;
  };
  return async (entry) => {
    const e = kept.get(entry.chain);
    const age = e?.inputs ? now() - e.at : Number.POSITIVE_INFINITY;
    if (e?.inputs && age <= SHELF_FRESH_MS) return e.inputs;
    if (e?.inputs && age <= SHELF_STALE_MS) {
      void read(entry);
      return e.inputs;
    }
    return read(entry);
  };
}

async function recipeOf(
  deps: OrderDeps,
  family: StoredFamily,
  recipe: StoredRecipe,
  read: boolean,
  figures: Figures,
): Promise<SharedRecipe | null> {
  const entry = entryOf(deps, recipe);
  if (!entry) return null;
  const versions = read ? await onChain(deps, entry, recipe) : cached(recipe);
  if (!versions) return null;
  const { active, pending } = versions;
  const assets = await refusing(() => entry.adapter.listAssets());
  const inputs = await figures(entry);
  const hash = metaHash({
    familyId: family.familyId,
    slug: family.slug,
    name: family.name,
    copy: family.copy,
    kind: family.kind,
  });
  return {
    chain: recipe.chain,
    name: entry.config.name,
    onchainId: recipe.onchainId,
    creator: recipe.creator,
    active,
    pending,
    autoFollow: autoFollowOffer(
      entry,
      [active, ...(pending ? [pending] : [])].map((v) => v.components),
      assets,
    ),
    textMatches:
      active.metaHash === hash ? 'active' : pending?.metaHash === hash ? 'pending' : null,
    source: versions.source,
    observedAt: versions.observedAt,
    provenance: entry.provenance,
    ...(inputs
      ? { figures: figuresOf(active.components, assets, inputs, deps.now().toISOString()) }
      : {}),
  };
}

async function familyOf(
  deps: OrderDeps,
  family: StoredFamily,
  chain: SharedChainQuery['chain'],
  read: boolean,
  figures: Figures,
): Promise<SharedFamily> {
  const recipes: SharedRecipe[] = [];
  for (const r of family.recipes) {
    if (chain && r.chain !== chain) continue;
    const view = await recipeOf(deps, family, r, read, figures);
    if (view) recipes.push(view);
  }
  return {
    familyId: family.familyId,
    slug: family.slug,
    name: family.name,
    copy: family.copy,
    kind: family.kind,
    platform: family.platform,
    creatorKind: family.creatorKind,
    chains: family.recipes.map((r) => r.chain),
    recipes,
  };
}

async function familyNamed(deps: OrderDeps, slug: string): Promise<StoredFamily> {
  const family = await familyBySlug(deps.db, slug);
  if (!family) throw new Refusal(404, 'no shared portfolio with that slug');
  return family;
}

/**
 * How long an answer of `/v1/shared/limits` is kept per chain, in milliseconds: anybody may ask, so a
 * chain's registry and asset list are read at most once in this time, whoever asks and how often.
 */
export const LIMITS_KEPT_MS = 30_000;
type CreatorLimitsAnswer = import('zod').infer<typeof CreatorLimitsResponse>;

/** What the shelf's warm-up found: its portfolios, their chains, and the chains it got no figures for. */
export type ShelfWarmed = { families: number; chains: number; withoutFigures: string[] };

/**
 * Registers the shared-portfolio reads. Answers `warm`, which works the whole shelf out once, as
 * `GET /v1/shelf` with no chain would, so the figures it needs are kept before anybody asks.
 */
export function registerSharedRoutes(
  scope: FastifyInstance,
  deps: OrderDeps,
  planInputs: PlanInputs = async () => ({}),
  shelf: { liveOnly: boolean; readMs?: number; onFiguresError?: FiguresError } = {
    liveOnly: false,
  },
): { warm: () => Promise<ShelfWarmed> } {
  const f = scope.withTypeProvider<ZodTypeProvider>();
  const tags = ['shared portfolios'];
  const keptLimits = new Map<string, { at: number; answer: CreatorLimitsAnswer }>();
  const figures = keptFigures(deps, planInputs, {
    readMs: shelf.readMs ?? SHELF_READ_MS,
    onError: shelf.onFiguresError ?? (() => {}),
  });

  const shelfOf = async (chain: SharedChainQuery['chain']) => {
    const families: SharedFamily[] = [];
    for (const stored of await allFamilies(deps.db)) {
      const family = await familyOf(deps, stored, chain, false, figures);
      // Live only: a recipe whose figures are not live is left off the shelf, and a portfolio with
      // none left goes with it. Its page still answers by its address, for whoever follows it.
      const shown = shelf.liveOnly
        ? {
            ...family,
            recipes: family.recipes.filter((r) => r.provenance === 'live'),
            chains: family.chains.filter((c) =>
              family.recipes.some((r) => r.chain === c && r.provenance === 'live'),
            ),
          }
        : family;
      if ((chain || shelf.liveOnly) && !shown.recipes.length) continue;
      families.push(shown);
    }
    return families;
  };

  f.get(
    '/v1/shelf',
    {
      config: { auth: 'public', limit: 'standard' },
      schema: {
        tags,
        summary: 'Every shared portfolio, or those with a recipe on one chain',
        description:
          "From the server's store, not the chains: each recipe's versions are the last the server read (`source: 'cache'`). With no `chain`, every portfolio, each with the chains it has a recipe on (`chains`): the app lists them together, each labelled with its chains (gate CHAIN-AT-THE-PLAN). `chain` limits the answer to the portfolios with a recipe on that chain. A recipe on a chain this server has switched off is left out, and so is one published on a network its chain no longer runs. Where the server lists live portfolios only (`SHELF_LIVE_ONLY`), a recipe whose figures are not live is left out too, with a portfolio that has none left; its page still answers by its slug. `autoFollow` says whether the auto-follow switch is offered: not on a portfolio that holds an asset with no price oracle on that chain, whose followers get the one-tap prompt instead. `name` and `copy` are the creator's words: `textMatches` says which version's hash they match, if any. `figures` is what the server has measured about the version in effect, the readings a plan is made from: each holding's stored yield and the most of it that can be sold within the exit window (each null where the server has none, never zero). Nothing is added up across the holdings. A chain's readings are kept ten minutes and, older, served up to an hour while they are read again; each figure keeps its own `fetchedAt`.",
        querystring: SharedChainQuery,
        response: { 200: ShelfResponse, default: OrderError },
      },
    },
    async (req) => ({ families: await shelfOf(req.query.chain), disclaimer: DISCLAIMER.en }),
  );

  f.get(
    '/v1/shared/limits',
    {
      config: { auth: 'public', limit: 'standard' },
      schema: {
        tags,
        summary: 'The author limits of one chain, as its registry says them now',
        description:
          "What a shared portfolio published on `chain` is held to, read from the chain for this answer (`source: 'chain'`): on Robinhood Chain the registry's `limits()` and `rulesVersion()`, on Solana the program's own numbers. `ceilings` are each listed asset's `maxWeightBps`, set from its measured exit capacity. `rules` 1 are the first rules: 3 to 12 assets, each from 2% to the lower of 50% and the asset's ceiling, adding up to exactly 100%. `rules` 2 are the second (gate SHARED-RULES-V2): 1 to 16 assets, each from 0.5% to 100%, adding up to at most 100% with the rest in cash, and an asset's own ceiling a warning, not a limit. Both: steps of 0.5%, never the cash token as a line, at most 20% of the portfolio moved per version, cash counted, and one version per publish delay. A chain that does not answer is 503 `CHAIN_UNAVAILABLE`: nothing is assumed.",
        querystring: CreatorLimitsQuery,
        response: { 200: CreatorLimitsResponse, default: OrderError },
      },
    },
    async (req) => {
      const entry = deps.chains.get(req.query.chain);
      const now = deps.now().getTime();
      const hit = keptLimits.get(entry.chain);
      if (hit && now - hit.at < LIMITS_KEPT_MS) return hit.answer;
      const [limits, assets] = await refusing(() =>
        Promise.all([entry.adapter.creatorLimits(), entry.adapter.listAssets()]),
      );
      const answer = {
        chain: entry.chain,
        limits,
        ceilings: assets
          .filter((a) => a.cls !== 'cash')
          .map((a) => ({ asset: a.id, maxWeightBps: a.maxWeightBps })),
        ceilingsFrom: {
          source: `${entry.source}: the asset list on ${entry.config.name}`,
          method: CEILING_METHOD,
          fetchedAt: deps.now().toISOString(),
          provenance: entry.provenance,
        },
        source: 'chain' as const,
        observedAt: deps.now().toISOString(),
        provenance: entry.provenance,
      };
      keptLimits.set(entry.chain, { at: now, answer });
      return answer;
    },
  );

  f.get(
    '/v1/indexes/:slug',
    {
      config: { auth: 'public', limit: 'standard' },
      schema: {
        tags,
        summary: 'A shared portfolio, its recipes read from their chains',
        description:
          "Each recipe is read from its chain for this answer (`source: 'chain'`): the version in effect and the one that waits, with its time. Where the chain does not answer, the last versions the server read (`source: 'cache'`). `onchainId` and the version in effect are what a follow names. `chain` limits the answer to one chain's recipe. `autoFollow.offered` is false on a portfolio that holds an asset with no price oracle (gate GOLD-ONE-TAP).",
        params: FamilyRouteParams,
        querystring: SharedChainQuery,
        response: { 200: FamilyResponse, default: OrderError },
      },
    },
    async (req) => ({
      family: await familyOf(
        deps,
        await familyNamed(deps, req.params.slug),
        req.query.chain,
        true,
        figures,
      ),
      disclaimer: DISCLAIMER.en,
    }),
  );

  f.get(
    '/v1/indexes/:slug/versions',
    {
      config: { auth: 'public', limit: 'standard' },
      schema: {
        tags,
        summary: 'Every version of a shared portfolio the server has seen, per chain, newest first',
        description:
          "The version in effect and the one that waits are read from the chain for this answer; older ones are the server's record. A version taken back before anything later took effect is `cancelled`; one no longer seen on the chain while a later one is in effect is `superseded`, whether it took effect or was taken back, since no event is read.",
        params: FamilyRouteParams,
        querystring: SharedChainQuery,
        response: { 200: VersionsResponse, default: OrderError },
      },
    },
    async (req) => {
      const family = await familyNamed(deps, req.params.slug);
      const chains: VersionsResponse['chains'] = [];
      for (const recipe of family.recipes) {
        if (req.query.chain && recipe.chain !== req.query.chain) continue;
        const entry = entryOf(deps, recipe);
        if (!entry) continue;
        const read = await onChain(deps, entry, recipe);
        if (!read) continue;
        // Read again: the chain's answer was just written beside what the server had.
        const fresh = (await familyBySlug(deps.db, family.slug))?.recipes.find(
          (r) => r.id === recipe.id,
        );
        chains.push({
          chain: recipe.chain,
          onchainId: recipe.onchainId,
          source: read.source,
          observedAt: read.observedAt,
          provenance: entry.provenance,
          versions: (fresh ?? recipe).versions.map(versionView),
        });
      }
      return { familyId: family.familyId, slug: family.slug, chains };
    },
  );

  return {
    warm: async () => {
      const families = await shelfOf(undefined);
      const recipes = families.flatMap((f) => f.recipes);
      const chains = [...new Set(recipes.map((r) => r.chain))];
      return {
        families: families.length,
        chains: chains.length,
        // A chain's figures come back for all its recipes or for none.
        withoutFigures: chains.filter((c) => recipes.some((r) => r.chain === c && !r.figures)),
      };
    },
  };
}
