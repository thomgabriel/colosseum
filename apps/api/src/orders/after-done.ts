import { vaults } from '@colosseum/db';
import { type Address, type ChainId, chainFamily, type Provenance } from '@colosseum/schemas';
import { and, eq } from 'drizzle-orm';
import { loggable } from '../plugins/loggable';
import { type OrderDeps, planVault } from './legs';
import type { StoredOrder } from './store';

// Once an order is done, the vault it acted on is read once and kept as a snapshot (gate SNAPSHOT-IN-API,
// amended Oct 30, Thom), so its value and what it made show at once on its page, the portfolio and the
// leaderboard, not at the snapshot worker's next pass, up to an hour later. The read is the worker's own
// (snapshot-in-api.ts, `readVault`): the chains it reads, under their labels, and nothing else. It never
// holds up or fails the order: it starts after the answer, and what goes wrong is logged.

/** The worker's reader: which chains it reads under which labels, and one vault read and kept as its row. */
export type VaultReader = {
  reads(chain: ChainId, provenance: Provenance): boolean;
  /** Null where nothing reads that chain under that label. */
  read(
    chain: ChainId,
    provenance: Provenance,
    address: string,
  ): Promise<{ outcome: 'read' | 'none' } | null>;
};

type Log = {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
};

/** How long after the order is done the vault is read: a node behind a load balancer can lag a slot. */
export const READ_AFTER_MS = 2_000;
/** How many orders are remembered as read, so one order is read once however many requests see it done. */
const REMEMBERED = 1_000;

/**
 * The vaults a done order acted on, by address, on its one chain (gate ONE-CHAIN). A buy that adds to a
 * vault, a rebalance, a withdrawal and a follow name theirs; a buy that opened one names its number, and
 * the address is the API's cache of it, else the chain's answer for the owner's vaults. A publish acts on
 * no vault of the person's and names none.
 */
export async function vaultsOfDone(
  deps: Pick<OrderDeps, 'db' | 'chains'>,
  stored: StoredOrder,
): Promise<{ chain: ChainId; addresses: string[] } | null> {
  const { order, request } = stored;
  const chain = order.legs[0]?.chain;
  if (!chain) return null;
  if (request.type === 'rebalance' || request.type === 'withdraw')
    return { chain, addresses: [...new Set(request.vaults)] };
  if (request.type === 'follow') return { chain, addresses: [request.vault] };
  if (request.type !== 'buy') return null;
  if (request.vault) return { chain, addresses: [request.vault.address] };
  const owner = order.owner[chainFamily(chain)];
  if (!owner || !order.basketId) return null;
  const entry = deps.chains.get(chain);
  const [cached] = await deps.db
    .select({ address: vaults.address })
    .from(vaults)
    .where(
      and(
        eq(vaults.chainId, chain),
        // One chain id can be a test network's and a mainnet's: the row of this server's label only.
        eq(vaults.provenance, entry.provenance),
        eq(vaults.owner, owner),
        eq(vaults.onchainBasketId, order.basketId),
      ),
    )
    .limit(1);
  if (cached) return { chain, addresses: [cached.address] };
  const state = await planVault(entry, owner as Address, order.basketId);
  return state ? { chain, addresses: [state.address] } : null;
}

/**
 * What `OrderDeps.onOrderDone` is given on a server that reads vaults: each done order's vaults read
 * once, `afterMs` after it is done, one order once. A chain the worker does not read is not asked
 * anything, the address of a new vault included. One vault that cannot be read does not stop the next.
 * Returns at once; never throws.
 */
export function readOnDone(
  deps: Pick<OrderDeps, 'db' | 'chains'>,
  reader: () => VaultReader | null,
  log: Log,
  afterMs: number = READ_AFTER_MS,
): (stored: StoredOrder) => void {
  const seen = new Set<string>();
  return (stored) => {
    const id = stored.order.id;
    if (seen.has(id)) return;
    if (seen.size >= REMEMBERED) seen.clear();
    seen.add(id);
    const timer = setTimeout(() => void readNow(stored), afterMs);
    timer.unref?.();
  };

  async function readNow(stored: StoredOrder) {
    const orderId = stored.order.id;
    const notRead = (err: unknown) =>
      log.warn(
        { err: loggable(err), orderId },
        'the vault of a done order was not read: it is read at the next pass',
      );
    try {
      const worker = reader();
      const chain = stored.order.legs[0]?.chain;
      if (!worker || !chain) return;
      const { provenance } = deps.chains.get(chain);
      if (!worker.reads(chain, provenance)) return;
      const named = await vaultsOfDone(deps, stored);
      if (!named) return;
      for (const address of named.addresses) {
        try {
          const outcome = await worker.read(chain, provenance, address);
          if (outcome)
            log.info(
              { orderId, chain, outcome: outcome.outcome },
              'the vault of a done order was read',
            );
        } catch (err) {
          notRead(err);
        }
      }
    } catch (err) {
      notRead(err);
    }
  }
}
