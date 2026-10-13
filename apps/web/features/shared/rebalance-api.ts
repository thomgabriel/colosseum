import {
  type ChainId,
  chainFamily,
  RebalanceQuoteResponse,
  RebalanceVaultResponse,
} from '@colosseum/schemas';
import type { ApiFetch } from '../account/person';

// The two calls behind "Rebalance" (HANDOFF-VAULT, MVP item 6): what a rebalance of a vault the
// person owns would trade now (`POST /v1/vaults/{chain}/{address}/rebalance/quote`, nothing stored),
// and the order that makes those trades (`POST /v1/vaults/{chain}/{address}/rebalance`). The order
// sets no target: it only swaps, toward the targets the vault has. Nothing here decides what is
// signed: the order is checked against the vault's targets before it is offered (order-check.ts,
// `rebalanceShapeOk`), and the guard holds every step's bytes.

export type RebalanceFailure =
  /**
   * Refused, with the codes that say why: `details.issues` (`AUTO_FOLLOW_ON`, `NO_TARGETS`,
   * `NO_PRICE:<asset>`, `PRICE_BOUND:<asset>`, `TRADE_TOO_LARGE:<asset>`, `OVER_ORDER_LIMIT`), and a
   * chain's own code (`details.chainCode`) among them.
   */
  | { kind: 'refused'; issues: string[] }
  | { kind: 'signed-out' }
  /** 404: not a vault of this person's. */
  | { kind: 'not-yours' }
  /** 503: the chain only reads for now. */
  | { kind: 'read-only' }
  | { kind: 'busy' }
  /** The answer did not read, or was not for this vault. */
  | { kind: 'unreadable' }
  | { kind: 'unreachable' };

export type RebalanceCall<T> = { kind: 'ok'; value: T } | RebalanceFailure;

async function post<T>(
  api: ApiFetch,
  path: string,
  body: object,
  parse: (value: unknown) => T | null,
): Promise<RebalanceCall<T>> {
  let res: Response;
  try {
    res = await api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { kind: 'unreachable' };
  }
  let answer: Record<string, unknown> = {};
  try {
    const read: unknown = await res.json();
    if (read && typeof read === 'object' && !Array.isArray(read))
      answer = read as Record<string, unknown>;
  } catch {
    if (res.ok) return { kind: 'unreadable' };
  }
  if (!res.ok) {
    if (res.status === 429 || answer.code === 'RATE_LIMITED') return { kind: 'busy' };
    if (res.status === 401 || res.status === 403) return { kind: 'signed-out' };
    if (res.status === 404) return { kind: 'not-yours' };
    if (res.status === 503) return { kind: 'read-only' };
    if (res.status >= 500) return { kind: 'unreachable' };
    const details = (answer.details ?? {}) as { issues?: unknown; chainCode?: unknown };
    const issues = Array.isArray(details.issues)
      ? details.issues.filter((issue): issue is string => typeof issue === 'string')
      : [];
    if (typeof details.chainCode === 'string') issues.push(details.chainCode);
    return { kind: 'refused', issues };
  }
  const value = parse(answer);
  return value === null ? { kind: 'unreadable' } : { kind: 'ok', value };
}

const pathOf = (chain: ChainId, address: string) =>
  `/v1/vaults/${encodeURIComponent(chain)}/${encodeURIComponent(address)}/rebalance`;

/** The order that brings the vault to the targets it has, or word that it is there already. */
export function rebalanceVault(
  api: ApiFetch,
  chain: ChainId,
  address: string,
  owner: string,
): Promise<RebalanceCall<RebalanceVaultResponse>> {
  const family = chainFamily(chain);
  return post(api, pathOf(chain, address), {}, (value) => {
    const read = RebalanceVaultResponse.safeParse(value);
    if (!read.success) return null;
    if (read.data.status === 'ordered') {
      const { order } = read.data;
      // The order is this person's, on this chain, and only swaps.
      if (
        order.type !== 'rebalance' ||
        order.owner[family] !== owner ||
        order.legs.length === 0 ||
        order.legs.some((leg) => leg.chain !== chain || leg.kind !== 'swap')
      )
        return null;
    }
    return read.data;
  });
}

/**
 * What a rebalance would trade now. With `follow`, against the weights of that shared portfolio's
 * version, before the vault follows it; without, against the vault's own targets.
 */
export function quoteRebalance(
  api: ApiFetch,
  chain: ChainId,
  address: string,
  follow?: { slug: string; version: number },
): Promise<RebalanceCall<RebalanceQuoteResponse>> {
  return post(
    api,
    `${pathOf(chain, address)}/quote`,
    follow ? { family: follow.slug, version: follow.version } : {},
    (value) => {
      const read = RebalanceQuoteResponse.safeParse(value);
      if (!read.success || read.data.chain !== chain) return null;
      // A quote for a follow is against the version asked about, and no other.
      if ((read.data.version ?? null) !== (follow?.version ?? null)) return null;
      return read.data;
    },
  );
}
