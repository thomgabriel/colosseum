import {
  type PlatformFigure,
  type PlatformNetwork,
  PlatformStatsResponse,
  type Provenance,
} from '@colosseum/schemas';
import type { PinSource } from '../../components/ui/provenance';
import { API } from '../../lib/api';

// The platform's numbers under the hero, from the API's `/v1/stats` when it answers: the vaults the
// server knows, the wallets that own them, and what they held at the snapshot worker's last pass. Each
// is pinned with the source, instant and method the API gives it, and under the label of the chains
// it was counted on: a mainnet's block when one runs, a test network's otherwise. The value is shown
// only when the API has one; with no fresh pass of the worker it has none, and the strip leaves it
// out rather than say 0. When the API does not answer (no API, no database: a local run, a preview),
// the strip shows sample figures instead, pinned `mock`, and the strip says so in its quiet line
// (MOCK-QUIET). Sample figures are never shown as live, and live ones carry no change figure: the API
// keeps no history to compare with.

export type StatKey = 'vaults' | 'wallets' | 'value' | 'running' | 'depth' | 'onTrack';

export type PlatformStat = {
  key: StatKey;
  /** The figure as shown. */
  value: string;
  obs: PinSource;
  /** A change, sample strip only: the sign and the words, and which way it goes. */
  change?: { text: string; up: boolean };
};

/** `provenance` is the label of every figure in the strip: `live` only for a mainnet's counts. */
export type PlatformStats = { provenance: Provenance; items: PlatformStat[] };

const SAMPLE: PinSource = {
  source: 'sample',
  fetchedAt: '2026-10-08T00:00:00Z',
  method: 'illustrative platform figures, identity-reassessment.html',
  provenance: 'mock',
};

/** The sample strip: the figures of the identity sheet, marked as sample wherever they show. */
export const SAMPLE_STATS: PlatformStats = {
  provenance: 'mock',
  items: [
    { key: 'running', value: '1,284', obs: SAMPLE, change: { text: '+12%', up: true } },
    { key: 'depth', value: '$41.2M', obs: SAMPLE, change: { text: '+3.1%', up: true } },
    { key: 'onTrack', value: '91%', obs: SAMPLE, change: { text: '−2 pts', up: false } },
  ],
};

const count = new Intl.NumberFormat('en-US');
const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1,
});

/** Which block the strip shows: a mainnet's, else a test network's, else the mock's. */
const PREFERRED: Provenance[] = ['live', 'sandbox', 'mock'];

/** The strip from a reply of `/v1/stats`, or null when the reply is not one or has no block to show. */
export function fromReply(reply: unknown): PlatformStats | null {
  const parsed = PlatformStatsResponse.safeParse(reply);
  if (!parsed.success) return null;
  const block = PREFERRED.map((p) =>
    parsed.data.networks.find((n: PlatformNetwork) => n.provenance === p),
  ).find((n) => n !== undefined);
  if (!block) return null;
  const obs = (f: PlatformFigure): PinSource => ({
    source: f.source,
    fetchedAt: f.fetchedAt,
    method: f.method,
    provenance: block.provenance,
  });
  const items: PlatformStat[] = [
    { key: 'vaults', value: count.format(block.vaults.value), obs: obs(block.vaults) },
    { key: 'wallets', value: count.format(block.wallets.value), obs: obs(block.wallets) },
  ];
  if (block.valueUsd)
    items.push({ key: 'value', value: usd.format(block.valueUsd.value), obs: obs(block.valueUsd) });
  return { provenance: block.provenance, items };
}

/** The numbers for the strip: the API's if it answers within a moment, sample otherwise. */
export async function platformStats(timeoutMs = 1500): Promise<PlatformStats> {
  try {
    const res = await fetch(`${API}/v1/stats`, {
      signal: AbortSignal.timeout(timeoutMs),
      next: { revalidate: 60 },
    });
    if (!res.ok) return SAMPLE_STATS;
    return fromReply(await res.json()) ?? SAMPLE_STATS;
  } catch {
    return SAMPLE_STATS;
  }
}
