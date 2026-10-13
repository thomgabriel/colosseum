import type { ChainId } from '@colosseum/schemas';
import type { Dictionary } from '../../i18n/en';
import { displayName } from '../order/plain';

// Why a rebalance could not be ordered or quoted, in this app's own words: from the codes our server
// answers (`details.issues`, and a chain's own code), never from its English sentence, so a person
// reading Portuguese reads Portuguese. `again`: whether the same press can work later with nothing
// changed by the person; a trade larger than the network takes, or an order over the limit, cannot.

export function rebalanceWhy(
  issues: readonly string[],
  t: Dictionary,
  chain: ChainId,
): { why: string; again: boolean } {
  const w = t.shared.vault.page.rebalancing.why;
  const name = (asset: string) => displayName(asset, t.plan);
  const of = (code: string) =>
    issues.filter((i) => i.startsWith(`${code}:`)).map((i) => i.slice(code.length + 1));
  const first = (code: string) => of(code)[0];
  const large = first('TRADE_TOO_LARGE');
  if (large) return { why: w.tooLarge(name(large), t.chain.names[chain]), again: false };
  if (issues.includes('OVER_ORDER_LIMIT')) return { why: w.overLimit, again: false };
  const waits = first('TRADE_WAITS_FOR_OPEN');
  if (waits) return { why: w.waitsForOpen(name(waits)), again: true };
  if (issues.includes('AUTO_FOLLOW_ON')) return { why: w.keeper, again: false };
  if (issues.includes('NO_TARGETS')) return { why: w.noTargets, again: false };
  const unpriced = of('NO_PRICE');
  if (unpriced.length) return { why: w.noPrice(unpriced.map(name).join(', ')), again: true };
  const bound = first('PRICE_BOUND');
  if (bound) return { why: w.priceBound(name(bound)), again: true };
  if (issues.includes('TARGETS_CHANGED')) return { why: w.targetsChanged, again: true };
  if (issues.some((i) => i.startsWith('PAST_TARGET'))) return { why: w.pastTarget, again: true };
  if (issues.includes('PriceStale') || issues.includes('MarketClosed'))
    return { why: w.priceStale, again: true };
  if (issues.includes('PriceDeviation')) return { why: w.priceDeviation, again: true };
  return { why: w.other, again: true };
}
