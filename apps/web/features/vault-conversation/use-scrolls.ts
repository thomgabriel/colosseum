'use client';
import { useEffect, useState } from 'react';

/**
 * Whether a box scrolls now: its content is taller than it is. A box that scrolls is a stop for the
 * keyboard (so its arrows scroll it), and one that does not is not: on a phone, where the page scrolls
 * and the box grows, or in a tall window, where everything fits, Tab does not stop on it for nothing.
 * Watched as the box and what is in it change size. Returns the ref to put on the box (it may come and
 * go) and the answer.
 */
export function useScrolls<T extends HTMLElement>(): [(el: T | null) => void, boolean] {
  const [el, setEl] = useState<T | null>(null);
  const [scrolls, setScrolls] = useState(false);
  useEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') {
      setScrolls(false);
      return;
    }
    const measure = () => setScrolls(el.scrollHeight > el.clientHeight + 1);
    const sizes = new ResizeObserver(measure);
    const watch = () => {
      sizes.disconnect();
      sizes.observe(el);
      for (const child of el.children) sizes.observe(child);
      measure();
    };
    watch();
    // a child that comes or goes (a draft, a fold opened) is watched too
    const changes = new MutationObserver(watch);
    changes.observe(el, { childList: true });
    return () => {
      sizes.disconnect();
      changes.disconnect();
    };
  }, [el]);
  return [setEl, scrolls];
}
