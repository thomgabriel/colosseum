import {
  type FocusEvent,
  type PointerEvent,
  type Ref,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { PIN_CLOSE_MS, PIN_OPEN_MS } from './provenance';

// The behaviour of the one tooltip (Hint.tsx, gate TOOLTIP-WORDS): what opens it, what closes it and
// where it goes. A hook and a pure function, apart from the components, because a client module
// exports components only (server-safe.test.ts). Only client components call the hook.

/** How long a mouse rests before it opens, and how long it has to cross to the panel (provenance.ts). */
export const HINT_OPEN_MS = PIN_OPEN_MS;
export const HINT_CLOSE_MS = PIN_CLOSE_MS;

/** How long after a press a focus on the trigger is still taken for the press's own. */
const PRESS_MS = 700;
const GAP = 8;
const EDGE = 16;

export type Place = {
  top: number;
  left: number;
  maxHeight: number;
  side: 'below' | 'above' | 'right' | 'left';
};

/**
 * Where a panel of this size goes for a trigger at this box, in a viewport of this size. Below, unless
 * it does not fit there and fits above; where it fits on neither side, the side with more room, with
 * its height held to that room. Never over the trigger; never nearer than 16px to an edge.
 */
export function placeFor(
  at: { top: number; bottom: number; left: number },
  size: { width: number; height: number },
  view: { width: number; height: number },
): Place {
  const below = view.height - EDGE - (at.bottom + GAP);
  const above = at.top - GAP - EDGE;
  const side = size.height <= below || below >= above ? 'below' : 'above';
  const room = Math.max(0, side === 'below' ? below : above);
  const height = Math.min(size.height, room);
  return {
    side,
    top: side === 'below' ? at.bottom + GAP : at.top - GAP - height,
    left: Math.max(EDGE, Math.min(at.left, view.width - size.width - EDGE)),
    maxHeight: room,
  };
}

/**
 * Where a panel goes beside a list of rows, so it never covers the row under its own (a rail's): right
 * of `at`'s right edge (the list's, where the trigger sits in one), else left of its left edge; level
 * with the trigger's top and held inside the viewport. Where it fits on neither side, as `placeFor`.
 */
export function besideFor(
  at: { top: number; bottom: number; left: number; right: number },
  size: { width: number; height: number },
  view: { width: number; height: number },
): Place {
  const right = view.width - EDGE - (at.right + GAP);
  const left = at.left - GAP - EDGE;
  if (size.width > right && size.width > left) return placeFor(at, size, view);
  const maxHeight = Math.max(0, view.height - 2 * EDGE);
  const top = Math.max(
    EDGE,
    Math.min(at.top, view.height - EDGE - Math.min(size.height, maxHeight)),
  );
  return size.width <= right
    ? { side: 'right', top, left: at.right + GAP, maxHeight }
    : { side: 'left', top, left: at.left - GAP - size.width, maxHeight };
}

/** The element a panel placed beside its trigger goes beside: the nearest one marked so, or the trigger. */
export const HINT_EDGE = 'data-hint-edge';

/** Whether this focus shows itself (`:focus-visible`): a script's focus after a press does not. */
function shown(target: EventTarget | null): boolean {
  if (!(target instanceof Element) || target !== document.activeElement) return true;
  try {
    return target.matches(':focus-visible');
  } catch {
    return true;
  }
}

export type HoverCard = {
  open: boolean;
  /** Opened by a press: it stays until a second press, Escape or a press elsewhere. */
  pinned: boolean;
  place: Place | null;
  close(): void;
  /** On the element that holds the trigger and the panel. */
  wrap: {
    ref: Ref<HTMLSpanElement>;
    onPointerEnter(event: PointerEvent<HTMLElement>): void;
    onPointerLeave(): void;
    onPointerDown(): void;
  };
  /** On the trigger. */
  trigger: {
    ref: Ref<HTMLElement>;
    onClick(): void;
    onFocus(event: FocusEvent<HTMLElement>): void;
  };
  panel: Ref<HTMLSpanElement>;
};

/** The behaviour of the one tooltip: what opens it, what closes it and where it goes. */
/**
 * `enabled` false: there is nothing to show for now. It opens on nothing and hears no Escape, and
 * the element it is on stays as it is.
 */
/**
 * `beside`: the panel goes beside the trigger's list (`besideFor`), not under the trigger, so it never
 * covers the next row and a press there is the row's.
 */
export function useHoverCard(defaultOpen = false, enabled = true, beside = false): HoverCard {
  const [isOpen, setOpen] = useState(defaultOpen);
  const open = isOpen && enabled;
  const [pinned, setPinned] = useState(defaultOpen);
  const [place, setPlace] = useState<Place | null>(null);
  const wrap = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLElement>(null);
  const panel = useRef<HTMLSpanElement>(null);
  const hover = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leave = useRef<ReturnType<typeof setTimeout> | null>(null);
  const press = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A press focuses the trigger before it clicks it: that focus is the press's, not the keyboard's.
  const pressed = useRef(false);
  // Escape gives focus back to the trigger, which must not open it again.
  const returning = useRef(false);

  useLayoutEffect(() => {
    if (!open) {
      setPlace(null);
      return;
    }
    const measure = () => {
      const at = trigger.current?.getBoundingClientRect();
      const box = panel.current;
      if (!at || !box) return;
      // The panel's own height, not the one a held height gave it.
      const rect = box.getBoundingClientRect();
      // What scrolls is the box inside the panel (Hint.tsx): its full height is the panel's own.
      const full = box.firstElementChild?.scrollHeight ?? 0;
      const size = { width: rect.width, height: Math.max(rect.height, box.scrollHeight, full) };
      const view = { width: window.innerWidth, height: window.innerHeight };
      if (!beside) return setPlace(placeFor(at, size, view));
      const edge = (
        trigger.current?.closest(`[${HINT_EDGE}]`) ?? trigger.current
      )?.getBoundingClientRect();
      setPlace(
        besideFor(
          {
            top: at.top,
            bottom: at.bottom,
            left: edge?.left ?? at.left,
            right: edge?.right ?? at.right,
          },
          size,
          view,
        ),
      );
    };
    measure();
    // What the panel holds can grow (the pin's details): it is placed again when it does.
    const grown = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    if (panel.current) grown?.observe(panel.current);
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      grown?.disconnect();
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [open, beside]);

  useEffect(() => {
    if (!open) return;
    // A press anywhere else closes it, and so does focus that moves to something else on the page.
    // Focus that goes nowhere (a press on the panel's own text, another window) leaves it open.
    // Escape closes it and gives focus back to the trigger.
    const outside = (event: globalThis.PointerEvent | globalThis.FocusEvent) => {
      if (wrap.current && !wrap.current.contains(event.target as Node)) {
        setOpen(false);
        setPinned(false);
      }
    };
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // This Escape is the tooltip's: a menu or a dialog around it stays open for the next one.
      event.stopPropagation();
      const inside = wrap.current?.contains(document.activeElement) ?? false;
      setOpen(false);
      setPinned(false);
      if (inside && document.activeElement !== trigger.current) {
        returning.current = true;
        trigger.current?.focus();
        returning.current = false;
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    // On the way down, before anything on the page hears it.
    document.addEventListener('keydown', onEscape, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('keydown', onEscape, true);
    };
  }, [open]);

  useEffect(
    () => () => {
      if (hover.current) clearTimeout(hover.current);
      if (leave.current) clearTimeout(leave.current);
      if (press.current) clearTimeout(press.current);
    },
    [],
  );

  return {
    open,
    pinned,
    place,
    close() {
      setOpen(false);
      setPinned(false);
    },
    wrap: {
      ref: wrap,
      // A mouse that rests on the trigger opens it, and the panel can be hovered in turn: the panel
      // is inside this element, and leaving does not close at once, so the pointer has time to cross
      // the gap between the two.
      onPointerEnter(event) {
        if (event.pointerType !== 'mouse') return;
        if (leave.current) clearTimeout(leave.current);
        leave.current = null;
        if (!open && enabled) hover.current = setTimeout(() => setOpen(true), HINT_OPEN_MS);
      },
      onPointerLeave() {
        if (hover.current) clearTimeout(hover.current);
        if (!open || pinned) return;
        leave.current = setTimeout(() => setOpen(false), HINT_CLOSE_MS);
      },
      onPointerDown() {
        // The focus a press brings comes with it on a mouse and at the lift of a finger: until the
        // click, or for as long as a tap may last, a focus is the press's own.
        pressed.current = true;
        if (press.current) clearTimeout(press.current);
        press.current = setTimeout(() => {
          pressed.current = false;
        }, PRESS_MS);
      },
    },
    trigger: {
      ref: trigger,
      // A tap, a click, Enter or Space: it opens and stays, and the next one closes it.
      onClick() {
        if (hover.current) clearTimeout(hover.current);
        pressed.current = false;
        if (!enabled) return;
        const next = !(open && pinned);
        setOpen(next);
        setPinned(next);
      },
      // The keyboard arriving opens it; it closes when focus goes elsewhere. A focus the page does not
      // show (a script's, back on a row after a press on its rename or delete) opens nothing.
      onFocus(event) {
        if (pressed.current || returning.current || !shown(event.target)) return;
        if (enabled) setOpen(true);
      },
    },
    panel,
  };
}
