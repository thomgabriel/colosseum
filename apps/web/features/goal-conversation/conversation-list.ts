import type { ChainId } from '@colosseum/schemas';
import type { PinSource } from '../../components/ui/provenance';

// What the conversations panel on /invest lists (Thom, Oct 14): the person's drafts kept in this
// browser and their vaults, newest first, in three groups by the day they were last written. A draft
// a deposit went from is listed as the vault it opened, once. Nothing here reads storage or the API:
// the panel hands in what it read, and this decides the rows, their order and what a search keeps.

export type DraftRow = {
  kind: 'draft';
  key: string;
  chain: ChainId;
  /** Where its chain's conversations are kept in this browser (`goalConversationKey`). */
  base: string;
  id: string;
  title: string;
  /** When it was last written, in milliseconds; null where nothing says. */
  at: number | null;
  current: boolean;
  /** The plan an approved deposit from it was for, where one was. */
  planId: string | null;
  /** Whether it is in this browser's list: a new one with no words yet is not, and has nothing to rename. */
  kept: boolean;
  /**
   * Whether the ids of a deposit from it are kept beside it (DEPOSIT-IN-PLACE): one not finished, set
   * aside or not, is reached again from it, so it is never deleted and never stood for by its vault.
   */
  depositing: boolean;
};

export type VaultRow = {
  kind: 'vault';
  key: string;
  chain: ChainId;
  address: string;
  title: string;
  at: number | null;
  current: false;
  /** The vault's newest value with its source, as the overview pins it; null before its first read. */
  value: { usd: string; obs: PinSource } | null;
  /** The plan the vault was opened from, where the person's own plan did. */
  planId: string | null;
};

export type ConversationRow = DraftRow | VaultRow;

/** From how many rows on the search box is drawn. */
export const SEARCH_FROM = 9;

/**
 * The rows, newest first: every draft but one a deposit went from to a vault that is listed (that
 * vault stands for it, at the later of the two times) and whose deposit's ids are no longer kept; the
 * one on screen always, at the top of its day.
 */
export function mergeRows(
  drafts: readonly DraftRow[],
  vaults: readonly VaultRow[],
): ConversationRow[] {
  const vaultOf = new Map(
    vaults.flatMap((vault) => (vault.planId ? [[vault.planId, vault] as const] : [])),
  );
  const latest = new Map<string, number>();
  const kept: ConversationRow[] = [];
  const seen = new Set<string>();
  for (const draft of drafts) {
    // a draft is listed once, whichever of the lists handed in named it first
    if (seen.has(draft.key)) continue;
    seen.add(draft.key);
    const vault = draft.planId ? vaultOf.get(draft.planId) : undefined;
    if (vault && !draft.current && !draft.depositing) {
      if (draft.at !== null) latest.set(vault.key, Math.max(latest.get(vault.key) ?? 0, draft.at));
      continue;
    }
    kept.push(draft);
  }
  for (const vault of vaults) {
    const at = latest.get(vault.key);
    kept.push(at !== undefined ? { ...vault, at: Math.max(vault.at ?? 0, at) } : vault);
  }
  return kept.sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    return (b.at ?? Number.NEGATIVE_INFINITY) - (a.at ?? Number.NEGATIVE_INFINITY);
  });
}

export type DayGroup = 'today' | 'yesterday' | 'earlier';

/** The local calendar day of a time, as a number that orders days. */
const dayOf = (at: number) => {
  const d = new Date(at);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000;
};

/**
 * The rows in three groups by the day of this browser's clock they were last written: today,
 * yesterday, earlier. The one on screen is today's; a row with no time is earlier. Empty groups stay
 * empty, and each keeps the order it was given.
 */
export function groupByDay(
  rows: readonly ConversationRow[],
  now: number,
): Record<DayGroup, ConversationRow[]> {
  const groups: Record<DayGroup, ConversationRow[]> = { today: [], yesterday: [], earlier: [] };
  const today = dayOf(now);
  for (const row of rows) {
    const day = row.current ? today : row.at === null ? null : dayOf(row.at);
    const group: DayGroup =
      day !== null && day >= today ? 'today' : day === today - 1 ? 'yesterday' : 'earlier';
    groups[group].push(row);
  }
  return groups;
}

/** A title as a search reads it: one case, no accents, one space. */
const plain = (text: string) =>
  text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase().replace(/\s+/gu, ' ').trim();

/** The rows whose title holds every word searched for, in any order; all of them for an empty search. */
export function matching(rows: readonly ConversationRow[], query: string): ConversationRow[] {
  const words = plain(query).split(' ').filter(Boolean);
  if (words.length === 0) return [...rows];
  return rows.filter((row) => {
    const title = plain(row.title);
    return words.every((word) => title.includes(word));
  });
}

/**
 * How long ago a time was, in the person's language: "now", "5 minutes ago", "yesterday", "3 days
 * ago". A time ahead of the clock (another device's) is "now".
 */
export function ago(at: number, now: number, locale: string): string {
  const say = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'long' });
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return say.format(0, 'second');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return say.format(-minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return say.format(-hours, 'hour');
  const days = dayOf(now) - dayOf(at);
  if (days < 30) return say.format(-Math.max(1, days), 'day');
  const months = Math.floor(days / 30);
  if (months < 12) return say.format(-months, 'month');
  return say.format(-Math.floor(days / 365), 'year');
}
