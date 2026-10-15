import { type ComponentProps, createElement as h } from 'react';
import { describe, expect, it } from 'vitest';
import { KIT_CELL, KIT_ROW, KitTable, KitTh } from './KitTable';
import { classes, name, one, render, tag } from './test/html';

// The house kit's table (HOUSE-KIT): a table wider than its screen scrolls in its box, and that box is
// a region the keyboard can reach, named as the table is (data-table.md). axe's
// scrollable-region-focusable finds it otherwise, as it did at 375 on the order's review.

const head = h(KitTh, null, 'Holding');
const row = h('tr', { className: KIT_ROW }, h('td', { className: KIT_CELL }, 'SPY'));
/** The table with one row, named as asked. */
const kit = (named: Omit<ComponentProps<typeof KitTable>, 'head' | 'children'>) =>
  h(KitTable, { head, ...named } as ComponentProps<typeof KitTable>, row);
const region = (root: ReturnType<typeof render>) => one(root, (e) => e.tag === 'section');

describe('KitTable', () => {
  it('scrolls in a region the keyboard reaches, named by the table’s caption', () => {
    const root = render(kit({ caption: 'Your vault’s targets' }));
    const box = region(root);
    expect(classes(box)).toContain('overflow-x-auto');
    expect(box.attrs.tabindex ?? box.attrs.tabIndex).toBe('0');
    expect(classes(box)).toEqual(expect.arrayContaining(['focus-visible:outline-2']));
    expect(name(box, root)).toBe('Your vault’s targets');
    // the table keeps the same name, and its caption is read out only
    const table = one(box, tag('table'));
    expect(name(table, root)).toBe('Your vault’s targets');
    expect(classes(one(table, tag('caption')))).toContain('sr-only');
  });

  it('takes a label in place of a caption', () => {
    const root = render(kit({ label: 'Your vaults' }));
    expect(name(region(root), root)).toBe('Your vaults');
    expect(() => one(root, tag('caption'))).toThrow();
  });

  it('takes the heading over it as its name', () => {
    const root = render(
      h('div', null, h('h2', { id: 'vaults-head' }, 'Vaults'), kit({ labelledBy: 'vaults-head' })),
    );
    expect(name(region(root), root)).toBe('Vaults');
    expect(name(one(root, tag('table')), root)).toBe('Vaults');
  });
});
