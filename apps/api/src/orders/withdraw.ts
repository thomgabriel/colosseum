import { batchTrades } from '@colosseum/basket';
import {
  type Address,
  type AssetId,
  type BasketAsset,
  type BuiltTx,
  type Chain,
  ChainError,
  type ChainErrorCode,
  type ChainId,
  type IntentRequest,
  isAddressOf,
  type Leg,
  type LegWithdrawal,
  type Order,
  type Principal,
  type Trade,
  type VaultState,
  WITHDRAW_DOLLARS_MARGIN_BPS,
} from '@colosseum/schemas';
import { assertBuilds, type ChainEntry, type ChainRegistry } from './chains';
import { Refusal } from './errors';
import { HOME_CHAIN } from './person';
import { lessBps, ORDER_POLICY } from './prepare';

// A withdrawal: tokens leave a vault as they are, for the wallet of the vault's owner and nobody
// else (DESIGN-VAULT section 5: the owner can always withdraw every token in kind). The program and
// the contract pay only the owner; here the order is refused before anything is built unless the
// vault is the signed-in person's, and no step is built for more of a token than the vault holds at
// that moment.
//
// Or in dollars (gate WITHDRAW-DOLLARS, Thom, Oct 13): `sellToCash` sells the vault's holdings for the
// chain's cash token with the owner's own swap, each sale stating its minimum, and then withdraws the
// cash, to the owner as before. No program or contract knows of it: it is the owner's swap and the
// owner's withdrawal, one after the other, and each is signed by the owner. A holding that cannot be
// sold now is left in the vault and said, never forced; the tokens themselves always leave in kind.

export type WithdrawRequest = Extract<IntentRequest, { type: 'withdraw' }>;

/** Said to a person, as it is: a withdrawal in dollars names no tokens. */
export const DOLLARS_TAKE_A_SHARE =
  'A withdrawal in dollars takes a share of everything the vault holds: name a share, not tokens';

/** Said to a person, as it is: only a withdrawal in dollars takes a share or a slippage. */
export const SHARE_IS_FOR_DOLLARS =
  'A share of the vault is for a withdrawal in dollars: name the tokens and amounts instead';

/**
 * The refusals of a quote that say this one holding cannot be sold now: its market is closed with no
 * usable average, its pool is too far from the reference, the sale is larger than its pool is trusted
 * to fill, it has no price or no pool. The holding is left in the vault and the rest goes on. Anything
 * else (a node that did not answer, an error with no name) refuses the whole order: a holding is never
 * left out on a guess.
 */
const NOT_SOLD_NOW: ReadonlySet<string> = new Set([
  'BadTrade',
  'PriceStale',
  'PriceDeviation',
  'PriceOutOfRange',
  'AssetNotPriced',
  'MarketClosed',
  'MintNotAccepted',
  'HookNotAllowed',
  'BalanceUnreadable',
  'NotSupported',
]);

/** Said to a person, as it is, for an amount of a token whose units the app does not list. */
export const WHOLE_TOKEN_ONLY = 'All of it or none: this app doesn’t know this token’s units';

/**
 * A step that cannot be built because its one token cannot move now: its account is frozen by its
 * issuer, it carries a transfer hook this builder does not resolve, or the chain refuses it for that
 * token alone. The step is marked skipped with this reason, and the order's other steps go on
 * (DESIGN-VAULT section 5: one token that cannot move does not stop the others).
 */
export class SkippedStep extends Refusal {
  constructor(
    readonly code: ChainErrorCode,
    readonly reason: string,
  ) {
    super(409, `this step is skipped: ${reason}`, {
      fix: 'The rest of the withdrawal goes on. This token stays in the vault.',
      details: { chainCode: code, retryable: false },
    });
  }
}

/**
 * The only refusals that are a skip: the ones that say the token itself cannot move. Its account is
 * frozen or cannot be read (`BalanceUnreadable`), or it carries a transfer hook this builder does not
 * resolve (`NotSupported`, the one thing a withdrawal's builder says it for). Anything else (a wallet
 * short of the fee, a node that did not answer, an error with no name) is the step's own refusal,
 * with its sentence, and the step can be built again: a skip is final, so it is never guessed.
 */
const A_SKIP: ReadonlySet<string> = new Set(['BalanceUnreadable', 'NotSupported']);

type Context = {
  principal: Principal;
  chains: ChainRegistry;
  /** When the order is made, as an ISO instant: the time on the value of what is cash. */
  now?: string;
};

/** A decimal string as a fraction of whole numbers. */
function fraction(decimal: string): { num: bigint; den: bigint } {
  const [whole = '0', places = ''] = decimal.split('.');
  return { num: BigInt(`${whole}${places}`), den: 10n ** BigInt(places.length) };
}

/**
 * What each withdrawal is worth in dollars as the order is made, to the cent, rounded down, with where
 * the price came from: the amount it names, or all that is held, at the chain's reference price now
 * (which already carries a stock token's multiplier); cash at one dollar, as the vault counts it. A
 * token with no price is given no value, and a chain that cannot be asked gives none to any: a figure
 * is never made up. The portfolio counts what was taken out from these.
 */
async function valuer(
  entry: ChainEntry,
  assets: Awaited<ReturnType<ChainEntry['adapter']['listAssets']>>,
  taken: LegWithdrawal[],
  now: string,
): Promise<(w: LegWithdrawal) => LegWithdrawal['valued']> {
  const listed = new Map(assets.map((a) => [a.id, a]));
  const priced = taken
    .map((w) => listed.get(w.asset))
    .filter((a) => a !== undefined && a.cls !== 'cash' && a.priceKind !== 'none')
    .map((a) => (a as (typeof assets)[number]).id);
  const prices = priced.length
    ? await entry.adapter.getPrices(priced).catch((e: unknown) => {
        if (e instanceof ChainError) return [];
        throw e;
      })
    : [];
  const cents = (raw: bigint, decimals: number, usd: string) => {
    const { num, den } = fraction(usd);
    const c = (raw * num * 100n) / (den * 10n ** BigInt(decimals));
    return `${c / 100n}.${(c % 100n).toString().padStart(2, '0')}`;
  };
  return (w) => {
    const asset = listed.get(w.asset);
    if (!asset) return undefined;
    const raw = BigInt(w.amountRaw ?? w.heldRaw);
    if (asset.cls === 'cash')
      return {
        usd: cents(raw, asset.decimals, '1'),
        source: entry.source,
        method: 'the amount of the dollar token, counted at one dollar as the vault counts it',
        fetchedAt: now,
        provenance: entry.provenance,
      };
    const price = prices.find((p) => p.asset === w.asset);
    if (!price) return undefined;
    return {
      usd: cents(raw, asset.decimals, price.usdPerToken),
      source: price.source,
      method: `the amount at the reference price when the withdrawal was ordered (${price.method})`,
      fetchedAt: price.fetchedAt,
      provenance: price.provenance,
    };
  };
}

/** The one vault of the order, on its own chain, held to being the signed-in person's. */
async function ownVault(
  req: WithdrawRequest,
  ctx: Context,
): Promise<{ entry: ChainEntry; family: Chain; vault: VaultState }> {
  const [address, ...more] = req.vaults;
  if (!address || more.length)
    throw new Refusal(422, 'one vault per withdrawal: make an order for each');
  // The vault's own chain, named by its address, whatever the person's current chain is.
  const family = (['solana', 'evm'] as const).find((f) => isAddressOf(f, address));
  if (!family) throw new Refusal(422, 'that is not a vault address');
  const entry = ctx.chains.get(HOME_CHAIN[family]);
  assertBuilds(entry);
  const vault = await entry.adapter.getVault(address);
  // A stranger's vault answers as one that is not there: its address says nothing to anybody else.
  const mine = ctx.principal.wallets.some((w) => w.family === family && w.address === vault?.owner);
  if (!vault || !mine) throw new Refusal(404, 'no vault of yours at that address');
  return { entry, family, vault };
}

/** What the vault holds of each token, cash first, as the chain says now. Nothing held is left out. */
const holdingsOf = (vault: VaultState): Map<AssetId, bigint> =>
  new Map(
    [vault.cash, ...vault.positions]
      .map((h) => [h.asset, BigInt(h.raw)] as const)
      .filter(([, raw]) => raw > 0n),
  );

/** The withdrawals asked for against what the vault holds: each token once, held, and no more than held. */
function held(
  req: WithdrawRequest,
  holdings: Map<AssetId, bigint>,
  name: (asset: AssetId, raw: bigint) => string,
  listed: ReadonlySet<AssetId>,
): LegWithdrawal[] {
  if (!req.withdrawals) {
    if (!holdings.size)
      throw new Refusal(409, 'the vault holds nothing to withdraw', {
        details: { retryable: false },
      });
    return [...holdings].map(([asset, raw]) => ({
      asset,
      amountRaw: null,
      heldRaw: raw.toString(),
    }));
  }
  const seen = new Set<AssetId>();
  return req.withdrawals.map((w) => {
    if (seen.has(w.asset)) throw new Refusal(422, `${w.asset} is named twice`);
    seen.add(w.asset);
    const has = holdings.get(w.asset) ?? 0n;
    if (has === 0n)
      throw new Refusal(409, `the vault holds no ${w.asset} to withdraw`, {
        fix: 'Read the vault again, then make the withdrawal again.',
        details: { retryable: false },
      });
    const amount = w.amountRaw == null ? null : BigInt(w.amountRaw);
    // Part of a token is counted in its units, and the app knows the units of the tokens it lists.
    if (amount !== null && !listed.has(w.asset)) throw new Refusal(422, WHOLE_TOKEN_ONLY);
    if (amount === 0n) throw new Refusal(422, `a withdrawal of no ${w.asset} is nothing to sign`);
    if (amount !== null && amount > has)
      throw new Refusal(
        409,
        `the vault holds ${name(w.asset, has)}, less than the ${name(w.asset, amount)} asked for`,
        {
          fix: 'Read the vault again, then withdraw no more than it holds.',
          details: { retryable: false },
        },
      );
    return {
      asset: w.asset,
      amountRaw: amount === null ? null : amount.toString(),
      heldRaw: has.toString(),
    };
  });
}

/** A raw amount in whole units with its symbol: `12.5 tUSDC`. Never through a float. */
function namer(assets: { id: AssetId; symbol: string; decimals: number }[]) {
  const by = new Map(assets.map((a) => [a.id, a]));
  return (asset: AssetId, raw: bigint): string => {
    const a = by.get(asset);
    if (!a) return `${raw} raw ${asset}`;
    const digits = raw.toString().padStart(a.decimals + 1, '0');
    const whole = digits.slice(0, digits.length - a.decimals);
    const fraction = digits.slice(digits.length - a.decimals).replace(/0+$/, '');
    return `${BigInt(whole).toLocaleString('en-US')}${fraction ? `.${fraction}` : ''} ${a.symbol}`;
  };
}

export type WithdrawStep = {
  chain: ChainId;
  kind: 'withdraw' | 'set_auto_follow' | 'swap';
  description: string;
  /** What a `withdraw` step takes out. Absent on the step that switches auto-follow off. */
  withdrawals?: LegWithdrawal[];
  /** The sales of a `swap` step of a withdrawal in dollars, each into the cash token. */
  trades?: Trade[];
  /** One figure per sale, from a quote taken as the order is planned: its minimum is the order's. */
  expected?: Leg['expected'];
  /** Auto-follow switched off before the step's own call, in its transaction (`Leg.switchAutoFollow`). */
  switchAutoFollow?: false;
};

export type WithdrawPlan = {
  entry: ChainEntry;
  owner: Address;
  vault: Address;
  steps: WithdrawStep[];
  /** What the order says beside its steps: each holding a withdrawal in dollars leaves unsold, and why. */
  warnings: Order['warnings'];
};

/** `NOT_SOLD:<asset>`: the code of the warning for a holding a withdrawal in dollars does not sell. */
export const notSold = (asset: AssetId) => `NOT_SOLD:${asset}`;

/** The share of an amount, rounded down; all of it for the whole. Never through a float. */
export const shareOf = (raw: bigint, shareBps: number) =>
  shareBps >= 10_000 ? raw : (raw * BigInt(shareBps)) / 10_000n;

const AUTO_FOLLOW_OFF =
  'Switch auto-follow off: automatic following stops for this vault, so the keeper does not trade it while you withdraw or afterwards';

/**
 * The steps of a withdrawal with its switch of auto-follow off. Where the vault takes several of the
 * owner's calls in one transaction, the switch rides in the first step that moves anything, before its
 * own calls (gate EVM-MULTICALL-STEPS); elsewhere it is a step of its own, first. It never rides in a
 * withdrawal of one token, which a token that cannot move skips (`SkippedStep`): the switch would be
 * skipped with it.
 */
function offFirst(entry: ChainEntry, autoFollow: boolean, steps: WithdrawStep[]): WithdrawStep[] {
  if (!autoFollow) return steps;
  const [first, ...rest] = steps;
  const skippable = first?.kind === 'withdraw' && first.withdrawals?.length === 1;
  if (first && entry.adapter.capabilities.ownerCallsInOne && !skippable)
    return [
      {
        ...first,
        switchAutoFollow: false,
        description: `Switch auto-follow off, so the keeper does not trade this vault while you withdraw or afterwards, then: ${first.description.charAt(0).toLowerCase()}${first.description.slice(1)}`,
      },
      ...rest,
    ];
  return [{ chain: entry.chain, kind: 'set_auto_follow', description: AUTO_FOLLOW_OFF }, ...steps];
}

/**
 * A withdrawal in dollars, planned and not built: the share of each holding sold for the cash token,
 * as many sales per step as the chain takes, then one withdrawal of the cash.
 *
 * - Pro rata: the same share of every holding and of the cash, each rounded down. A share that rounds
 *   to nothing of a holding sells none of it.
 * - Each sale is quoted now through the chain's own quote, which holds it to what the chain holds an
 *   owner's trade to (on Robinhood Chain the price bound and the asset's largest trade). A sale it
 *   refuses is not made, split or forced: the holding stays, with the chain's sentence.
 * - The cash step states the least it pays (`leastRaw`): the share of the cash held now plus the least
 *   each sale accepts. What it pays is fixed when it is built, from the cash then in the vault.
 */
async function planDollars(
  req: WithdrawRequest,
  ctx: Context,
  own: { entry: ChainEntry; vault: VaultState },
  assets: BasketAsset[],
): Promise<WithdrawPlan> {
  const { entry, vault } = own;
  if (req.withdrawals) throw new Refusal(422, DOLLARS_TAKE_A_SHARE);
  const shareBps = req.shareBps ?? 10_000;
  const slippageBps = req.maxSlippageBps ?? ORDER_POLICY.slippageBps;
  const now = ctx.now ?? new Date().toISOString();
  const cash = assets.find((a) => a.id === vault.cash.asset);
  if (!cash) throw new Error(`${entry.chain} does not list the vault's cash token`);
  const listed = new Map(assets.map((a) => [a.id, a]));
  const name = namer(assets);
  const symbol = (id: AssetId) => listed.get(id)?.symbol ?? id;

  const sales: { trade: Trade; expected: Leg['expected'][number] }[] = [];
  const warnings: Order['warnings'] = [];
  const stays = (asset: AssetId, why: string) =>
    warnings.push({
      code: notSold(asset),
      text: `${symbol(asset)} is not sold: ${why}. It stays in your vault, and you can withdraw the tokens themselves.`,
    });
  for (const held of vault.positions) {
    const has = BigInt(held.raw);
    if (has === 0n) continue;
    const sell = shareOf(has, shareBps);
    if (!listed.has(held.asset)) {
      stays(
        held.asset,
        `this app does not list it on ${entry.config.name}, so it has no pool to sell it in`,
      );
      continue;
    }
    if (sell === 0n) {
      stays(held.asset, 'your share of it is less than its smallest unit');
      continue;
    }
    const trade: Trade = { sell: held.asset, buy: cash.id, amountInRaw: sell.toString() };
    try {
      // Each sale alone, in its own pool. Its minimum is the higher of two floors, as the builder
      // takes it: the order's slippage under the quote, and the chain's own minimum, which on
      // Robinhood Chain carries the floor under the reference price (trade-limits.ts). A minimum
      // under that floor would be refused at every build (`PriceMoved`) after the person had begun.
      const quote = await entry.adapter.quote(trade, vault.owner);
      const out = BigInt(quote.outRaw);
      const ours = lessBps(out, slippageBps);
      const theirs = BigInt(quote.minOutRaw);
      const least = theirs > ours ? theirs : ours;
      // Too little to be held to a minimum: dust, which a sale would give away at any price.
      if (out <= 0n || least <= 0n) {
        stays(held.asset, 'the amount is too small to sell at a stated minimum');
        continue;
      }
      // The pool pays less than the reference price allows the sale to accept.
      if (least > out) {
        stays(
          held.asset,
          'its pool pays less now than the reference price lets a sale accept, so no minimum can be stated',
        );
        continue;
      }
      sales.push({
        trade,
        expected: {
          inRaw: trade.amountInRaw,
          outRaw: out.toString(),
          minOutRaw: least.toString(),
          costBps: quote.costBps,
        },
      });
    } catch (e) {
      if (e instanceof ChainError && NOT_SOLD_NOW.has(e.code)) stays(held.asset, e.message);
      else throw e;
    }
  }

  const cashHeld = BigInt(vault.cash.raw);
  const least =
    shareOf(cashHeld, shareBps) + sales.reduce((n, x) => n + BigInt(x.expected.minOutRaw), 0n);
  const quoted = sales.reduce((n, x) => n + BigInt(x.expected.outRaw), 0n);
  const most =
    shareOf(cashHeld, shareBps) + quoted + (quoted * BigInt(WITHDRAW_DOLLARS_MARGIN_BPS)) / 10_000n;
  if (least === 0n)
    throw new Refusal(409, 'nothing this vault holds can be withdrawn in dollars now', {
      fix: 'Withdraw the tokens themselves: that needs no sale.',
      details: { retryable: false, issues: warnings.map((x) => x.code) },
    });
  const cents = (least * 100n) / 10n ** BigInt(cash.decimals);
  const out: LegWithdrawal = {
    asset: cash.id,
    amountRaw: null,
    heldRaw: cashHeld.toString(),
    leastRaw: least.toString(),
    mostRaw: most.toString(),
    valued: {
      usd: `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`,
      source: entry.source,
      method:
        'the least this withdrawal pays: the share of the cash the vault held plus the least each sale accepts, the dollar token counted at one dollar as the vault counts it',
      fetchedAt: now,
      provenance: entry.provenance,
    },
  };
  const part = shareBps >= 10_000 ? 'all' : `${(shareBps / 100).toLocaleString('en-US')}%`;
  const steps = offFirst(entry, vault.autoFollow, [
    ...batchTrades(
      sales.map((x) => x.trade),
      entry.adapter.capabilities.maxTradesPerTx,
    ).map((group) => ({
      chain: entry.chain,
      kind: 'swap' as const,
      description: group
        .map((t) => `Sell ${name(t.sell, BigInt(t.amountInRaw))} for ${cash.symbol}`)
        .join(', '),
      trades: group,
      expected: group.map(
        (t) => (sales.find((x) => x.trade === t) as (typeof sales)[number]).expected,
      ),
    })),
    {
      chain: entry.chain,
      kind: 'withdraw',
      description: `Withdraw ${part} of the ${cash.symbol} in your vault to your own wallet, ${vault.owner}: at least ${name(cash.id, least)}`,
      withdrawals: [out],
    },
  ]);
  return { entry, owner: vault.owner, vault: vault.address, steps, warnings };
}

/**
 * The steps of a withdrawal, planned and not built. Solana's program takes one token per call, so a
 * step per token; an EVM vault takes them all in one transaction.
 *
 * A vault with auto-follow on has it switched off first, whatever is withdrawn: the keeper trades a
 * vault toward its weights, so between the steps of a withdrawal, or after one that leaves something,
 * it would sell what stayed to buy again what had just gone out (tests/keeper/withdrawal.test.ts). The
 * owner switches it on again when they want it.
 */
export async function planWithdraw(req: WithdrawRequest, ctx: Context): Promise<WithdrawPlan> {
  const { entry, family, vault } = await ownVault(req, ctx);
  const assets = await entry.adapter.listAssets();
  if (req.sellToCash) return planDollars(req, ctx, { entry, vault }, assets);
  if (req.shareBps !== undefined || req.maxSlippageBps !== undefined)
    throw new Refusal(422, SHARE_IS_FOR_DOLLARS);
  const name = namer(assets);
  const taken = held(req, holdingsOf(vault), name, new Set(assets.map((a) => a.id)));
  const value = await valuer(entry, assets, taken, ctx.now ?? new Date().toISOString());
  const all = taken.map((w) => {
    const valued = value(w);
    return valued ? { ...w, valued } : w;
  });
  const what = (w: LegWithdrawal) =>
    w.amountRaw === null
      ? `all the ${name(w.asset, BigInt(w.heldRaw))} it holds`
      : name(w.asset, BigInt(w.amountRaw));
  const step = (withdrawals: LegWithdrawal[]): WithdrawStep => ({
    chain: entry.chain,
    kind: 'withdraw',
    description: `Withdraw ${withdrawals.map(what).join(', ')} from your vault to your own wallet, ${vault.owner}`,
    withdrawals,
  });
  return {
    entry,
    owner: vault.owner,
    vault: vault.address,
    steps: offFirst(
      entry,
      vault.autoFollow,
      family === 'solana' ? all.map((w) => [w]).map(step) : [step(all)],
    ),
    warnings: [],
  };
}

/**
 * One step of a withdrawal, built from the vault as it is now. The vault is held to the order's owner
 * again, and every amount to what the vault holds at this moment: a step that would take more, or a
 * token another withdrawal has already emptied, is refused and nothing is built.
 */
export async function buildWithdraw(
  request: WithdrawRequest,
  leg: Leg,
  entry: ChainEntry,
  owner: Address,
  nonce: number | undefined,
  /** The order's steps: for a withdrawal in dollars, which sales its cash step waits on. */
  legs: readonly Leg[] = [],
): Promise<BuiltTx> {
  const [address] = request.vaults;
  if (!address) throw new Refusal(501, 'a withdrawal names its vault');
  const vault = await entry.adapter.getVault(address);
  if (!vault || vault.owner !== owner) throw new Refusal(404, 'no vault of yours at that address');
  // The first step of a withdrawal from a vault the keeper trades: auto-follow off, and never on.
  if (leg.kind === 'set_auto_follow')
    return entry.adapter.buildSetAutoFollow({
      vault: vault.address,
      on: false,
      ...(nonce === undefined ? {} : { nonce }),
    });
  const again = { fix: 'Make the withdrawal again.', details: { retryable: false } };
  const at = nonce === undefined ? {} : { nonce };
  // The switch off the order planned beside the step, as it planned it (gate EVM-MULTICALL-STEPS).
  const off = leg.switchAutoFollow === false ? { switchAutoFollow: false as const } : {};
  // A sale of a withdrawal in dollars: the vault's own holding into its cash token, at the minimum
  // the order stated and never another. No other trade is a step of a withdrawal.
  if (leg.kind === 'swap') {
    const cash = vault.cash.asset;
    if (
      !request.sellToCash ||
      !leg.trades.length ||
      leg.trades.some((t) => t.buy !== cash || t.sell === cash)
    )
      throw new Refusal(501, 'a withdrawal trades only to sell a holding for cash');
    if (leg.expected.length !== leg.trades.length)
      throw new Refusal(409, 'this step states no minimum for its sales: nothing was built', again);
    return entry.adapter.buildOwnerSwap({
      vault: vault.address,
      trades: leg.trades,
      slippageBps: request.maxSlippageBps ?? ORDER_POLICY.slippageBps,
      minimums: leg.expected.map((e) => e.minOutRaw),
      ...off,
      ...at,
    });
  }
  if (leg.kind !== 'withdraw' || !leg.withdrawals)
    throw new Refusal(501, `a ${leg.kind} step of a withdrawal cannot be built`);
  const holdings = holdingsOf(vault);
  const name = namer(await entry.adapter.listAssets());
  if (request.sellToCash) {
    // The cash of a withdrawal in dollars, once its sales have settled: what the vault holds now less
    // the cash that was to stay (the cash at planning less the share taken), and never more than the
    // step states it pays at most: cash that came in after the order was planned stays. Never less
    // than the order stated.
    const [w, ...more] = leg.withdrawals;
    if (
      !w ||
      more.length ||
      w.asset !== vault.cash.asset ||
      w.leastRaw === undefined ||
      w.mostRaw === undefined
    )
      throw new Refusal(501, 'a withdrawal in dollars takes out the cash token, in one step');
    const planned = BigInt(w.heldRaw);
    const keep = planned - shareOf(planned, request.shareBps ?? 10_000);
    const has = holdings.get(w.asset) ?? 0n;
    const most = BigInt(w.mostRaw);
    const there = has - keep;
    const amount = there > most ? most : there;
    if (amount < BigInt(w.leastRaw) || amount <= 0n) {
      // A read a block behind, just after the last sale settled, shows that sale not made yet: the
      // vault still holds what it sold. A sale reads as not made while the vault holds at least what
      // it held before it, which a share's sale tells from the amount sold: that share of the
      // holding, rounded down, so the holding was at least the amount over the share. The step is
      // built again in a moment when the cash short is no more than the unread sales' minimums: the
      // cash at planning and every read sale's minimum are there. Otherwise cash left the vault, and
      // building again will not bring it back.
      const share = BigInt(request.shareBps ?? 10_000);
      let unread = 0n;
      let read = 0n;
      for (const t of legs
        .filter((l) => l.kind === 'swap')
        .flatMap((l) =>
          l.trades.map((trade, i) => ({ trade, min: BigInt(l.expected[i]?.minOutRaw ?? '0') })),
        )) {
        const sold = BigInt(t.trade.amountInRaw);
        const before = (sold * 10_000n + share - 1n) / share;
        if ((holdings.get(t.trade.sell) ?? 0n) >= before) unread += t.min;
        else read += t.min;
      }
      const lagging = unread > 0n && has >= planned + read;
      throw new Refusal(
        409,
        `the vault now holds ${name(w.asset, has)}, so this step would pay less than the ${name(w.asset, BigInt(w.leastRaw))} the order stated: nothing was built`,
        lagging
          ? {
              fix: 'The sales may not show in the vault yet. Try this step again in a moment.',
              details: { retryable: true },
            }
          : {
              fix: 'Cash left the vault since this order was made. Make the withdrawal again.',
              details: { retryable: false },
            },
      );
    }
    const [tx, ...rest] = await entry.adapter.buildWithdrawInKind({
      vault: vault.address,
      assets: [w.asset],
      amounts: { [w.asset]: amount.toString() },
      ...off,
      ...at,
    });
    if (!tx || rest.length)
      throw new Refusal(409, 'this step cannot be built as one transaction now', again);
    return tx;
  }
  // Everything, on a chain that takes it in one call: the vault's own sweep takes what is there. With
  // the switch off riding in it, a token gone since the order was made does not hold the switch up.
  const everything = !request.withdrawals && entry.config.family === 'evm';
  for (const w of everything && leg.switchAutoFollow === false ? [] : leg.withdrawals) {
    const has = holdings.get(w.asset) ?? 0n;
    if (has === 0n)
      throw new Refusal(409, `the vault holds no ${w.asset} any more: nothing was built`, again);
    if (w.amountRaw !== null && BigInt(w.amountRaw) > has)
      throw new Refusal(
        409,
        `the vault now holds ${name(w.asset, has)}, less than the ${name(w.asset, BigInt(w.amountRaw))} this step takes: nothing was built`,
        again,
      );
  }
  // Everything, on a chain that takes it in one call: the vault's own sweep, which one frozen token
  // cannot hold up. Otherwise the tokens the step names.
  const amounts = leg.withdrawals.flatMap((w) =>
    w.amountRaw === null ? [] : [[w.asset, w.amountRaw] as const],
  );
  let txs: BuiltTx[];
  try {
    txs = await entry.adapter.buildWithdrawInKind({
      vault: vault.address,
      ...(everything ? {} : { assets: leg.withdrawals.map((w) => w.asset) }),
      // Some of a token where the step names an amount; the adapter refuses more than is there.
      ...(amounts.length ? { amounts: Object.fromEntries(amounts) } : {}),
      ...off,
      ...at,
    });
  } catch (e) {
    // A step of one token that cannot move is skipped, and says why. A step of several is refused as a
    // whole, and any other refusal is the step's own, to be built again. A step that also switches
    // auto-follow off is never skipped: the switch would go with it.
    if (
      e instanceof ChainError &&
      leg.withdrawals.length === 1 &&
      leg.switchAutoFollow === undefined &&
      A_SKIP.has(e.code)
    )
      throw new SkippedStep(e.code, e.message);
    throw e;
  }
  const [tx, ...rest] = txs;
  if (!tx || rest.length)
    throw new Refusal(409, 'this step cannot be built as one transaction now', again);
  return tx;
}
