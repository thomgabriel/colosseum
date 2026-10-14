import { createHash, randomUUID } from 'node:crypto';
import { batchTrades, RebalanceError, rebalancePlan } from '@colosseum/basket';
import {
  eligibleForGoal,
  fixedMix,
  PERSONAL_PARAMS,
  purposeOfMix,
  reason,
} from '@colosseum/engine/personal';
import {
  type Address,
  type BasketAsset,
  BasketProposal,
  type BasketSheet,
  type BuiltTx,
  ChainError,
  chainFamily,
  DISCLAIMER,
  type IntentRequest,
  type Language,
  type Leg,
  type MixFigure,
  type MixIssueCode,
  type MixLine,
  type MixOrigin,
  type MixReview,
  type MixReviewLine,
  type MixWarning,
  type MixWarningCode,
  normalizeAddress,
  type ObservationRef,
  ORDER_LIMITS,
  type Order,
  OWNER_REBALANCE_BAND_BPS,
  OWNER_REBALANCE_MIN_TRADE_USD,
  outsideOwnerBand,
  type Price,
  type RebalanceQuoteResponse,
  type Target,
  type Trade,
  type VaultState,
} from '@colosseum/schemas';
import { assertBuilds, type ChainEntry } from './chains';
import { Refusal } from './errors';
import { type PlanInputs, preparePersonalInputs } from './personalize';
import { expectedOf, MIX_VERSION, ORDER_POLICY } from './prepare';

// A mix taken from the conversation, or chosen by the person, made into something that can be bought
// (gate ANY-COMPOSITION, Thom, Oct 8). Any composition of the chain's listed assets: each once,
// whole basis points, 16 at most, and the chain's cash token for the rest, all adding up to exactly
// 10,000. The client sends the lines back and they are checked again here against the chain as it is
// now. What used to keep a line out (an exit ceiling, the asset list's cap, a stock in an income or
// protect plan) is a warning the person confirms. Every figure is the server's, with its source.
//
// A new vault: the mix is stored as a plan, as the engine's plans are, and bought by `POST /v1/orders`
// with its `proposalId`, unchanged. A vault the person has: an order whose first step sets the
// vault's own targets and whose other steps sell and buy to them at the prices now.

/** The version of this way of making a plan: a stored mix's `engineVersion`. */
export { MIX_VERSION };

/** The figures a mix is checked with, from the chain and the plan inputs, read once. */
export type MixContext = {
  entry: ChainEntry;
  /** The chain's asset list, each with the tier and issuer the plan inputs stand in for its own. */
  assets: BasketAsset[];
  cash: BasketAsset;
  prepared: Awaited<ReturnType<typeof preparePersonalInputs>>;
  now: string;
};

export async function mixContext(
  entry: ChainEntry,
  inputs: (q: Omit<Parameters<PlanInputs>[0], 'db'>) => ReturnType<PlanInputs>,
  now: string,
): Promise<MixContext> {
  const listed = await entry.adapter.listAssets();
  const prepared = await preparePersonalInputs(
    entry.chain,
    listed,
    [],
    entry.provenance,
    (chain, assets, provenance) => inputs({ chain, assets, provenance }),
  );
  const assets = prepared.shelf.assets.filter((a) => a.chain === entry.chain);
  const cash = assets.find((a) => a.cls === 'cash');
  if (!cash) throw new Error(`${entry.chain} lists no cash token`);
  return { entry, assets, cash, prepared, now };
}

/** A mix as checked: cash first where it has a share, then each asset as sent. */
export type CheckedMix = {
  picks: Array<{ asset: BasketAsset; weightBps: number }>;
  targets: Target[];
  cashBps: number;
  /** The reference price of every asset of the mix and every asset the vault holds, by asset. */
  prices: Map<string, Price>;
};

const issue = (code: MixIssueCode, asset?: string) => (asset ? `${code}:${asset}` : code);

/** A price the vault can trade on now: a feed, above zero, and no older than the chain takes. */
export const usable = (asset: BasketAsset, price: Price | undefined): price is Price =>
  asset.priceKind !== 'none' &&
  price !== undefined &&
  Number(price.usdPerToken) > 0 &&
  price.ageSeconds <= price.maxAgeSeconds;

/**
 * The checks the money depends on, against the chain's list and prices now. Every issue is named, and
 * any one refuses the mix with 422 `MIX_NOT_VALID`. `vault`, for a vault already open: what it holds
 * is priced too, since it is sold to reach the targets, and all cash is refused.
 */
export async function checkMix(
  ctx: MixContext,
  allocations: readonly MixLine[],
  vault?: VaultState,
): Promise<CheckedMix> {
  const { entry, cash } = ctx;
  const byId = new Map(ctx.assets.map((a) => [a.id, a]));
  const issues: string[] = [];
  const seen = new Set<string>();
  const picks: CheckedMix['picks'] = [];
  let sum = 0;
  for (const line of allocations) {
    if (!Number.isInteger(line.weightBps) || line.weightBps < 1 || line.weightBps > 10_000)
      issues.push(issue('WEIGHT_NOT_WHOLE', line.assetId));
    else sum += line.weightBps;
    if (seen.has(line.assetId)) {
      issues.push(issue('DUPLICATE', line.assetId));
      continue;
    }
    seen.add(line.assetId);
    const asset = byId.get(line.assetId);
    if (!asset) issues.push(issue('NOT_LISTED', line.assetId));
    else if (asset.cls === 'cash' && asset.id !== cash.id)
      issues.push(issue('FOREIGN_CASH', line.assetId));
    else picks.push({ asset, weightBps: line.weightBps });
  }
  if (sum !== 10_000 && !issues.some((i) => i.startsWith('WEIGHT_NOT_WHOLE')))
    issues.push(issue('SUM_NOT_10000'));
  const invested = picks.filter((p) => p.asset.id !== cash.id);
  if (allocations.filter((l) => l.assetId !== cash.id).length > ORDER_POLICY.maxLines)
    issues.push(issue('TOO_MANY_LINES'));
  if (vault && invested.length === 0 && issues.length === 0) issues.push(issue('ALL_CASH'));
  const held = vault ? vault.positions.filter((p) => BigInt(p.raw) > 0n).map((p) => p.asset) : [];
  const priced = [...new Set([...invested.map((p) => p.asset.id), ...held])];
  const prices = new Map<string, Price>();
  if (issues.length === 0 && priced.length) {
    for (const price of await entry.adapter.getPrices(priced.filter((id) => byId.has(id))))
      prices.set(price.asset, price);
    for (const id of priced) {
      const asset = byId.get(id);
      if (!asset || !usable(asset, prices.get(id))) issues.push(issue('NO_PRICE', id));
    }
  }
  // One order moves at most `ORDER_LIMITS.maxAmountUsd`: a rebalance trades up to the vault's value.
  if (vault && issues.length === 0 && vaultValueUsd(vault, prices) > ORDER_LIMITS.maxAmountUsd)
    issues.push(issue('OVER_ORDER_LIMIT'));
  if (issues.length)
    throw new Refusal(422, 'this vault cannot take a deposit as sent', {
      code: 'MIX_NOT_VALID',
      fix: 'Change the lines named in details.issues, then review again.',
      details: { issues: [...new Set(issues)] },
    });
  const cashBps = picks.find((p) => p.asset.id === cash.id)?.weightBps ?? 0;
  return {
    picks: [...picks.filter((p) => p.asset.id === cash.id), ...invested],
    targets: invested.map((p) => ({ asset: p.asset.id, weightBps: p.weightBps })),
    cashBps,
    prices,
  };
}

type Goal = BasketSheet['goal'];

/**
 * Whether a plan for `goal` may hold an asset, as the review of a mix reads it (gate ANY-COMPOSITION):
 * `fits` (no goal, cash, or eligible by the asset registry's rule), `stock_outside` (a stock or a fund
 * of stocks outside the goal: the person's choice, with a warning) or `barred` (any other class outside
 * the goal: refused, `MIX_NOT_VALID`). The relaxed intake's preview reads the same function, so a
 * preview never shows a line the deposit step refuses.
 */
export type GoalFit = 'fits' | 'stock_outside' | 'barred';
export function goalFit(asset: Pick<BasketAsset, 'cls'>, goal: Goal | null): GoalFit {
  if (!goal || asset.cls === 'cash' || eligibleForGoal(asset, goal)) return 'fits';
  return asset.cls === 'stock' || asset.cls === 'etf' ? 'stock_outside' : 'barred';
}

/**
 * The goal and risk a new goal's mix is reviewed and stored with: the ones the person said, and for
 * one they did not, the one the mix itself stands for (gate DEPOSIT-DERIVE, `purposeOfMix`), named in
 * `fromMix` so the screen can say it was worked out and not said.
 */
export function purposeFor(
  checked: Pick<CheckedMix, 'picks'>,
  said: { goal?: Goal | null | undefined; risk?: BasketSheet['risk'] | null | undefined },
): { goal: Goal; risk: BasketSheet['risk']; fromMix: ('goal' | 'risk')[] } {
  const mix = purposeOfMix(
    checked.picks.map(({ asset, weightBps }) => ({ cls: asset.cls, weightBps })),
  );
  return {
    goal: said.goal ?? mix.goal,
    risk: said.risk ?? mix.risk,
    fromMix: [...(said.goal ? [] : (['goal'] as const)), ...(said.risk ? [] : (['risk'] as const))],
  };
}

/** The sheet a mix's figures are read with: the person's goal, amount and term on the one chain. */
export function mixSheet(
  ctx: MixContext,
  a: {
    goal: Goal;
    risk: BasketSheet['risk'];
    amountUsd: number;
    horizonMonths?: number;
    language: Language;
  },
): BasketSheet {
  return {
    basketType: 'standard',
    goal: a.goal,
    amountUsd: a.amountUsd,
    horizonMonths: a.horizonMonths ?? PERSONAL_PARAMS.openEndedHorizonMonths,
    ...(a.horizonMonths === undefined ? { horizonOpen: true } : {}),
    risk: a.risk,
    themes: [],
    chains: [ctx.entry.chain],
    rules: { useHoldings: false, glide: false },
    language: a.language,
  };
}

const sourced = <T extends { source: string | null; fetchedAt: string | null }>(
  o: T,
): o is T & { source: string; fetchedAt: string } => o.source !== null && o.fetchedAt !== null;

/**
 * What the server says about a mix before it is bought or applied: each line's share of the amount,
 * its price and its exit ceiling, each with its source, and the warnings to confirm. `goal` null is
 * a vault whose plan the server does not hold: no line is checked against a goal then.
 */
export function reviewMix(
  ctx: MixContext,
  checked: CheckedMix,
  a: {
    origin: MixOrigin;
    goal: Goal | null;
    risk: BasketSheet['risk'];
    amountUsd: number;
    horizonMonths?: number;
    language: Language;
    accepted: readonly string[];
    vault?: VaultState;
    /** What the person did not say and the server worked out from the mix (gate DEPOSIT-DERIVE). */
    fromMix?: readonly ('goal' | 'risk')[];
  },
) {
  const { entry, prepared } = ctx;
  // The engine reads a sheet of at least $10; a smaller vault is read at that size, and only its
  // ceilings and the goal's list are used, which the size does not change.
  const sheet = mixSheet(ctx, {
    ...a,
    goal: a.goal ?? 'grow',
    amountUsd: Math.max(a.amountUsd, 10),
  });
  const { figures } = prepared;
  const fixed = fixedMix(
    sheet,
    prepared.shelf,
    {
      now: ctx.now,
      ...(figures.yields ? { yields: figures.yields } : {}),
      ...(figures.liquidity
        ? { liquidity: figures.liquidity.provider, liquiditySource: figures.liquidity.source }
        : {}),
    },
    checked.picks.map((p) => ({ assetId: p.asset.id, weightBps: p.weightBps })),
    a.origin,
  );
  const cents = splitCents(
    Math.round(a.amountUsd * 100),
    checked.picks.map((p) => p.weightBps),
  );
  const liquidityOf = new Map(
    fixed.observations.filter((o) => o.kind === 'liquidity').map((o) => [o.id, o]),
  );
  const tierOf = new Map((figures.tiers ?? []).map((t) => [t.assetId, t]));
  const warnings: MixWarning[] = [];
  const warn = (code: MixWarningCode, text: string, figures: MixFigure[], asset?: string) =>
    warnings.push({
      id: asset ? `${code}:${asset}` : code,
      code,
      ...(asset ? { assetId: asset } : {}),
      text,
      figures,
    });
  const notForGoal: string[] = [];
  const lines: MixReviewLine[] = checked.picks.map(({ asset, weightBps }, i) => {
    const fixedLine = fixed.lines[i];
    if (!fixedLine || fixedLine.line.assetId !== asset.id)
      throw new Error('the review lost a line');
    const amountUsd = (cents[i] ?? 0) / 100;
    const price = checked.prices.get(asset.id);
    let exitCeiling: MixReviewLine['exitCeiling'] = null;
    const { ceiling } = fixedLine;
    if (ceiling) {
      const measured = liquidityOf.get(asset.id);
      const tier = tierOf.get(asset.id);
      const from = ceiling.measured
        ? measured && sourced(measured)
          ? {
              source: measured.source,
              method: measured.method,
              fetchedAt: measured.fetchedAt,
              provenance: measured.provenance,
            }
          : null
        : {
            // A tier stands in where nothing is measured, and says so (gate EXIT-SOURCE).
            source: tier?.source ?? entry.source,
            method: `the ceiling of tier ${asset.tier} on the asset list, a fallback where no exit is measured${tier ? ` (tier: ${tier.method})` : ''}`,
            fetchedAt: tier?.fetchedAt ?? ctx.now,
            provenance: tier?.provenance ?? asset.provenance,
          };
      if (from) exitCeiling = { ...from, usd: ceiling.usd, measured: ceiling.measured };
      if (amountUsd > ceiling.usd)
        warn(
          ceiling.measured ? 'EXIT_OVER_CAPACITY' : 'EXIT_OVER_TIER_CEILING',
          // A ceiling whose measurement names no source is not printed: the warning says so instead.
          (from
            ? reason(
                ceiling.measured ? 'MIX_OVER_EXIT' : 'MIX_OVER_TIER',
                { asset: asset.symbol, usd: amountUsd, maxUsd: ceiling.usd },
                a.language,
              )
            : reason('MIX_OVER_EXIT_UNSOURCED', { asset: asset.symbol, usd: amountUsd }, a.language)
          ).text,
          from ? [{ ...from, label: 'exit ceiling', value: ceiling.usd, unit: 'USD' }] : [],
          asset.id,
        );
      if (weightBps > asset.maxWeightBps)
        warn(
          'OVER_LISTED_CAP',
          reason(
            'MIX_OVER_LISTED',
            { asset: asset.symbol, weightBps, maxBps: asset.maxWeightBps },
            a.language,
          ).text,
          [
            {
              label: 'cap on the asset list',
              value: asset.maxWeightBps,
              unit: 'bps',
              source: entry.source,
              method: 'listed asset catalog',
              fetchedAt: ctx.now,
              provenance: asset.provenance,
            },
          ],
          asset.id,
        );
      // Outside the goal's list, a stock or a fund of stocks is the person's choice, with a warning
      // (gate ANY-COMPOSITION); crypto, gold and any other class stay out of an income or protect plan.
      // The cash token has no ceiling, so it never reaches here; `goalFit` lets it pass all the same.
      // A target the vault already has is its own (accepted when it followed, or set by its owner):
      // kept at its current weight or below it is no change of what the vault may hold, so it is
      // warned about, never refused (VAULT-CHAT-KNOWS-ITS-VAULT). Raised, it is a new target and
      // the goal's rule applies as to any other: a barred class is refused.
      const fit = a.goal ? goalFit(asset, a.goal) : 'fits';
      const own =
        a.vault?.positions.some(
          (held) => held.asset === asset.id && held.targetBps > 0 && weightBps <= held.targetBps,
        ) ?? false;
      if (a.goal && fit !== 'fits') {
        if (fit === 'stock_outside' || own)
          warn(
            'NOT_FOR_GOAL',
            reason('MIX_NOT_FOR_GOAL', { asset: asset.symbol, goal: a.goal }, a.language).text,
            [],
            asset.id,
          );
        else notForGoal.push(`NOT_FOR_GOAL:${asset.id}`);
      }
    }
    return {
      assetId: asset.id,
      symbol: asset.symbol,
      cls: asset.cls,
      weightBps,
      amountUsd,
      price:
        asset.id === ctx.cash.id || !price
          ? null
          : {
              usdPerToken: price.usdPerToken,
              source: price.source,
              method: price.method,
              fetchedAt: price.fetchedAt,
              provenance: price.provenance,
            },
      exitCeiling,
    };
  });
  if (a.vault && (a.vault.recipeOnchainId !== null || a.vault.autoFollow))
    warn('STOPS_FOLLOWING', reason('MIX_STOPS_FOLLOWING', {}, a.language).text, []);
  if (notForGoal.length)
    throw new Refusal(422, 'this vault holds an asset a plan for this goal cannot hold', {
      code: 'MIX_NOT_VALID',
      fix: 'Take out the assets named in details.issues, or choose another goal.',
      details: { issues: notForGoal },
    });
  const accepted = new Set(a.accepted);
  const body = {
    chain: entry.chain,
    origin: a.origin,
    goal: a.goal,
    risk: a.vault ? null : a.risk,
    horizonMonths: a.horizonMonths ?? null,
    amountUsd: a.amountUsd,
    lines,
    targets: checked.targets,
    cashBps: checked.cashBps,
    warnings,
  };
  const review: MixReview = {
    chain: entry.chain,
    origin: a.origin,
    goal: a.goal,
    ...(a.vault ? {} : { risk: a.risk }),
    ...(a.fromMix?.length ? { fromMix: [...a.fromMix] } : {}),
    amountUsd: a.amountUsd,
    lines,
    targets: checked.targets,
    cashBps: checked.cashBps,
    warnings,
    unconfirmed: warnings.map((w) => w.id).filter((id) => !accepted.has(id)),
    reviewHash: reviewHashOf(body, a.vault !== undefined),
    provenance: entry.provenance,
    disclaimer: DISCLAIMER[a.language],
  };
  return { review, sheet, fixed };
}

/**
 * What a confirmation is bound to: the mix, the goal, the amount and every warning with the figures
 * it stands on, as the server reads them now. A confirm that sends another hash, or none, saw other
 * numbers or none, and is answered with the review again. What moves on every read is left out, or
 * no confirm could ever match: the time of a price or of the request, and, for a vault, its value at
 * the prices now (a value that moves a line past a ceiling changes the warnings, and so the hash).
 */
function reviewHashOf(
  review: Pick<
    MixReview,
    'chain' | 'origin' | 'goal' | 'amountUsd' | 'lines' | 'targets' | 'cashBps' | 'warnings'
  > & { risk: string | null; horizonMonths: number | null },
  vault: boolean,
): string {
  return hash({
    kind: 'mix-review-1',
    chain: review.chain,
    origin: review.origin,
    goal: review.goal,
    risk: review.risk,
    horizonMonths: review.horizonMonths,
    amountUsd: vault ? null : review.amountUsd,
    lines: review.lines.map((l) => [
      l.assetId,
      l.weightBps,
      vault ? null : l.amountUsd,
      l.exitCeiling ? [l.exitCeiling.usd, l.exitCeiling.measured, l.exitCeiling.source] : null,
    ]),
    targets: review.targets,
    cashBps: review.cashBps,
    warnings: review.warnings.map((w) => [
      w.id,
      w.figures.map((f) => [f.label, f.value, f.unit, f.source, f.method, f.provenance]),
    ]),
  });
}

/** The person confirmed this review: `confirm`, its hash, and every warning it carries accepted. */
export const confirmedReview = (
  review: MixReview,
  body: { confirm: boolean; reviewHash?: string | undefined },
) => body.confirm && body.reviewHash === review.reviewHash && review.unconfirmed.length === 0;

/** Cents split by weights: each rounded down, the rest a cent at a time to the largest remainders. */
function splitCents(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((n, w) => n + w, 0);
  const shares = weights.map((w) => Math.floor((total * w) / sum));
  let left = total - shares.reduce((n, s) => n + s, 0);
  const order = weights
    .map((w, i) => ({ i, rest: (total * w) % sum }))
    .sort((x, y) => y.rest - x.rest || x.i - y.i);
  for (const { i } of order) {
    if (left-- <= 0) break;
    shares[i] = (shares[i] ?? 0) + 1;
  }
  return shares;
}

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * The mix as a stored plan in the engine's shape, so `POST /v1/orders` buys it as it buys any plan:
 * one recipe on the chain whose components are the targets, the cash share left out of them. The
 * lines are the person's weights unchanged. `inputsHash` takes the person, so the same mix stored
 * again by them is the same plan, and nobody else's.
 */
export function mixProposal(
  ctx: MixContext,
  reviewed: ReturnType<typeof reviewMix>,
  checked: CheckedMix,
  a: { person: string; origin: MixOrigin; accepted: readonly string[]; language: Language },
): BasketProposal {
  const { review, sheet, fixed } = reviewed;
  const accepted = [...new Set(a.accepted)].filter((id) =>
    review.warnings.some((w) => w.id === id),
  );
  const lines = fixed.lines.map((l) => l.line);
  const prices: ObservationRef[] = [...checked.prices.values()]
    .filter((p) => checked.targets.some((t) => t.asset === p.asset))
    .map((p) => ({
      id: p.asset,
      kind: 'price',
      source: p.source,
      method: p.method,
      fetchedAt: p.fetchedAt,
      provenance: p.provenance,
    }));
  const observations = [
    ...fixed.observations.filter(sourced).map((o) => ({ ...o })),
    ...prices,
  ] as ObservationRef[];
  return BasketProposal.parse({
    sheet,
    engineVersion: MIX_VERSION,
    paramsHash: hash(PERSONAL_PARAMS),
    shelfVersion: ctx.prepared.shelf.version,
    inputsHash: hash({
      kind: MIX_VERSION,
      person: a.person,
      sheet,
      origin: a.origin,
      lines: lines.map((l) => [l.assetId, l.weightBps]),
      accepted: [...accepted].sort(),
      shelf: ctx.prepared.shelf.version,
    }),
    lines,
    recipes: [
      {
        chain: ctx.entry.chain,
        amountUsd: sheet.amountUsd,
        components: checked.targets.map((t) => ({
          kind: 'asset',
          asset: t.asset,
          weightBps: t.weightBps,
        })),
      },
    ],
    removed: [],
    card: fixed.card,
    flags: [
      ...fixed.flags,
      `origin:${a.origin}`,
      ...review.warnings.map((w) => `confirmed:${w.id}`),
      // what the person did not say and the server worked out from the mix (DEPOSIT-DERIVE)
      ...(review.fromMix ?? []).map((kind) => `from_mix:${kind}`),
    ],
    observations,
    disclaimer: DISCLAIMER[a.language],
    origin: a.origin,
  });
}

/** What the vault is worth at the review's prices: cash at one dollar, as the vault counts it. */
export function vaultValueUsd(vault: VaultState, prices: Map<string, Price>): number {
  const cents = [vault.cash, ...vault.positions].reduce((n, h) => {
    if (BigInt(h.raw) === 0n) return n;
    const usd = h.asset === vault.cash.asset ? 1 : Number(prices.get(h.asset)?.usdPerToken ?? NaN);
    return n + Math.floor(Number(h.display) * usd * 100);
  }, 0);
  if (!Number.isFinite(cents)) throw new Error('a held asset was not priced');
  return cents / 100;
}

/**
 * The minimums of a leg's trades, as `expectedOf` states them, held to the chain's own floor where the
 * chain has one. On EVM a quote states the feed's floor (`floorRaw`: what the reference price says the
 * trade is worth, less `priceBoundBps`), and the builder refuses a stated minimum under it
 * (`PriceMoved`). So a trade's minimum is the higher of the order's and that floor; the quote's own
 * slippage (`minOutRaw`) is not taken, since the purchases after a sale are sized on the order's
 * slippage. A trade the pool pays less for than the floor is not ordered:
 * every build of it would be refused. A trade over the network's largest trade of its asset is not
 * ordered either: no rebalance of that size can be made in one order (`TRADE_TOO_LARGE`). A pair traded twice in one leg keeps `expectedOf`'s minimum,
 * since its quote is of the two together; a rebalance never trades a pair twice. Solana's quote has
 * no feed floor, and its minimum is the order's slippage alone, so nothing is changed there.
 */
async function expectedHeld(
  entry: ChainEntry,
  trades: Trade[],
  taker: Address,
  slippageBps: number,
  a: { symbol: (id: string) => string; cash: string },
): Promise<Leg['expected']> {
  const { symbol } = a;
  if (entry.config.family !== 'evm') return expectedOf(entry, trades, taker, slippageBps);
  const pairs = new Map<string, number>();
  for (const t of trades)
    pairs.set(`${t.sell}>${t.buy}`, (pairs.get(`${t.sell}>${t.buy}`) ?? 0) + 1);
  const assetOf = (t: Trade) => (t.sell === a.cash ? t.buy : t.sell);
  // Each trade quoted by itself first: the chain's floor, and a trade the chain will not take at all.
  const floors: (bigint | null)[] = [];
  for (const t of trades) {
    if (pairs.get(`${t.sell}>${t.buy}`) !== 1) {
      floors.push(null);
      continue;
    }
    try {
      const { floorRaw } = await entry.adapter.quote(t, taker);
      floors.push(floorRaw === undefined ? null : BigInt(floorRaw));
    } catch (e) {
      // Larger than the network's largest trade of the asset (`maxTradeUsd`): the same plan is
      // refused every time, so this is said as it is, and not as something to try again.
      if (e instanceof ChainError && e.code === 'TradeOverAssetLimit')
        throw new Refusal(
          422,
          `this rebalance needs a trade of ${symbol(assetOf(t))} larger than ${entry.config.name} takes in one go`,
          {
            fix: 'Rebalance by hand in smaller steps, or wait for the limit to rise.',
            details: { retryable: false, issues: [`TRADE_TOO_LARGE:${assetOf(t)}`] },
          },
        );
      // Over the smaller limit while the reference price is not live (a closed market): the same
      // trade passes once it is.
      if (e instanceof ChainError && e.code === 'TradeOverClosedLimit')
        throw new Refusal(
          409,
          `${symbol(assetOf(t))}'s market is closed, and a trade this size waits until it opens`,
          {
            fix: 'Rebalance again once the market is open.',
            details: { retryable: true, issues: [`TRADE_WAITS_FOR_OPEN:${assetOf(t)}`] },
          },
        );
      throw e;
    }
  }
  const expected = await expectedOf(entry, trades, taker, slippageBps);
  const held: Leg['expected'] = [];
  for (const [i, t] of trades.entries()) {
    const e = expected[i];
    const floor = floors[i] ?? null;
    if (!e) continue;
    if (floor === null) {
      held.push(e);
      continue;
    }
    if (floor > BigInt(e.outRaw))
      throw new Refusal(
        409,
        `${symbol(t.sell)} into ${symbol(t.buy)} can't be traded now: the pool gives less than the reference price allows`,
        {
          code: 'PRICE_MOVED',
          fix: 'Try again later, once the pool is back near the reference price.',
          details: { retryable: true, issues: [`PRICE_BOUND:${assetOf(t)}`] },
        },
      );
    held.push(floor > BigInt(e.minOutRaw) ? { ...e, minOutRaw: floor.toString() } : e);
  }
  return held;
}

/** Each asset's and the cash's share of the vault, in bps, at these prices; null where unpriced. */
function sharesOf(vault: VaultState, prices: Map<string, Price>) {
  const usd = (h: { asset: string; display: string }) =>
    Number(h.display) *
    (h.asset === vault.cash.asset ? 1 : Number(prices.get(h.asset)?.usdPerToken ?? Number.NaN));
  const values = new Map<string, number>();
  for (const p of vault.positions)
    if (BigInt(p.raw) > 0n) values.set(p.asset, (values.get(p.asset) ?? 0) + usd(p));
  const cash = usd(vault.cash);
  const total = [...values.values()].reduce((n, v) => n + v, cash);
  if (!(total > 0) || !Number.isFinite(total)) return null;
  return { values, cash, total };
}

/** `outsideOwnerBand` at these prices, for the targets given. */
function outsideBand(
  vault: VaultState,
  targets: Target[],
  prices: Map<string, Price>,
  slippageBps: number,
): boolean {
  const shares = sharesOf(vault, prices);
  if (!shares) return true;
  const target = new Map(targets.map((t) => [t.asset, t.weightBps]));
  const ids = new Set([...target.keys(), ...shares.values.keys()]);
  const bps = (usd: number) => (usd / shares.total) * 10_000;
  const cashShare = 10_000 - targets.reduce((n, t) => n + t.weightBps, 0);
  return outsideOwnerBand(
    [...ids].map((id) => ({
      targetBps: target.get(id) ?? 0,
      weightBps: bps(shares.values.get(id) ?? 0),
    })),
    bps(shares.cash) - cashShare,
    slippageBps,
  );
}

const pct = (bps: number) =>
  `${(bps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;

/**
 * The order that gives a vault the person owns its own targets, and trades it to them: `set_targets`,
 * then the sales and then the purchases of `rebalancePlan` at the prices now, as many per step as the
 * chain takes. Purchases count on each sale losing up to the order's slippage, so the cash is there.
 * Every trade states its minimum, as a buy's do. The vault's auto-follow goes off with its own targets,
 * on chain, so the keeper does not trade it meanwhile.
 *
 * With `keepTargets`, the targets are the vault's own as the chain has them and are not set again: the
 * order is the trades alone, so a vault that follows a shared portfolio goes on following it
 * (`planVaultRebalance`), and with nothing to trade it has no step.
 */
export async function planRetarget(
  ctx: Pick<MixContext, 'entry' | 'assets' | 'cash'>,
  vault: VaultState,
  checked: Pick<CheckedMix, 'targets' | 'prices' | 'cashBps'>,
  a: {
    slippageBps: number;
    now: string;
    /** The signed-in wallet that owns the vault, as the sign-in names it: the order's owner. */
    owner: Address;
    keepTargets?: boolean;
  },
): Promise<{ order: Order; request: Extract<IntentRequest, { type: 'rebalance' }> }> {
  const { entry } = ctx;
  assertBuilds(entry);
  // New targets trade up to the whole vault; a rebalance is judged by its trades, below.
  if (!a.keepTargets && vaultValueUsd(vault, checked.prices) > ORDER_LIMITS.maxAmountUsd)
    throw new Refusal(422, 'this vault is worth more than one order may move', {
      code: 'MIX_NOT_VALID',
      details: { issues: ['OVER_ORDER_LIMIT'] },
    });
  let trades: Trade[];
  try {
    const plan = rebalancePlan(
      vault,
      checked.targets,
      [...checked.prices.values()],
      // Its own new targets are traded to whatever the distance; a rebalance only once outside the band.
      // a rebalance makes no trade smaller than the smallest line a plan holds
      {
        bandBps: a.keepTargets ? OWNER_REBALANCE_BAND_BPS : 0,
        minTradeUsd: a.keepTargets ? OWNER_REBALANCE_MIN_TRADE_USD : 1,
        costBps: a.slippageBps,
      },
      ctx.assets,
    );
    if (!plan.weighed || plan.unpriced.length)
      throw new Refusal(409, 'the vault cannot be valued now: an asset it holds has no price', {
        details: { retryable: true },
      });
    trades =
      a.keepTargets && !outsideBand(vault, checked.targets, checked.prices, a.slippageBps)
        ? []
        : plan.trades;
  } catch (e) {
    if (e instanceof RebalanceError)
      throw new Refusal(409, `the vault cannot be planned: ${e.message}`);
    throw e;
  }
  const symbol = (id: string) => ctx.assets.find((x) => x.id === id)?.symbol ?? id;
  if (a.keepTargets) {
    // One order moves at most `ORDER_LIMITS.maxAmountUsd`: of sales, or of purchases.
    const usdOf = (t: Trade) => {
      if (t.sell === ctx.cash.id) return Number(t.amountInRaw) / 10 ** ctx.cash.decimals;
      const decimals = ctx.assets.find((x) => x.id === t.sell)?.decimals ?? 0;
      return (
        (Number(t.amountInRaw) / 10 ** decimals) *
        Number(checked.prices.get(t.sell)?.usdPerToken ?? Number.NaN)
      );
    };
    const sold = trades.filter((t) => t.buy === ctx.cash.id).reduce((n, t) => n + usdOf(t), 0);
    const bought = trades.filter((t) => t.sell === ctx.cash.id).reduce((n, t) => n + usdOf(t), 0);
    if (!(Math.max(sold, bought) <= ORDER_LIMITS.maxAmountUsd))
      throw new Refusal(422, 'this rebalance trades more than one order may move', {
        code: 'MIX_NOT_VALID',
        details: { issues: ['OVER_ORDER_LIMIT'] },
      });
  }
  const id = randomUUID();
  const { owner } = a;
  const said = (group: Trade[], after = false) =>
    group
      .map((t) =>
        t.buy === ctx.cash.id
          ? `${after ? 'sell' : 'Sell'} ${symbol(t.sell)} for cash`
          : `${after ? 'swap' : 'Swap'} into ${symbol(t.buy)}`,
      )
      .join(', ');
  const groups = batchTrades(trades, entry.adapter.capabilities.maxTradesPerTx);
  // Where the chain takes them in one transaction, the first trades ride with the targets they trade
  // toward (gate EVM-MULTICALL-STEPS); elsewhere the targets are a step of their own.
  const riding = !a.keepTargets && entry.adapter.capabilities.ownerCallsInOne ? groups.shift() : [];
  const setTargets = `Set your vault's targets: ${checked.targets
    .map((t) => `${symbol(t.asset)} ${pct(t.weightBps)}`)
    .join(', ')}${checked.cashBps ? `, and ${pct(checked.cashBps)} in cash` : ''}`;
  const steps: Array<Pick<Leg, 'kind' | 'description' | 'trades'>> = [
    ...(a.keepTargets
      ? []
      : [
          {
            kind: 'set_targets' as const,
            description: riding?.length ? `${setTargets}; then ${said(riding, true)}` : setTargets,
            trades: riding ?? [],
          },
        ]),
    ...groups.map((group) => ({
      kind: 'swap' as const,
      description: said(group),
      trades: group,
    })),
  ];
  const legs: Leg[] = [];
  for (const [seq, step] of steps.entries())
    legs.push({
      id: randomUUID(),
      orderId: id,
      chain: entry.chain,
      seq,
      ...step,
      signer: 'owner',
      expected: await expectedHeld(entry, step.trades, owner, a.slippageBps, {
        symbol,
        cash: ctx.cash.id,
      }),
      status: 'planned',
      attempt: 0,
      txId: null,
      explorerUrl: null,
      validUntil: null,
      error: null,
      trigger: 'manual',
      provenance: entry.provenance,
    });
  const order: Order = {
    id,
    type: 'rebalance',
    owner: { [chainFamily(entry.chain)]: owner },
    summary: a.keepTargets
      ? `Rebalance your vault on ${entry.config.name} to its targets`
      : `Apply your new targets to your vault on ${entry.config.name}`,
    basketId: vault.basketId,
    legs,
    warnings: [],
    needsConsent: [],
    fees: [],
    preparedBy: 'app',
    status: 'open',
    approvalUrl: `/orders/${id}`,
    expiresAt: Math.floor(Date.parse(a.now) / 1000) + ORDER_POLICY.unsignedSeconds,
    createdAt: a.now,
    disclaimer: DISCLAIMER.en,
  };
  return {
    order,
    request: {
      type: 'rebalance',
      vaults: [vault.address],
      reason: 'manual',
      targets: checked.targets,
      maxSlippageBps: a.slippageBps,
    },
  };
}

/**
 * The order that brings what a vault holds to the targets it has on chain now, and changes nothing
 * else (the one-press rebalance of HANDOFF-VAULT, MVP item 6): the sales and then the purchases of
 * `rebalancePlan` at the prices now. No target is set, so a vault that follows a shared portfolio goes
 * on following it, and no goal is read: the targets are the vault's already. Null where there is
 * nothing to trade: every asset within `OWNER_REBALANCE_BAND_BPS` of its target, and the cash no
 * more than that over its share.
 *
 * Refused: a vault with no target; one with auto-follow on where the chain runs a keeper, whose work
 * this is and who would trade alongside; a target or a holding with no price the vault can trade on;
 * a vault worth more than one order may move.
 */
export async function planVaultRebalance(
  entry: ChainEntry,
  vault: VaultState,
  a: {
    slippageBps: number;
    now: string;
    owner: Address;
    /**
     * For a quote only (`quoteVaultRebalance`): the targets the vault would have, in place of its own,
     * as after following a shared portfolio. An order is never made from these.
     */
    targets?: Target[];
  },
): Promise<{
  targets: Target[];
  planned: { order: Order; request: Extract<IntentRequest, { type: 'rebalance' }> } | null;
}> {
  assertBuilds(entry);
  const targets = a.targets ?? ownTargets(vault);
  if (!targets.length)
    throw new Refusal(409, 'this vault has no targets to rebalance to', {
      fix: 'Choose what the vault holds first.',
      details: { retryable: false, issues: ['NO_TARGETS'] },
    });
  if (vault.autoFollow && entry.adapter.capabilities.autoFollow)
    throw new Refusal(
      409,
      `auto-follow is on for this vault, so the keeper on ${entry.config.name} rebalances it`,
      {
        fix: 'Switch auto-follow off to rebalance it yourself.',
        details: { retryable: false, issues: ['AUTO_FOLLOW_ON'] },
      },
    );
  const assets = await entry.adapter.listAssets();
  const byId = new Map(assets.map((x) => [x.id, x]));
  const cash = byId.get(vault.cash.asset);
  if (!cash) throw new Error(`${entry.chain} does not list the vault's cash token`);
  const held = vault.positions.filter((p) => BigInt(p.raw) > 0n).map((p) => p.asset);
  const ids = [...new Set([...targets.map((t) => t.asset), ...held])];
  const prices = new Map<string, Price>();
  for (const price of await entry.adapter.getPrices(ids.filter((id) => byId.has(id))))
    prices.set(price.asset, price);
  const unpriced = ids.filter((id) => {
    const asset = byId.get(id);
    return !asset || !usable(asset, prices.get(id));
  });
  if (unpriced.length)
    throw new Refusal(
      409,
      `the vault cannot be rebalanced now: ${unpriced.join(', ')} has no price it can trade on`,
      { details: { retryable: true, issues: unpriced.map((id) => `NO_PRICE:${id}`) } },
    );
  const cashBps = 10_000 - targets.reduce((n, t) => n + t.weightBps, 0);
  const planned = await planRetarget(
    { entry, assets, cash },
    vault,
    { targets, prices, cashBps },
    { slippageBps: a.slippageBps, now: a.now, owner: a.owner, keepTargets: true },
  );
  return { targets, planned: planned.order.legs.length ? planned : null };
}

/**
 * A step of a rebalance, held again to the vault as it is when the step is built: its trades were
 * sized when the order was made, and the vault may have moved since (another order landed first, an
 * old order taken up again). Refused where auto-follow is on and the chain runs a keeper, and where a
 * trade would take an asset past its target: a purchase over it by more than the owner's band, or a
 * sale under it by more than the band and the order's slippage, at the reference prices now. A
 * purchase's worth does not move with the price, so its allowance is the band alone.
 */
async function heldAtBuild(
  entry: ChainEntry,
  vault: VaultState,
  leg: Leg,
  slippageBps: number,
): Promise<void> {
  if (vault.autoFollow && entry.adapter.capabilities.autoFollow)
    throw new Refusal(
      409,
      `auto-follow is on for this vault now, so the keeper on ${entry.config.name} rebalances it`,
      {
        fix: 'Switch auto-follow off to rebalance it yourself.',
        details: { retryable: false, issues: ['AUTO_FOLLOW_ON'] },
      },
    );
  const cashId = vault.cash.asset;
  const ids = [
    ...new Set([
      ...vault.positions.map((p) => p.asset),
      ...leg.trades.flatMap((t) => [t.sell, t.buy]),
    ]),
  ].filter((id) => id !== cashId);
  const [assets, prices] = await Promise.all([
    entry.adapter.listAssets(),
    entry.adapter.getPrices(ids),
  ]);
  const priced = new Map(prices.map((p) => [p.asset, p]));
  const shares = sharesOf(vault, priced);
  if (!shares) return;
  const target = new Map(ownTargets(vault).map((t) => [t.asset, t.weightBps]));
  const decimals = new Map(assets.map((x) => [x.id, x.decimals]));
  const usd = (asset: string, raw: string) =>
    (Number(raw) / 10 ** (decimals.get(asset) ?? 0)) *
    (asset === cashId ? 1 : Number(priced.get(asset)?.usdPerToken ?? Number.NaN));
  const bps = (value: number) => (value / shares.total) * 10_000;
  for (const t of leg.trades) {
    const buys = t.sell === cashId;
    const asset = buys ? t.buy : t.sell;
    const now = shares.values.get(asset) ?? 0;
    const moved = usd(t.sell, t.amountInRaw);
    if (!Number.isFinite(moved)) continue;
    const after = bps(buys ? now + moved : now - moved);
    const goal = target.get(asset) ?? 0;
    const past = buys
      ? after - goal > OWNER_REBALANCE_BAND_BPS
      : goal > 0 && goal - after > OWNER_REBALANCE_BAND_BPS + slippageBps;
    if (past)
      throw new Refusal(
        409,
        `this step would take ${asset} past its target: the vault has moved since the order was made`,
        {
          fix: 'Rebalance again: the new order trades from what the vault holds now.',
          details: { retryable: false, issues: [`PAST_TARGET:${asset}`] },
        },
      );
  }
}

/** The targets a vault has on chain, those above zero. */
const ownTargets = (vault: VaultState): Target[] =>
  vault.positions
    .filter((p) => p.targetBps > 0)
    .map((p) => ({ asset: p.asset, weightBps: p.targetBps }));

const cents = (usd: number) => (Math.round(Math.max(usd, 0) * 100) / 100).toString();

/**
 * What a rebalance of the vault would trade now, as figures to show before anything is signed, and
 * nothing stored: each trade with what it is quoted to give and the least an order would take, each
 * holding's share before and after against its target, and what the trades are quoted to cost
 * together. `targets`: the weights the vault would have (a shared portfolio's version in effect, before
 * the vault follows it); left out, its own. The plan is `planVaultRebalance`'s, so an order made next
 * with the vault and the prices unchanged trades exactly this. Where no order could be made, the
 * answer says why and still gives the holdings against the targets.
 */
export async function quoteVaultRebalance(
  entry: ChainEntry,
  vault: VaultState,
  a: { slippageBps: number; now: string; owner: Address; targets?: Target[]; version?: number },
): Promise<RebalanceQuoteResponse> {
  const targets = a.targets ?? ownTargets(vault);
  let trades: Array<Trade & { expected: Leg['expected'][number] }> = [];
  let unavailable: RebalanceQuoteResponse['unavailable'] = null;
  try {
    const { planned } = await planVaultRebalance(entry, vault, a);
    trades = (planned?.order.legs ?? []).flatMap((leg) =>
      leg.trades.flatMap((t, i) => {
        const expected = leg.expected[i];
        return expected ? [{ ...t, expected }] : [];
      }),
    );
  } catch (e) {
    // Why no order could be made is the answer, not an error: the review says it.
    if (!(e instanceof Refusal) && !(e instanceof ChainError)) throw e;
    const refusal = e instanceof Refusal ? e.body() : null;
    unavailable = {
      reason: e.message,
      issues:
        refusal?.details?.issues ??
        (refusal?.details?.chainCode
          ? [refusal.details.chainCode]
          : e instanceof ChainError
            ? [e.code]
            : []),
    };
  }
  const assets = await entry.adapter.listAssets();
  const decimals = new Map(assets.map((x) => [x.id, x.decimals]));
  const cashId = vault.cash.asset;
  const ids = [
    ...new Set([...targets.map((t) => t.asset), ...vault.positions.map((p) => p.asset)]),
  ];
  const prices = await entry.adapter.getPrices(ids.filter((id) => decimals.has(id)));
  const usdOf = new Map(prices.map((p) => [p.asset, Number(p.usdPerToken)]));
  const worth = (asset: string, raw: string): number => {
    const d = decimals.get(asset);
    const usd = asset === cashId ? 1 : usdOf.get(asset);
    return d === undefined || usd === undefined ? Number.NaN : (Number(raw) / 10 ** d) * usd;
  };
  const before = new Map<string, number>([[cashId, worth(cashId, vault.cash.raw)]]);
  for (const p of vault.positions)
    if (BigInt(p.raw) > 0n) before.set(p.asset, (before.get(p.asset) ?? 0) + worth(p.asset, p.raw));
  const after = new Map(before);
  let cost = 0;
  const quoted = trades.map((t) => {
    const value = worth(t.sell, t.amountInRaw);
    const out = worth(t.buy, t.expected.outRaw);
    after.set(t.sell, (after.get(t.sell) ?? 0) - value);
    after.set(t.buy, (after.get(t.buy) ?? 0) + out);
    cost += (value * t.expected.costBps) / 10_000;
    return {
      sell: t.sell,
      buy: t.buy,
      amountInRaw: t.amountInRaw,
      valueUsd: cents(value),
      expectedOutRaw: t.expected.outRaw,
      minOutRaw: t.expected.minOutRaw,
      costBps: t.expected.costBps,
    };
  });
  const sum = (m: Map<string, number>) => [...m.values()].reduce((n, v) => n + v, 0);
  const valued = Number.isFinite(sum(before)) && sum(before) > 0;
  const share = (m: Map<string, number>, id: string) => {
    const total = sum(m);
    const bps = Math.round(((m.get(id) ?? 0) / total) * 10_000);
    return valued && Number.isFinite(bps) ? Math.min(Math.max(bps, 0), 10_000) : 0;
  };
  const targetOf = new Map(targets.map((t) => [t.asset, t.weightBps]));
  const cashTarget = Math.max(10_000 - targets.reduce((n, t) => n + t.weightBps, 0), 0);
  const listed = [cashId, ...new Set([...targets.map((t) => t.asset), ...before.keys()])].filter(
    (id, i, all) => all.indexOf(id) === i,
  );
  return {
    status: unavailable ? 'unavailable' : quoted.length ? 'quoted' : 'on_target',
    chain: entry.chain,
    provenance: entry.provenance,
    version: a.version ?? null,
    targets,
    slippageBps: a.slippageBps,
    valueUsd: valued ? cents(sum(before)) : null,
    trades: quoted,
    holdings: listed.map((asset) => ({
      asset,
      cash: asset === cashId,
      targetBps: asset === cashId ? cashTarget : (targetOf.get(asset) ?? 0),
      beforeBps: share(before, asset),
      afterBps: share(after, asset),
    })),
    costUsd: unavailable ? null : cents(cost),
    prices,
    quote: {
      source: entry.source,
      fetchedAt: a.now,
      method:
        'each trade quoted by the chain adapter for the amount it puts in; the cost is the quote against the reference price, and the minimum is the quote less the slippage',
      provenance: entry.provenance,
    },
    unavailable,
    quotedAt: a.now,
    disclaimer: DISCLAIMER.en,
  };
}

/**
 * One step of an order that applies a vault's own targets, built from the vault as it is now. The
 * vault is held to the order's owner again; the targets are the ones the order was made with, and a
 * trade carries the minimum the order stated, never another. `keepsTargets`: the order sets no target
 * (`planVaultRebalance`), so its trades were sized for the targets the vault had: built only while
 * the vault still has exactly those.
 */
export async function buildRetarget(
  request: Extract<IntentRequest, { type: 'rebalance' }>,
  leg: Leg,
  entry: ChainEntry,
  owner: Address,
  nonce: number | undefined,
  keepsTargets = false,
): Promise<BuiltTx> {
  const [address] = request.vaults;
  if (!address || !request.targets?.length || request.maxSlippageBps === undefined)
    throw new Refusal(501, 'a rebalance order cannot be built yet');
  const vault = await entry.adapter.getVault(address);
  const family = entry.config.family;
  const same = (x: string, y: string) => {
    try {
      return normalizeAddress(family, x) === normalizeAddress(family, y);
    } catch {
      return false;
    }
  };
  if (!vault || !same(vault.owner, owner))
    throw new Refusal(404, 'no vault of yours at that address');
  const at = nonce === undefined ? {} : { nonce };
  if (leg.kind === 'set_targets') {
    // Where the chain takes them in one transaction, the trades toward the targets ride after them
    // (gate EVM-MULTICALL-STEPS), each at the minimum the order stated.
    if (!leg.trades.length)
      return entry.adapter.buildSetTargets({
        vault: vault.address,
        targets: request.targets,
        ...at,
      });
    if (leg.expected.length !== leg.trades.length)
      throw new Refusal(409, 'this step states no minimum for its trades: make the order again');
    return entry.adapter.buildSetTargets({
      vault: vault.address,
      targets: request.targets,
      trades: leg.trades,
      slippageBps: request.maxSlippageBps,
      minimums: leg.expected.map((e) => e.minOutRaw),
      ...at,
    });
  }
  if (leg.kind !== 'swap' || !leg.trades.length)
    throw new Refusal(501, `a ${leg.kind} step of a rebalance cannot be built`);
  if (keepsTargets) {
    const now = new Map(ownTargets(vault).map((t) => [t.asset, t.weightBps]));
    const same =
      now.size === request.targets.length &&
      request.targets.every((t) => now.get(t.asset) === t.weightBps);
    if (!same)
      throw new Refusal(409, "the vault's targets changed since this order was made", {
        fix: 'Rebalance again: the new order trades to the targets the vault has now.',
        details: { retryable: false, issues: ['TARGETS_CHANGED'] },
      });
    await heldAtBuild(entry, vault, leg, request.maxSlippageBps);
  }
  if (leg.expected.length !== leg.trades.length)
    throw new Refusal(409, 'this step states no minimum for its trades: make the order again');
  return entry.adapter.buildOwnerSwap({
    vault: vault.address,
    trades: leg.trades,
    slippageBps: request.maxSlippageBps,
    minimums: leg.expected.map((e) => e.minOutRaw),
    ...at,
  });
}
