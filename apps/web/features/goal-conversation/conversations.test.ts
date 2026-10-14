// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  conversationStoreKey,
  deleteConversation,
  depositPlan,
  linkPlan,
  NAME_LENGTH,
  readIndex,
  renameConversation,
  touch,
  writeIndex,
} from './conversations';

// The drafts kept in this browser, as the conversations panel changes them (Thom, Oct 14): a name the
// person gives one, the plan a deposit from it was for, and one taken off this browser.

const base = 'tf-goal-conversation:2:person:solana:mock';
const saved = (id: string, more = {}) => ({
  id,
  title: '',
  updatedAt: '2026-10-14T10:00:00.000Z',
  ...more,
});

beforeEach(() => localStorage.clear());

describe('the index of drafts', () => {
  it('keeps a name and a plan as text, and nothing else it does not know', () => {
    localStorage.setItem(
      `${base}:index`,
      JSON.stringify({
        current: 'a',
        items: [
          { ...saved('a'), name: 'Gold for later', planId: 'plan-1', extra: '<b>no</b>' },
          { ...saved('b'), name: 7, planId: { not: 'text' } },
        ],
      }),
    );
    expect(readIndex(base).items).toEqual([
      { ...saved('a'), name: 'Gold for later', planId: 'plan-1' },
      saved('b'),
    ]);
  });

  it('keeps the name and the plan when the draft is written again', () => {
    const index = { current: 'a', items: [saved('a', { name: 'Mine', planId: 'plan-1' })] };
    const next = touch(base, index, 'a', 'Consider gold');
    expect(next.items[0]).toMatchObject({ id: 'a', name: 'Mine', planId: 'plan-1' });
    expect(readIndex(base).items[0]).toMatchObject({ name: 'Mine', planId: 'plan-1' });
  });
});

describe('renameConversation', () => {
  it('keeps the name given, on one line and cut to its length, and an empty one gives the old name back', () => {
    const index = { current: 'a', items: [saved('a'), saved('b')] };
    let next = renameConversation(base, index, 'a', '  Gold\n  for   later ');
    expect(next.items[0]?.name).toBe('Gold for later');
    expect(readIndex(base).items[0]?.name).toBe('Gold for later');
    next = renameConversation(base, next, 'a', 'x'.repeat(NAME_LENGTH + 20));
    expect(next.items[0]?.name).toHaveLength(NAME_LENGTH);
    next = renameConversation(base, next, 'a', '   ');
    expect(readIndex(base).items[0]).toEqual(saved('a'));
    // its time is unchanged: a name is not a message
    expect(next.items[0]?.updatedAt).toBe('2026-10-14T10:00:00.000Z');
  });

  it('changes nothing for a draft that is not in the list', () => {
    const index = { current: 'a', items: [saved('a')] };
    expect(renameConversation(base, index, 'zz', 'Name')).toBe(index);
  });
});

describe('linkPlan and depositPlan', () => {
  it('records the plan a deposit was for, once', () => {
    const index = { current: 'a', items: [saved('a')] };
    const next = linkPlan(base, index, 'a', 'plan-1');
    expect(readIndex(base).items[0]?.planId).toBe('plan-1');
    expect(linkPlan(base, next, 'a', 'plan-1')).toBe(next);
  });

  it('reads the plan a kept deposit names, and nothing from what is not one', () => {
    const key = `${conversationStoreKey(base, 'a')}:deposit`;
    localStorage.setItem(key, JSON.stringify({ planId: 'plan-9', orderId: 'o' }));
    expect(depositPlan(base, 'a')).toBe('plan-9');
    localStorage.setItem(key, 'not json');
    expect(depositPlan(base, 'a')).toBeNull();
    expect(depositPlan(base, 'none')).toBeNull();
  });
});

describe('deleteConversation', () => {
  it('takes a draft off this browser: its entry, its turns and its preview', () => {
    const index = { current: 'b', items: [saved('a'), saved('b')] };
    writeIndex(base, index);
    const key = conversationStoreKey(base, 'a');
    for (const k of [key, `${key}:preview`]) localStorage.setItem(k, '{}');
    const other = conversationStoreKey(base, 'b');
    localStorage.setItem(other, '{}');
    const next = deleteConversation(base, index, 'a');
    expect(next).toEqual({ current: 'b', items: [saved('b')] });
    expect(readIndex(base)).toEqual(next);
    for (const k of [key, `${key}:preview`]) expect(localStorage.getItem(k)).toBeNull();
    expect(localStorage.getItem(other)).toBe('{}');
  });

  it('deletes nothing of a draft whose deposit’s ids are kept: a deposit not finished is reached from it', () => {
    const index = { current: 'b', items: [saved('a'), saved('b')] };
    writeIndex(base, index);
    const key = conversationStoreKey(base, 'a');
    localStorage.setItem(key, '{"turns":1}');
    localStorage.setItem(`${key}:deposit`, JSON.stringify({ planId: 'plan-1', orderId: 'o-1' }));
    expect(deleteConversation(base, index, 'a')).toBe(index);
    expect(localStorage.getItem(key)).toBe('{"turns":1}');
    expect(localStorage.getItem(`${key}:deposit`)).not.toBeNull();
    expect(readIndex(base)).toEqual(index);
  });

  it('gives the one on screen way to a new, empty one', () => {
    const index = { current: 'a', items: [saved('a')] };
    const next = deleteConversation(base, index, 'a');
    expect(next.items).toEqual([]);
    expect(next.current).not.toBe('a');
    expect(next.current).toMatch(/^[0-9a-f]{8}$/);
  });

  it('deletes the conversation kept before the index under the base key itself', () => {
    localStorage.setItem(base, '{}');
    const next = deleteConversation(base, readIndex(base), 'main');
    expect(localStorage.getItem(base)).toBeNull();
    expect(next.items).toEqual([]);
  });
});
