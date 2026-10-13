import { useEffect, useState } from 'react';

// An order whose every step is confirmed changes what the person holds: whatever shows their figures
// reads them again. Said in this tab with a window event, and to the person's other tabs through a
// storage key they hear change. Nothing of the order travels: only that one ended.

/** The window event an order that ended is announced by, in this tab. */
export const ORDER_DONE_EVENT = 'tf:order-done';
/** The storage key other tabs hear change when an order ends in this one. */
export const ORDER_DONE_KEY = 'tf-order-done:1';

/** Says that an order ended, to this tab and the others of this browser. */
export function announceOrderDone() {
  window.dispatchEvent(new Event(ORDER_DONE_EVENT));
  try {
    localStorage.setItem(ORDER_DONE_KEY, String(Date.now()));
  } catch {
    // storage blocked: this tab still heard it
  }
}

/** Calls `heard` when an order ends in this tab or another; returns what stops listening. */
export function onOrderDone(heard: () => void): () => void {
  const fromStorage = (event: StorageEvent) => {
    if (event.key === ORDER_DONE_KEY) heard();
  };
  window.addEventListener(ORDER_DONE_EVENT, heard);
  window.addEventListener('storage', fromStorage);
  return () => {
    window.removeEventListener(ORDER_DONE_EVENT, heard);
    window.removeEventListener('storage', fromStorage);
  };
}

/** How many orders have ended since the screen opened: a read that depends on it is made again. */
export function useOrdersEnded(): number {
  const [ended, setEnded] = useState(0);
  useEffect(() => onOrderDone(() => setEnded((n) => n + 1)), []);
  return ended;
}
