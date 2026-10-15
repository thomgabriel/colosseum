// Rodrigo, Oct 8 (RELAXED-1): the new-goal conversations kept in this browser, one per id, with
// an index of them. The conversation that existed before the index ('main') keeps its original key, so
// nothing saved earlier is lost. Each conversation's transcript and last preview live under its own
// key; the index only holds ids, a title (the person's first words) and when it was last written.
// What a conversation is called on screen is read from its own turns (`conversationName`, Thom,
// Oct 9), so one saved before that is named the same way; the index's title is no longer read.

import { readLocal } from '../vault-conversation/storage';
import { conversationTitle } from './title';

export type SavedConversation = {
  id: string;
  title: string;
  updatedAt: string;
  /** The name the person gave it in the list, which goes before the name read from its turns. */
  name?: string;
  /** The plan a deposit from it was approved for: the vault opened from that plan is where it went. */
  planId?: string;
};
export type ConversationIndex = { current: string; items: SavedConversation[] };

const MAIN = 'main';
const MAX_ITEMS = 50;
/** The longest name a person can give a conversation, in characters. */
export const NAME_LENGTH = 80;

export const conversationStoreKey = (base: string, id: string) =>
  id === MAIN ? base : `${base}:c:${id}`;
const indexKey = (base: string) => `${base}:index`;

function parse(raw: string | null): ConversationIndex | null {
  try {
    const value = raw ? (JSON.parse(raw) as unknown) : null;
    if (!value || typeof value !== 'object') return null;
    const { current, items } = value as Record<string, unknown>;
    if (typeof current !== 'string' || !Array.isArray(items)) return null;
    const clean = items
      .filter(
        (item): item is SavedConversation =>
          !!item &&
          typeof item === 'object' &&
          typeof (item as SavedConversation).id === 'string' &&
          typeof (item as SavedConversation).title === 'string' &&
          typeof (item as SavedConversation).updatedAt === 'string',
      )
      // the two the list adds are kept only as text; anything else is not carried
      .map(({ id, title, updatedAt, name, planId }) => ({
        id,
        title,
        updatedAt,
        ...(typeof name === 'string' && name.trim() ? { name: name.slice(0, NAME_LENGTH) } : {}),
        ...(typeof planId === 'string' && planId ? { planId } : {}),
      }));
    return { current, items: clean.slice(0, MAX_ITEMS) };
  } catch {
    return null;
  }
}

export function readIndex(base: string): ConversationIndex {
  try {
    const saved = parse(localStorage.getItem(indexKey(base)));
    if (saved) return saved;
    // Before the index: the one conversation under the base key, if it has words.
    return {
      current: MAIN,
      items: localStorage.getItem(base) ? [{ id: MAIN, title: '', updatedAt: '' }] : [],
    };
  } catch {
    return { current: MAIN, items: [] };
  }
}

export function writeIndex(base: string, index: ConversationIndex) {
  try {
    localStorage.setItem(indexKey(base), JSON.stringify(index));
  } catch {
    // storage full or blocked: the conversation on screen is unaffected
  }
}

/**
 * The name of a conversation kept in this browser: its person's first message, shortened, read from
 * its own turns; `neutral` while it has none.
 */
export const conversationName = (base: string, id: string, neutral: string) =>
  conversationTitle(
    readLocal(conversationStoreKey(base, id)).transcript.find((turn) => turn.who === 'person')
      ?.text,
    neutral,
  );

/**
 * Records that a conversation was written: its first words and time, newest first. Written with no
 * words (started over), it is taken off the list: a conversation with nothing in it is not a saved one.
 */
export function touch(base: string, index: ConversationIndex, id: string, first: string) {
  if (!first.trim()) {
    const next = { ...index, items: index.items.filter((item) => item.id !== id) };
    if (next.items.length !== index.items.length) writeIndex(base, next);
    return next;
  }
  const rest = index.items.filter((item) => item.id !== id);
  const old = index.items.find((item) => item.id === id);
  const next: ConversationIndex = {
    ...index,
    items: [
      {
        ...old,
        id,
        title: old?.title || conversationTitle(first, ''),
        updatedAt: new Date().toISOString(),
      },
      ...rest,
    ].slice(0, MAX_ITEMS),
  };
  writeIndex(base, next);
  return next;
}

/** One saved conversation changed by `change`; one that is not in the list is left as it is. */
function edit(
  base: string,
  index: ConversationIndex,
  id: string,
  change: (item: SavedConversation) => SavedConversation,
): ConversationIndex {
  if (!index.items.some((item) => item.id === id)) return index;
  const next = {
    ...index,
    items: index.items.map((item) => (item.id === id ? change(item) : item)),
  };
  writeIndex(base, next);
  return next;
}

/**
 * The name a person gives a conversation in the list, cut to `NAME_LENGTH`; an empty one gives it back
 * the name read from its turns. Its turns and its time are unchanged.
 */
export function renameConversation(
  base: string,
  index: ConversationIndex,
  id: string,
  name: string,
): ConversationIndex {
  const kept = Array.from(name.replace(/\s+/gu, ' ').trim()).slice(0, NAME_LENGTH).join('');
  // an empty name is left out of the entry when it is written (JSON has no undefined)
  return edit(base, index, id, (item) => ({ ...item, name: kept || undefined }));
}

/** Records the plan a deposit from this conversation was approved for: the one vault it can lead to. */
export function linkPlan(base: string, index: ConversationIndex, id: string, planId: string) {
  const old = index.items.find((item) => item.id === id);
  if (!old || old.planId === planId) return index;
  return edit(base, index, id, (item) => ({ ...item, planId }));
}

/**
 * A conversation taken off this browser: its entry, its turns and the preview kept with them. The one
 * on screen gives way to a new, empty one. One whose deposit's ids are kept (`depositPlan`) is not
 * deleted at all: a deposit not finished, set aside or not, is reached again from its conversation
 * (DEPOSIT-IN-PLACE), so the index comes back as it was.
 */
export function deleteConversation(
  base: string,
  index: ConversationIndex,
  id: string,
): ConversationIndex {
  if (depositPlan(base, id) !== null) return index;
  const key = conversationStoreKey(base, id);
  try {
    for (const k of [key, `${key}:preview`]) localStorage.removeItem(k);
  } catch {
    // storage blocked: the entry still leaves the list
  }
  const next: ConversationIndex = {
    current: index.current === id ? newConversationId() : index.current,
    items: index.items.filter((item) => item.id !== id),
  };
  writeIndex(base, next);
  return next;
}

/** The plan a deposit kept beside a conversation names, while its ids are kept (GoalConversation). */
export function depositPlan(base: string, id: string): string | null {
  try {
    const raw = localStorage.getItem(`${conversationStoreKey(base, id)}:deposit`);
    const planId = raw ? (JSON.parse(raw) as { planId?: unknown }).planId : null;
    return typeof planId === 'string' && planId ? planId : null;
  } catch {
    return null;
  }
}

export const newConversationId = () => crypto.randomUUID().slice(0, 8);
