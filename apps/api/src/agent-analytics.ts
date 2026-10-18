import type { Db } from '@colosseum/db';
import { defaultFactsParams } from '@colosseum/risk';
import {
  type AssetFacts,
  type Fact,
  type FactRegime,
  finiteFacts,
  type Provenance,
} from '@colosseum/schemas';
import { loadAssetFacts } from './facts';
import type { AgentAnalytics, AgentAnalyticsResult, AnalyticsFigure } from './orders/vault-agent';
import { resolveExitTwins } from './plan-inputs';
import { keeper, limiter, stored, within } from './read-cache';

// What the vault and new-goal conversations hand the model from Bearing besides the plan inputs: a few
// figures of each listed asset's fact sheet (facts.ts), each with its pin or null with the reason. A sheet
// is about 44 KB and ten queries, so the model never sees one: it gets these figures as evidence it may
// cite, and explains them in words (orders/vault-agent.ts). A test-network token reads the sheet of the
// mainnet token it models, as the plan inputs do, and its figures are labelled sandbox with the model named.
//
// Outside the /v1 route table: the sheets read the risk layer's fixtures from files, which no file the /v1
// routes reach may do (apps/api/src/orders/orders.test.ts).

type Sheet = (db: Db, id: string, sizeUsd: number) => Promise<AssetFacts | null>;
type Read = Extract<AgentAnalyticsResult, { assets: unknown }>;
type Query = Parameters<AgentAnalytics>[0];

/** An hour: the collectors write hourly at most. A kept read older than this is served once more while it
 *  is read again, so nothing reads a sheet that no turn asks for. */
const TTL_MS = 60 * 60_000;
/** Sheets read at once across every conversation: each holds one of the pool’s 15
 *  connections. */
const CONCURRENCY = 3;
/** A turn waits this long for reads it does not have kept; they carry on and fill the cache for the next. */
const WAIT_MS = 2_500;
/** Sheet reads waiting or running at once, about three catalogs; past it a sheet is left for a later turn. */
const MAX_PENDING = 90;
/** A read with no answer after this long is given up: its place goes to the next, and a later turn reads
 *  again. Nothing else bounds a query on a connection that went quiet. */
const READ_MS = 60_000;

/** The figures the model reads, from one sheet, each with the regime it is about or none. */
export function projectSheet(sheet: AssetFacts): AnalyticsFigure[] {
  const figure = (
    metric: AnalyticsFigure['metric'],
    fact: Fact,
    regime: FactRegime | null,
  ): AnalyticsFigure => {
    const at = regime ? { regime } : {};
    return fact.value === null
      ? { metric, ...at, value: null, reason: fact.reason }
      : {
          metric,
          ...at,
          value: fact.value,
          unit: fact.unit,
          source: fact.source,
          method: `${fact.method} (${fact.methodVersion})`,
          fetchedAt: fact.fetchedAt,
          provenance: fact.provenance,
          // the size it was measured at, when that is not the sheet's (an LP-exit grid point)
          ...(fact.sizeUsd !== undefined && fact.sizeUsd !== sheet.sizeUsd
            ? { sizeUsd: fact.sizeUsd }
            : {}),
          ...(fact.quality === 'lower_bound' ? { lowerBound: true } : {}),
        };
  };
  const worst = sheet.costs.find((cost) => cost.regime === sheet.worstRegime);
  // The capacity at the tolerance is the plan inputs' (`capacity:`, `liquidity:`): one figure per measure.
  // With no regime measured, every regime's exit says why; the first one speaks for the worst.
  const unmeasured = sheet.costs.find((cost) => cost.exit.total.value === null)?.exit.total;
  const none: Fact = unmeasured ?? { value: null, reason: 'not_collected', unit: 'fraction' };
  const volume = sheet.flow?.byWindow.find((row) => row.window === '28d')?.volumeUsd;
  return [
    figure('exit_worst', worst?.exit.total ?? none, sheet.worstRegime),
    // the other regimes: the worst one is above
    ...sheet.costs
      .filter((cost) => cost.regime !== sheet.worstRegime)
      .map((cost) => figure('exit', cost.exit.total, cost.regime)),
    figure('weekend', sheet.weekendRatio, null),
    figure('lp_top1', sheet.liquidityStability.lpTop1Share, null),
    figure('lp_exit', sheet.liquidityStability.lpExitCost, null),
    // the variation is measured in the worst regime, which the fact names
    figure(
      'cap_variation',
      sheet.liquidityStability.capacityVariation,
      sheet.liquidityStability.capacityVariation.regime ?? null,
    ),
    figure('volume_28d', volume ?? { value: null, reason: 'not_collected', unit: 'usd' }, null),
    figure('volatility', sheet.marketRisk.volatilityAnnual, null),
    figure('drawdown', sheet.marketRisk.maxDrawdown, null),
  ];
}

/**
 * On a chain that is not live, no figure says live: a test-network token's figures are its mainnet
 * model's, labelled sandbox, with the source naming whose they are.
 */
export function relabel(
  figures: AnalyticsFigure[],
  provenance: Provenance | undefined,
  twin: { twinSymbol: string; symbol: string } | undefined,
): AnalyticsFigure[] {
  if (!provenance || provenance === 'live') return figures;
  return figures.map((figure) =>
    figure.value === null
      ? figure
      : {
          ...figure,
          provenance: figure.provenance === 'live' ? provenance : figure.provenance,
          source: twin
            ? `${figure.source}; mainnet ${twin.twinSymbol} figures applied to the test-network token ${twin.symbol}`
            : figure.source,
        },
  );
}

/** Two significant figures: a vault's value moves with its prices, and its reads are kept by this. */
export function roundSize(usd: number): number {
  const step = 10 ** Math.max(0, Math.floor(Math.log10(usd)) - 1);
  return Math.round(usd / step) * step;
}

export function createAgentAnalytics(
  deps: {
    sheet?: Sheet;
    twins?: typeof resolveExitTwins;
    concurrency?: number;
    ttlMs?: number;
    waitMs?: number;
    maxPending?: number;
    readMs?: number;
    now?: () => number;
  } = {},
): AgentAnalytics {
  const sheet: Sheet = deps.sheet ?? ((db, id, sizeUsd) => loadAssetFacts(db, id, { sizeUsd }));
  const twins = deps.twins ?? resolveExitTwins;
  const ttl = deps.ttlMs ?? TTL_MS;
  const wait = deps.waitMs ?? WAIT_MS;
  const maxPending = deps.maxPending ?? MAX_PENDING;
  const now = deps.now ?? Date.now;
  const readMs = deps.readMs ?? READ_MS;
  const limit = limiter(deps.concurrency ?? CONCURRENCY);
  const { refSizeUsd, tau } = defaultFactsParams();
  const keptTwins = keeper<Awaited<ReturnType<typeof resolveExitTwins>>>(ttl, now);
  const keptSheets = keeper<AnalyticsFigure[] | null>(ttl, now);
  let pending = 0;

  const sheetOf = (db: Db, id: string, size: number) =>
    keptSheets(`${stored(id)}|${size}`, () => {
      if (pending >= maxPending) return Promise.reject(new Error('busy'));
      pending += 1;
      return limit(() => within(readMs, sheet(db, stored(id), size)))
        .then((found) => (found ? projectSheet(finiteFacts(found)) : null))
        .finally(() => {
          pending -= 1;
        });
    });

  /** Starts (or reuses) every read a catalog needs at one size; nothing here waits for them. */
  const start = ({ db, chain, assets, provenance }: Omit<Query, 'sizeUsd'>, size: number) => {
    const listed = assets.filter((asset) => asset.chain === chain && asset.cls !== 'cash');
    const key = [chain, provenance ?? '', ...listed.map((asset) => asset.id).sort()].join('|');
    const twinsRead = keptTwins(key, () => within(readMs, twins(db, listed, provenance)));
    const rows = twinsRead.then((found) => {
      const twinOf = new Map(found.map((twin) => [twin.id, twin]));
      return listed.map((asset) => {
        const twin = twinOf.get(asset.id);
        return { asset, twin, figures: sheetOf(db, twin?.twinMint ?? asset.address, size) };
      });
    });
    // Each read's own failure is handled where it is awaited; these only keep it from going unhandled.
    rows.then(
      (all) => {
        for (const row of all) row.figures.catch(() => {});
      },
      () => {},
    );
    return rows;
  };

  const read = (async (query) => {
    const vault = query.sizeUsd !== null && Number.isFinite(query.sizeUsd) && query.sizeUsd >= 1;
    const size = vault ? roundSize(query.sizeUsd as number) : refSizeUsd;
    const base = { sizeUsd: size, basis: vault ? ('vault' as const) : ('reference' as const), tau };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), wait);
    });
    try {
      const rows = await Promise.race([start(query, size), late]);
      if (rows === 'late') return { unavailable: 'analytics_timeout' };
      const settled = new Map<string, AnalyticsFigure[] | null | 'failed'>();
      await Promise.race([
        Promise.all(
          rows.map((row) =>
            row.figures.then(
              (figures) => settled.set(row.asset.id, figures),
              () => settled.set(row.asset.id, 'failed'),
            ),
          ),
        ),
        late,
      ]);
      const assets: Read['assets'] = rows.map(({ asset, twin }) => {
        const got = settled.get(asset.id);
        const head = { assetId: asset.id, modelledOn: twin?.twinSymbol ?? null };
        if (got === undefined) return { ...head, figures: null, unread: 'reading' as const };
        if (got === 'failed') return { ...head, figures: null, unread: 'failed' as const };
        return { ...head, figures: got && relabel(got, query.provenance, twin) };
      });
      if (assets.length && assets.every((row) => row.unread === 'failed'))
        return { unavailable: 'analytics_failed' };
      const unread = assets.filter((row) => row.unread).length;
      return {
        ...base,
        assets,
        ...(unread ? { incomplete: `analytics_partial_${unread}_of_${assets.length}` } : {}),
      };
    } catch {
      return { unavailable: 'analytics_failed' };
    } finally {
      clearTimeout(timer);
    }
  }) as AgentAnalytics;

  return read;
}

/** The server's reader: one cache and one limit on reads for every conversation. */
export const bearingAgentAnalytics = createAgentAnalytics();
