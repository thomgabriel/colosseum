import { describe, expect, it } from 'vitest';
import { card } from './test/cases';
import { all, classes, one, render, role, text, ui } from './test/html';

const root = (node: Parameters<typeof render>[0]) => {
  const tree = render(node);
  return { tree, card: one(tree, ui('card'), 'card') };
};

describe('Card (card.md)', () => {
  it('is a planed face: raised surface, hairline, 10px corners, no shadow', () => {
    const list = classes(root(card.plain).card);
    expect(list).toEqual(
      expect.arrayContaining(['bg-card', 'border', 'border-border', 'rounded-lg']),
    );
    for (const node of Object.values(card))
      for (const el of all(render(node)))
        expect(classes(el).join(' ')).not.toMatch(
          /shadow|rounded-(md|xl|2xl|full|none)\b|backdrop|\b(bg|border)-[a-z0-9-]+\/\d+/,
        );
  });

  it('pads 24px, or 16px when dense, and parts its sections with full-width hairlines', () => {
    const { tree } = root(card.plain);
    expect(classes(one(tree, ui('card-header')))).toContain('p-6');
    expect(classes(one(tree, ui('card-body')))).toEqual(
      expect.arrayContaining(['p-6', 'not-first:border-t', 'not-first:border-border']),
    );
    expect(classes(one(root(card.dense).tree, ui('card-body')))).toContain('p-4');
  });

  it('puts the meta on the right of the header in muted caption text', () => {
    const header = one(root(card.plain).tree, ui('card-header'));
    expect(text(one(header, (e) => role(e) === 'heading'))).toBe('Policy check');
    expect(text(header)).toContain('as of 14:02 UTC');
  });

  it('deepens its hairline on hover and takes the focus ring, when it is a link', () => {
    const { tree, card: c } = root(card.interactive);
    expect(classes(c)).toEqual(
      expect.arrayContaining(['hover:border-input', 'focus-within:outline-2']),
    );
    const link = one(tree, (e) => e.tag === 'a');
    expect(classes(link)).toEqual(expect.arrayContaining(['after:absolute', 'after:inset-0']));
    expect(classes(root(card.plain).card)).not.toContain('hover:border-input');
  });

  it('shows selection with a 2px honey edge and says it', () => {
    const { card: c } = root(card.selected);
    expect(classes(c)).toEqual(expect.arrayContaining(['border-l-2', 'border-l-primary']));
    expect(c.attrs['aria-current']).toBe('page');
  });

  it('when mocked says so in one quiet tag in its top-right corner: no hatch, never the word MOCK', () => {
    const { tree, card: c } = root(card.mock);
    const tag = one(tree, ui('sample-tag'));
    expect(text(tag)).toBe('Sample figures');
    // a tag: 6px corners, a hairline, caption size, the muted sample ink; nothing in honey or a status hue
    expect(classes(tag)).toEqual(
      expect.arrayContaining(['rounded-sm', 'border', 'border-border', 'text-caption']),
    );
    expect(classes(tag)).toContain('text-sample-foreground');
    expect(classes(tag).join(' ')).not.toMatch(/honey|primary|status|leaf|clay|madder/);
    // in the header's row, at its right, after the meta
    const header = one(tree, ui('card-header'));
    expect(all(header, ui('sample-tag'))).toHaveLength(1);
    expect(text(header).endsWith('as of 14:02 UTC' + 'Sample figures')).toBe(true);
    expect(all(c, ui('sample-tag-row'))).toHaveLength(0);
    // the hatched edge and the foot line are gone
    expect(all(tree, (e) => classes(e).includes('tf-hatch'))).toHaveLength(0);
    expect(all(tree, ui('hatch-band'))).toHaveLength(0);
    expect(all(tree, ui('sample-note'))).toHaveLength(0);
    expect(text(tree)).not.toContain('MOCK');
    // with nothing inside it but a body, and with nothing at all: the tag has a row of its own, first
    for (const node of [card.mockBody, card.mockEmpty]) {
      const bare = root(node);
      expect(all(bare.card, ui('sample-tag'))).toHaveLength(1);
      expect(bare.card.children[0]).toMatchObject({ attrs: { 'data-ui': 'sample-tag-row' } });
      expect(text(one(bare.card, ui('sample-tag')))).toBe('Sample figures');
    }
    // a live card has no tag, and draws its header as it always has
    for (const node of [card.plain, card.dense, card.interactive, card.selected, card.table]) {
      const live = root(node);
      expect(all(live.tree, ui('sample-tag'))).toHaveLength(0);
      expect(all(live.tree, ui('sample-tag-row'))).toHaveLength(0);
    }
  });

  it('says its tag in the language it is told, with the test network after it', () => {
    const told = root(card.mockNoted);
    expect(text(one(told.tree, ui('sample-tag')))).toBe('Números de exemplo · rede de teste');
    expect(all(told.tree, (e) => classes(e).includes('tf-hatch'))).toHaveLength(0);
    // with no note, no note
    expect(text(one(root(card.mockTold).tree, ui('sample-tag')))).toBe('Números de exemplo');
  });

  it('has the same 10px corners as a table panel', () => {
    expect(classes(root(card.table).card)).toContain('rounded-lg');
  });

  it('waits and stands empty in words, beside the still lattice', () => {
    const loading = one(render(card.loading), (e) => role(e) === 'status');
    expect(text(loading)).toBe('Loading the plan');
    expect(all(loading, ui('lattice'))).toHaveLength(1);
    const empty = one(render(card.empty), ui('card-empty'));
    expect(text(empty)).toContain('No plans yet.');
    expect(all(empty, ui('button'))).toHaveLength(1);
  });

  it('sets stat cells side by side with hairlines between, a muted label over a display-face value', () => {
    const tree = render(card.stats);
    const rowEl = one(tree, ui('stat-row'));
    expect(classes(rowEl)).toEqual(expect.arrayContaining(['divide-x', 'divide-border']));
    expect(classes(rowEl).join(' ')).not.toMatch(/\bgap-/);
    const stats = all(tree, ui('stat'));
    expect(stats).toHaveLength(2);
    expect(classes(one(stats[0] as never, (e) => e.tag === 'dd'))).toEqual(
      expect.arrayContaining(['font-display', 'font-semibold', 'tabular-nums']),
    );
    // a count has no pin; a rate has one
    expect(all(stats[0] as never, ui('pin'))).toHaveLength(0);
    expect(all(stats[1] as never, ui('pin'))).toHaveLength(1);
  });
});
