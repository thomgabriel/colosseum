// @vitest-environment happy-dom
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { click, find, fire, mount, unmountAll } from '../../components/ui/test/dom';
import { dictionary } from '../../i18n';
import { inLanguage } from '../account/test/screen';
import { Composition, type CompositionItem, type CompositionProps } from './Composition';
import { coloursOf } from './composition-colours';

// What a vault holds as a strip and a table, or as two strips and a table (gate WEIGHTS-RING): the
// colours follow the holdings, a row and its segment light each other from the pointer and the
// keyboard, a sliver stays a segment, the caller's columns sit where it asks, and nothing is drawn
// for nothing.

const en = dictionary('en');
const c = en.shared.composition;

const item = (key: string, bps: number, over: Partial<CompositionItem> = {}): CompositionItem => ({
  key: `solana:${key}`,
  name: key.toUpperCase(),
  bps,
  ...over,
});
const view = (props: CompositionProps, lang: 'en' | 'pt' = 'en') =>
  mount(inLanguage(lang, createElement(Composition, props)));
afterEach(unmountAll);

const segments = (host: ParentNode, bar = '[data-ui="composition-strip"]') =>
  [...host.querySelectorAll<HTMLElement>(`${bar} [data-ui="composition-segment"]`)].map((s) => ({
    key: s.getAttribute('data-key'),
    fill: s.style.background,
    dim: s.getAttribute('data-dim'),
  }));
const row = (host: ParentNode, key: string) => find(host, `[data-row="solana:${key}"]`);
const button = (host: ParentNode, key: string) =>
  find<HTMLButtonElement>(row(host, key), 'button[data-ui="composition-row"]');
const over = () => new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body });
const out = () => new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body });

const THREE = [
  item('spy', 5000, { asset: 'solana:spy', venue: 'xStocks' }),
  item('nvda', 3000),
  item('usdc', 2000, { cash: true, name: 'Cash (USDC)' }),
];

describe('one composition, as a strip and a table', () => {
  it('draws a segment per holding in the order given, honey first, cash in its neutral', async () => {
    const host = await view({ items: THREE });
    expect(segments(host)).toEqual([
      { key: 'solana:spy', fill: 'var(--tf-share-1)', dim: null },
      { key: 'solana:nvda', fill: 'var(--tf-share-2)', dim: null },
      { key: 'solana:usdc', fill: 'var(--tf-share-cash)', dim: null },
    ]);
    // the strip is said once in words; nothing in it is a control
    const picture = find(host, '[role="img"]');
    expect(picture.getAttribute('aria-label')).toBe(
      c.summary('SPY 50%, NVDA 30%, Cash (USDC) 20%'),
    );
    expect(picture.querySelector('button, a, [tabindex]')).toBeNull();
    // a table: a head, a row a holding, the asset as the row's head
    expect([...host.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual([
      c.asset,
      c.weight,
    ]);
    const spy = row(host, 'spy');
    expect(spy.tagName).toBe('TR');
    expect(find(spy, 'th[scope="row"]').textContent).toContain('SPY');
    expect(find(spy, '[data-part="sub"]').textContent).toBe('xStocks');
    expect(find(spy, '[data-ui="composition-share"]').textContent).toBe('50%');
    expect(spy.querySelector('[data-ui="asset-mark"]')).not.toBeNull();
    // the weight's bar is the holding's colour, as long as its share against the largest
    const bar = find<HTMLElement>(spy, '[data-part="weight-bar"] > span');
    expect(bar.style.background).toBe('var(--tf-share-1)');
    expect(bar.style.width).toBe('100%');
    expect(
      find<HTMLElement>(row(host, 'nvda'), '[data-part="weight-bar"] > span').style.width,
    ).toBe('60%');
    // a holding with no logo has a dot of its colour
    expect(find(row(host, 'nvda'), '[data-part="swatch"] circle').getAttribute('fill')).toBe(
      'var(--tf-share-2)',
    );
  });

  it('lights the segment of the row pointed at and dims the others', async () => {
    const host = await view({ items: THREE });
    await fire(row(host, 'nvda'), over());
    expect(segments(host).map((s) => s.dim)).toEqual(['true', null, 'true']);
    expect(row(host, 'nvda').getAttribute('data-lit')).toBe('true');
    await fire(row(host, 'nvda'), out());
    expect(segments(host).map((s) => s.dim)).toEqual([null, null, null]);
  });

  it('does the same from the keyboard, and a press keeps it lit until pressed again', async () => {
    const host = await view({ items: THREE });
    const usdc = button(host, 'usdc');
    expect(usdc.className).toContain('focus-visible:outline-2');
    expect(usdc.getAttribute('aria-label')).toBe('Cash (USDC), 20%');
    await fire(usdc, new FocusEvent('focusin', { bubbles: true }));
    expect(segments(host).map((s) => s.dim)).toEqual(['true', 'true', null]);
    await fire(usdc, new FocusEvent('focusout', { bubbles: true }));
    expect(segments(host).map((s) => s.dim)).toEqual([null, null, null]);
    await click(usdc);
    expect(usdc.getAttribute('aria-pressed')).toBe('true');
    expect(row(host, 'usdc').getAttribute('data-lit')).toBe('true');
    await click(usdc);
    expect(usdc.getAttribute('aria-pressed')).toBe('false');
    expect(row(host, 'usdc').getAttribute('data-lit')).toBeNull();
  });

  it('lights the row of the segment pointed at', async () => {
    const host = await view({ items: THREE });
    const segment = find(host, '[data-ui="composition-segment"][data-key="solana:spy"]');
    await fire(segment, over());
    expect(row(host, 'spy').getAttribute('data-lit')).toBe('true');
    expect(host.querySelectorAll('[data-row][data-lit]')).toHaveLength(1);
    await fire(segment, out());
    expect(host.querySelectorAll('[data-row][data-lit]')).toHaveLength(0);
  });

  it('draws nothing for nothing: no holdings, or every share at nothing', async () => {
    expect((await view({ items: [] })).innerHTML).toBe('');
    expect((await view({ items: [item('spy', 0), item('nvda', 0)] })).innerHTML).toBe('');
  });

  it('draws no strip for one holding, and leaves out a holding at nothing', async () => {
    const host = await view({ items: [item('spy', 10_000), item('nvda', 0)] });
    expect(host.querySelector('[data-ui="composition-strip"]')).toBeNull();
    expect(host.querySelectorAll('[data-row]')).toHaveLength(1);
  });

  it('keeps a 0.5% holding a segment that can be seen and pointed at', async () => {
    const host = await view({ items: [item('spy', 9950), item('dust', 50)] });
    const dust = find<HTMLElement>(host, '[data-ui="composition-segment"][data-key="solana:dust"]');
    // its share of the strip, and never narrower than 4px
    expect(dust.style.flexGrow).toBe('50');
    expect(dust.className).toContain('min-w-1');
    await fire(dust, over());
    expect(row(host, 'dust').getAttribute('data-lit')).toBe('true');
  });

  it('holds sixteen: six colours in order, the rest in one, and every holding its own segment and row', async () => {
    const items = Array.from({ length: 16 }, (_, i) => item(`a${i}`, i === 0 ? 2500 : 500));
    const host = await view({ items });
    const drawn = segments(host);
    expect(drawn).toHaveLength(16);
    expect(drawn.slice(0, 6).map((s) => s.fill)).toEqual(
      [1, 2, 3, 4, 5, 6].map((n) => `var(--tf-share-${n})`),
    );
    expect(new Set(drawn.slice(6).map((s) => s.fill))).toEqual(new Set(['var(--tf-share-rest)']));
    expect(host.querySelectorAll('[data-row]')).toHaveLength(16);
  });

  it('hatches a sample holding and keeps its share in words', async () => {
    const host = await view({ items: [item('spy', 6000), item('bond', 4000, { mock: true })] });
    expect(segments(host)[1]?.fill).toMatch(/^url\("?#composition-hatch-/);
    expect(row(host, 'bond').textContent).toContain('40%');
  });

  it('sets the caller’s columns before and after the weight, with a dash where a row has none', async () => {
    const host = await view({
      items: [
        item('spy', 6000, { cells: { kind: 'Stock', yield: '4.39%' }, detail: '2.5 SPY' }),
        item('nvda', 4000, { cells: { kind: 'Stock' } }),
      ],
      columns: [
        { key: 'kind', header: 'Type', place: 'before' },
        { key: 'yield', header: 'Yield', numeric: true },
      ],
    });
    expect([...host.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual([
      c.asset,
      'Type',
      c.weight,
      'Yield',
    ]);
    const spy = row(host, 'spy');
    expect(find(spy, '[data-column="kind"]').textContent).toContain('Stock');
    expect(find(spy, '[data-column="yield"]').textContent).toContain('4.39%');
    expect(find(spy, '[data-column="yield"]').className).toContain('text-right');
    // the detail takes the venue's place under the name
    expect(find(spy, '[data-part="sub"]').textContent).toBe('2.5 SPY');
    expect(find(row(host, 'nvda'), '[data-column="yield"]').textContent).toContain('—');
  });

  it('a compact list on a card: the strip and a short list, no table', async () => {
    const host = await view({ size: 'compact', items: THREE });
    expect(host.querySelector('table')).toBeNull();
    expect(host.querySelectorAll('[data-ui="composition-segment"]')).toHaveLength(3);
    // the row reads as a line: the name, then the share
    expect(row(host, 'spy').textContent).toContain('SPY 50%');
    expect(find(row(host, 'spy'), '[data-ui="composition-share"]').textContent).toBe('50%');
  });

  it('a card lists its three largest, then how many more; the strip keeps every holding', async () => {
    const items = [
      item('a', 1000),
      item('b', 3000),
      item('c', 500),
      item('d', 2500),
      item('e', 2000),
      item('f', 1000),
    ];
    const host = await view({ size: 'compact', items, top: 3 });
    expect(
      [...host.querySelectorAll('li[data-row]')].map((li) => li.getAttribute('data-row')),
    ).toEqual(['solana:b', 'solana:d', 'solana:e']);
    expect(find(host, '[data-ui="composition-more"]').textContent).toBe(c.more(3));
    expect(segments(host)).toHaveLength(6);
    await unmountAll();
    // three or fewer: all of them, and no line for more
    const few = await view({ size: 'compact', items: THREE, top: 3 });
    expect(few.querySelectorAll('li[data-row]')).toHaveLength(3);
    expect(few.querySelector('[data-ui="composition-more"]')).toBeNull();
  });

  it('still, on a card that is one link: no row is a control, and nothing lights', async () => {
    const host = await view({ items: THREE, size: 'compact', still: true });
    expect(host.querySelectorAll('button')).toHaveLength(0);
    await fire(row(host, 'spy'), over());
    expect(row(host, 'spy').getAttribute('data-lit')).toBeNull();
    expect(segments(host).map((s) => s.dim)).toEqual([null, null, null]);
    expect(host.querySelectorAll('[data-ui="composition-share"]')).toHaveLength(3);
  });

  it('speaks Portuguese', async () => {
    const pt = dictionary('pt');
    const host = await view({ items: THREE }, 'pt');
    expect(find(host, '[role="img"]').getAttribute('aria-label')).toContain('O que tem:');
    expect([...host.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual([
      pt.shared.composition.asset,
      pt.shared.composition.weight,
    ]);
  });
});

describe('a comparison, as two strips', () => {
  const MOVE: CompositionItem[] = [
    item('spy', 5000, { beforeBps: 4000 }),
    item('nvda', 3000, { beforeBps: 3000 }),
    item('tsla', 0, { beforeBps: 3000 }),
    item('gold', 2000),
  ];

  it('draws the before strip over the after strip, the same colour for the same holding in both', async () => {
    const host = await view({ items: MOVE, mode: 'compare' });
    expect(host.querySelector('[data-ui="composition-strip"]')).toBeNull();
    const bar = (which: string) =>
      [
        ...find(
          host,
          `[data-ui="composition-bar"][data-bar="${which}"]`,
        ).querySelectorAll<HTMLElement>('[data-ui="composition-segment"]'),
      ].map((s) => [s.getAttribute('data-key'), s.style.background, s.style.flexGrow]);
    expect(bar('before')).toEqual([
      ['solana:spy', 'var(--tf-share-1)', '4000'],
      ['solana:nvda', 'var(--tf-share-2)', '3000'],
      ['solana:tsla', 'var(--tf-share-3)', '3000'],
    ]);
    expect(bar('after')).toEqual([
      ['solana:spy', 'var(--tf-share-1)', '5000'],
      ['solana:nvda', 'var(--tf-share-2)', '3000'],
      ['solana:gold', 'var(--tf-share-4)', '2000'],
    ]);
    const labels = find(host, '[data-ui="composition-bars"]').textContent;
    expect(labels).toContain(c.before);
    expect(labels).toContain(c.after);
    expect([...host.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual([
      c.asset,
      c.weight,
      c.before,
      c.changeHead,
    ]);
  });

  it('writes each share after, the one before, and the signed difference coloured by direction', async () => {
    const host = await view({ items: MOVE, mode: 'compare' });
    const delta = (key: string) => find(row(host, key), '[data-ui="composition-delta"]');
    expect(find(row(host, 'spy'), '[data-ui="composition-share"]').textContent).toBe('50%');
    expect(find(row(host, 'spy'), '[data-column="before"]').textContent).toContain('40%');
    expect(delta('spy').getAttribute('data-direction')).toBe('up');
    expect(delta('spy').className).toContain('text-leaf');
    expect(find(delta('spy'), '[aria-hidden]').textContent).toBe('+10%');
    expect(delta('tsla').getAttribute('data-direction')).toBe('down');
    expect(delta('tsla').className).toContain('text-madder');
    expect(find(delta('tsla'), '[aria-hidden]').textContent).toBe('−30%');
    // where nothing moved, no difference is drawn: the word says so
    expect(row(host, 'nvda').querySelector('[data-ui="composition-delta"]')).toBeNull();
    expect(find(row(host, 'nvda'), '[data-column="change"]').textContent).toBe(c.unchanged);
    expect(find(row(host, 'gold'), '[data-column="before"]').textContent).toContain(c.added);
    // a screen reader hears which share is which
    expect(
      row(host, 'spy').querySelector('[data-ui="composition-share"]')?.previousSibling?.textContent,
    ).toBe(c.after);
  });

  it('writes a change of one basis point, and takes the caller’s words for its columns', async () => {
    const host = await view({
      items: [item('spy', 5001, { beforeBps: 5000 }), item('nvda', 4999, { beforeBps: 4999 })],
      mode: 'compare',
      labels: {
        before: 'Planned',
        after: 'Now',
        change: 'Drift',
        difference: (d) => `${d} against its target`,
        unchanged: '',
      },
    });
    expect([...host.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual([
      c.asset,
      c.weight,
      'Planned',
      'Drift',
    ]);
    expect(find(row(host, 'spy'), '[data-ui="composition-delta"] [aria-hidden]').textContent).toBe(
      '+0.01%',
    );
    expect(row(host, 'spy').textContent).toContain('+0.01% against its target');
    // nothing to say where a share is on its plan: a dash
    expect(find(row(host, 'nvda'), '[data-column="change"]').textContent).toBe('—');
  });

  it('links a row and its segments in both strips', async () => {
    const host = await view({ items: MOVE, mode: 'compare' });
    await fire(row(host, 'spy'), over());
    const dimmed = [...host.querySelectorAll('[data-ui="composition-segment"][data-dim]')].map(
      (s) => s.getAttribute('data-key'),
    );
    expect(dimmed).not.toContain('solana:spy');
    expect(dimmed).toHaveLength(4);
    await fire(row(host, 'spy'), out());
    const [segment] = [
      ...host.querySelectorAll('[data-ui="composition-segment"][data-key="solana:nvda"]'),
    ];
    await fire(segment as Element, over());
    expect(row(host, 'nvda').getAttribute('data-lit')).toBe('true');
  });
});

describe('the colours', () => {
  it('follow the order given, cash its own, past six the rest', () => {
    expect(coloursOf([{}, { cash: true }, {}, {}, {}, {}, {}, {}])).toEqual([
      'share-1',
      'share-cash',
      'share-2',
      'share-3',
      'share-4',
      'share-5',
      'share-6',
      'share-rest',
    ]);
  });
});
