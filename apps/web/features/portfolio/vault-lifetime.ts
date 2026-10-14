import {
  type ChainId,
  CLOSE_DUST_USD,
  type ClosedVault,
  ClosedVaultsResponse,
  OrderError,
  VaultLifetimeResponse,
} from '@colosseum/schemas';
import type { ApiFetch } from '../account/person';

// A person closes an empty vault of theirs, or opens it again (gate VAULT-CLOSE-REUSE): bookkeeping on
// our server, nothing signed and nothing moved on chain. POST /v1/vaults/{chain}/{address}/close and
// `/reopen`, and the list of the closed ones (GET /v1/portfolio/closed).

/** Whether a vault is empty enough to close: worth under a cent, and no token it holds unpriced. */
export function closable(vault: {
  valueUsd: string;
  cash: { raw: string };
  positions: readonly { raw: string; valueUsd: string | null }[];
}): boolean {
  const unpriced = vault.positions.some((p) => p.valueUsd === null && !/^0+$/.test(p.raw));
  return !unpriced && Number(vault.valueUsd) < CLOSE_DUST_USD;
}

export type LifetimeOutcome =
  /** Done: when it was closed (null once it is open again). */
  | { kind: 'done'; closedAt: string | null }
  /** 409: it still holds something, to withdraw first. */
  | { kind: 'not-empty' }
  /** 409: an order on it is not finished yet. */
  | { kind: 'order-open' }
  /** 401 or 403. */
  | { kind: 'signed-out' }
  /** 404: no vault with that address that is this person's. */
  | { kind: 'not-yours' }
  /** 429. */
  | { kind: 'busy' }
  | { kind: 'unreachable' };

async function lifetime(
  apiFetch: ApiFetch,
  vault: { chain: ChainId; address: string },
  what: 'close' | 'reopen',
): Promise<LifetimeOutcome> {
  let res: Response;
  try {
    res = await apiFetch(`/v1/vaults/${vault.chain}/${encodeURIComponent(vault.address)}/${what}`, {
      method: 'POST',
    });
  } catch {
    return { kind: 'unreachable' };
  }
  if (res.status === 409) {
    const said = OrderError.safeParse(await res.json().catch(() => null));
    return said.success && said.data.code === 'ORDER_UNFINISHED'
      ? { kind: 'order-open' }
      : { kind: 'not-empty' };
  }
  if (res.status === 401 || res.status === 403) return { kind: 'signed-out' };
  if (res.status === 404) return { kind: 'not-yours' };
  if (res.status === 429) return { kind: 'busy' };
  if (!res.ok) return { kind: 'unreachable' };
  const said = VaultLifetimeResponse.safeParse(await res.json().catch(() => null));
  return said.success ? { kind: 'done', closedAt: said.data.closedAt } : { kind: 'unreachable' };
}

/** Closes an empty vault of the person's. */
export const closeVault = (apiFetch: ApiFetch, vault: { chain: ChainId; address: string }) =>
  lifetime(apiFetch, vault, 'close');

/** Opens a closed vault of the person's again. */
export const reopenVault = (apiFetch: ApiFetch, vault: { chain: ChainId; address: string }) =>
  lifetime(apiFetch, vault, 'reopen');

export type ClosedRead =
  | { kind: 'read'; vaults: ClosedVault[] }
  | { kind: 'signed-out' }
  | { kind: 'unreachable' };

/** The person's closed vaults, newest close first. */
export async function readClosedVaults(apiFetch: ApiFetch): Promise<ClosedRead> {
  let res: Response;
  try {
    res = await apiFetch('/v1/portfolio/closed');
  } catch {
    return { kind: 'unreachable' };
  }
  if (res.status === 401 || res.status === 403) return { kind: 'signed-out' };
  if (!res.ok) return { kind: 'unreachable' };
  const said = ClosedVaultsResponse.safeParse(await res.json().catch(() => null));
  return said.success ? { kind: 'read', vaults: said.data.vaults } : { kind: 'unreachable' };
}
