import { useEffect, useState } from 'react';

// An order whose every step is confirmed changes what the person holds: whatever shows their figures
// reads them again. Said in this tab with a window event, and to the person's other tabs through a
// storage key they hear change. Only the order's id travels, so a screen waiting on one order of its
// own can tell it from any other.

/** The window event an order that ended is announced by, in this tab. */
export const ORDER_DONE_EVENT = 'tf:order-done';
/** The storage key other tabs hear change when an order ends in this one. */
export const ORDER_DONE_KEY = 'tf-order-done:1';

/** Says that an order ended, to this tab and the others of this browser. */
export function announceOrderDone(orderId: string) {
  window.dispatchEvent(new CustomEvent(ORDER_DONE_EVENT, { detail: { orderId } }));
  try {
    // the time makes each a change other tabs hear, even for the same order
    localStorage.setItem(ORDER_DONE_KEY, `${Date.now()}:${orderId}`);
  } catch {
    // storage blocked: this tab still heard it
  }
}

/**
 * Calls `heard` with the order's id when an order ends in this tab or another (null where the id did
 * not travel); returns what stops listening.
 */
export function onOrderDone(heard: (orderId: string | null) => void): () => void {
  const here = (event: Event) => {
    const detail = (event as CustomEvent<{ orderId?: unknown }>).detail;
    heard(typeof detail?.orderId === 'string' ? detail.orderId : null);
  };
  const fromStorage = (event: StorageEvent) => {
    if (event.key !== ORDER_DONE_KEY) return;
    const at = event.newValue?.indexOf(':') ?? -1;
    heard(at > 0 && event.newValue ? event.newValue.slice(at + 1) || null : null);
  };
  window.addEventListener(ORDER_DONE_EVENT, here);
  window.addEventListener('storage', fromStorage);
  return () => {
    window.removeEventListener(ORDER_DONE_EVENT, here);
    window.removeEventListener('storage', fromStorage);
  };
}

/** How many orders have ended since the screen opened: a read that depends on it is made again. */
export function useOrdersEnded(): number {
  const [ended, setEnded] = useState(0);
  useEffect(() => onOrderDone(() => setEnded((n) => n + 1)), []);
  return ended;
}
