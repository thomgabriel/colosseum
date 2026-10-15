// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, unmountAll } from '../../components/ui/test/dom';
import { useScrolls } from './use-scrolls';

// A box is a stop for the keyboard only while it scrolls (the vault page's panes and head): measured
// against what the box holds, and again as either changes size.

let watching: (() => void)[] = [];
let disconnected = 0;
class Sizes {
  constructor(private readonly cb: () => void) {}
  observe() {
    watching.push(this.cb);
  }
  disconnect() {
    disconnected += 1;
  }
}

afterEach(async () => {
  await unmountAll();
  watching = [];
  disconnected = 0;
  vi.unstubAllGlobals();
});

function Box({ heights }: { heights: { scroll: number; client: number } }) {
  const [ref, scrolls] = useScrolls<HTMLDivElement>();
  return createElement('div', {
    ref: (el: HTMLDivElement | null) => {
      if (el) {
        Object.defineProperty(el, 'scrollHeight', {
          configurable: true,
          get: () => heights.scroll,
        });
        Object.defineProperty(el, 'clientHeight', {
          configurable: true,
          get: () => heights.client,
        });
      }
      ref(el);
    },
    'data-scrolls': String(scrolls),
    tabIndex: scrolls ? 0 : undefined,
  });
}

describe('a box that scrolls', () => {
  it('is a stop for the keyboard while its content is taller than it, and not otherwise', async () => {
    vi.stubGlobal('ResizeObserver', Sizes);
    const heights = { scroll: 400, client: 400 };
    const host = await mount(createElement(Box, { heights }));
    const box = host.querySelector('div') as HTMLDivElement;
    expect(box.dataset.scrolls).toBe('false');
    expect(box.hasAttribute('tabindex')).toBe(false);
    heights.scroll = 900;
    await act(async () => {
      for (const cb of watching) cb();
    });
    expect(box.dataset.scrolls).toBe('true');
    expect(box.tabIndex).toBe(0);
    heights.scroll = 300;
    await act(async () => {
      for (const cb of watching) cb();
    });
    expect(box.hasAttribute('tabindex')).toBe(false);
  });

  it('lets go of what it watches once the box is gone', async () => {
    vi.stubGlobal('ResizeObserver', Sizes);
    const stopped = vi.fn();
    vi.stubGlobal(
      'MutationObserver',
      class {
        observe() {}
        disconnect() {
          stopped();
        }
      },
    );
    await mount(createElement(Box, { heights: { scroll: 900, client: 100 } }));
    const before = disconnected;
    await unmountAll();
    expect(disconnected).toBeGreaterThan(before);
    expect(stopped).toHaveBeenCalled();
  });

  it('is no stop where nothing can measure it', async () => {
    vi.stubGlobal('ResizeObserver', undefined);
    const host = await mount(createElement(Box, { heights: { scroll: 900, client: 100 } }));
    expect(host.querySelector('div')?.hasAttribute('tabindex')).toBe(false);
  });
});
