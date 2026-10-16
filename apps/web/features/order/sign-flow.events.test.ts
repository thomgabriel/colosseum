// @vitest-environment happy-dom
import { createElement as h } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { find, hintOf, mount, unmountAll } from '../../components/ui/test/dom';
import { AmountList, Fold, ShareList, SignedSteps, StepPanel, StepStrip } from './SignFlow';

// The parts of the order screen one screen at a time (gate SIGN-ONE-STEP), drawn on their own: the
// strip marks what is done and names the step under way, the picture reads rounded with the exact
// figure on hover, a signed step keeps its transaction, and the step's state is said politely.

afterEach(unmountAll);

const names = ['Set targets', 'Swap', 'Done'];
const strip = (at: number) =>
  mount(h(StepStrip, { names, at, label: 'Where you are in the steps', doneWord: 'done' }));

describe('the strip over the steps', () => {
  it('marks the steps before the one under way as done, and that one as the current step', async () => {
    const host = await strip(1);
    const items = [...host.querySelectorAll('[data-ui="sign-progress"] li')];
    expect(items.map((li) => li.getAttribute('data-done'))).toEqual(['true', 'false', 'false']);
    expect(items.map((li) => li.getAttribute('aria-current'))).toEqual([null, 'step', null]);
    // a done step is said so to a screen reader; the others are only named
    expect(items[0]?.textContent).toBe('Set targets, done');
    expect(items[1]?.textContent).toContain('Swap');
    expect(find(host, 'ol').getAttribute('aria-label')).toBe('Where you are in the steps');
  });

  it('names only the step under way on a phone, the others kept for a screen reader', async () => {
    const host = await strip(1);
    const named = [...host.querySelectorAll('li > span:not([aria-hidden])')].filter(
      (span) => !span.classList.contains('sr-only'),
    );
    expect(named.map((span) => span.className.includes('max-sm:sr-only'))).toEqual([
      true,
      false,
      true,
    ]);
  });

  it('marks a skipped step skipped, never done', async () => {
    const host = await mount(
      h(StepStrip, {
        names,
        at: 2,
        label: 'l',
        doneWord: 'done',
        skipped: [1],
        skippedWord: 'skipped',
      }),
    );
    const items = [...host.querySelectorAll('[data-ui="sign-progress"] li')];
    expect(items.map((li) => li.getAttribute('data-done'))).toEqual(['true', 'false', 'true']);
    expect(items[1]?.textContent).toContain(', skipped');
  });

  it('marks every place done once the last one is reached', async () => {
    const host = await strip(2);
    const items = [...host.querySelectorAll('[data-ui="sign-progress"] li')];
    expect(items.map((li) => li.getAttribute('data-done'))).toEqual(['true', 'true', 'true']);
    expect(items[2]?.getAttribute('aria-current')).toBe('step');
  });
});

describe('the picture of what changes', () => {
  const labels = {
    before: 'Before',
    after: 'After',
    unchanged: 'unchanged',
    holding: 'Holding',
    change: 'Change',
    points: (bps: number) => `${Math.round(bps / 100)} pp`,
  };
  const share = (bps: number) => `${bps / 100}%`;

  /** A cell's own words, without the column's name a folded row writes over its figure. */
  const own = (el: Element | null) =>
    el
      ? [...el.childNodes]
          .filter((n) => n.nodeType === 3 || !(n as Element).matches?.('[data-part="fold-label"]'))
          .map((n) => n.textContent)
          .join('')
      : undefined;
  /** Each row of the composition: its name, its share after, its share before and its move. */
  const cells = (host: HTMLElement) =>
    [...host.querySelectorAll('[data-ui="composition-table"] tbody tr')].map((tr) =>
      [
        tr.querySelector('[data-part="name"]')?.textContent,
        tr.querySelector('[data-ui="composition-share"]')?.textContent,
        own(tr.querySelector('[data-column="before"]')),
        tr.querySelector('[data-column="change"] [aria-hidden="true"]')?.textContent ??
          own(tr.querySelector('[data-column="change"]')),
      ].filter((cell) => cell !== undefined),
    );
  const heads = (host: HTMLElement) =>
    [...host.querySelectorAll('[data-ui="composition-table"] thead th')].map(
      (th) => th.textContent,
    );

  it('sets each holding’s share after beside its share before and the move, as the shared composition', async () => {
    const host = await mount(
      h(ShareList, {
        caption: 'Your vault’s targets',
        share,
        labels,
        items: [
          { key: 'spy', name: 'SPY', asset: 'solana:spy', beforeBps: 6000, bps: 7000 },
          { key: 'nvda', name: 'NVDA', asset: 'solana:nvda', beforeBps: 3000, bps: 2000 },
          { key: 'gold', name: 'Gold', asset: 'solana:gold', beforeBps: 1000, bps: 1000 },
        ],
      }),
    );
    // the composition's comparison (WEIGHTS-RING): two strips, and its columns in its own order
    expect(find(host, '[data-ui="composition"]').dataset.mode).toBe('compare');
    expect(heads(host)).toEqual(['Holding', 'After', 'Before', 'Change']);
    expect(find(host, 'caption').textContent).toBe('Your vault’s targets');
    const rows = cells(host);
    // the move in points: a share's change is never said as a percent of a percent
    expect(rows[0]).toEqual(['SPY', '70%', '60%', '+10 pp']);
    expect(rows[1]?.[3]).toBe('\u221210 pp');
    expect(rows[2]?.[3]).toBe('unchanged');
  });

  it('says a move smaller than a whole point as under one, never as +0 pp', async () => {
    const host = await mount(
      h(ShareList, {
        caption: 'c',
        // whole shares, as the screens show them
        share: (bps: number) => `${Math.round(bps / 100)}%`,
        labels,
        items: [
          { key: 'spy', name: 'SPY', beforeBps: 4996, bps: 5000 },
          { key: 'cash', name: 'Cash', cash: true, beforeBps: 5004, bps: 5000 },
        ],
      }),
    );
    expect(cells(host).map((row) => row[3])).toEqual(['+<1 pp', '\u2212<1 pp']);
  });

  it('shows one composition where nothing before is known', async () => {
    const host = await mount(
      h(ShareList, {
        caption: 'c',
        share,
        labels,
        items: [{ key: 'spy', name: 'SPY', bps: 7000 }],
      }),
    );
    expect(find(host, '[data-ui="composition"]').dataset.mode).toBe('single');
    expect(heads(host)).toEqual(['Holding', 'After']);
    expect(cells(host)).toEqual([['SPY', '70%']]);
  });

  it('reads an amount rounded, with the exact one on hover', async () => {
    const host = await mount(
      h(AmountList, {
        labels: { holding: 'Holding', amount: 'Amount' },
        picture: {
          caption: 'Where your $10 goes',
          columns: ['Amount'],
          rows: [
            { key: 'solana:spyx', name: 'SPYx', cells: [{ shown: '$6', exact: '$6.00' }] },
            { key: 'cash', name: 'Cash', cells: [{ shown: '$4', exact: '$4' }] },
          ],
        },
      }),
    );
    expect(await hintOf(find(host, '[data-ui="hint"]'))).toBe('$6.00');
    expect(host.querySelectorAll('[data-ui="hint"]')).toHaveLength(1);
  });
});

describe('the steps already signed', () => {
  it('lists each with a check and its transaction, and nothing when none is signed yet', async () => {
    const host = await mount(
      h(SignedSteps, {
        label: 'Signed',
        explorer: 'Solscan',
        links: {},
        steps: [
          { key: 'a', name: 'Set targets', txId: 'sig0', href: 'https://explorer.example/tx/sig0' },
        ],
      }),
    );
    const past = find(host, '[data-ui="sign-past"]');
    expect(past.getAttribute('aria-label')).toBe('Signed');
    expect(past.textContent).toContain('Set targets');
    expect(find<HTMLAnchorElement>(past, 'a').href).toBe('https://explorer.example/tx/sig0');
    const none = await mount(
      h(SignedSteps, { label: 'Signed', explorer: 'x', links: {}, steps: [] }),
    );
    expect(none.querySelector('[data-ui="sign-past"]')).toBeNull();
  });
});

describe('the step being signed', () => {
  it('leads with its figure, a label over it and its bounds under it, and its place for a screen reader', async () => {
    const host = await mount(
      h(
        StepPanel,
        {
          place: 'Step 2 of 2',
          label: 'Swap',
          hero: '$1,354 → GOOGLx',
          stats: [
            { label: 'At least', value: '3.76 GOOGLx', ui: 'stat-least' },
            { label: 'Under today’s price, at worst', value: '1%', ui: 'stat-under' },
          ],
          title: 'Swap $1,354 of cash for GOOGLx',
          plate: { text: 'Test network', ui: 'sample-tag' },
          status: h('p', null, 'Waiting for the chain…'),
        },
        h('button', { type: 'button' }, 'Sign: swap $1,354 for GOOGLx'),
      ),
    );
    const step = find(host, '[data-ui="sign-step"]');
    expect(step.getAttribute('aria-label')).toBe('Swap $1,354 of cash for GOOGLx');
    expect(find(step, '[data-ui="sign-label"]').textContent).toBe('Swap');
    expect(find(step, '[data-ui="sign-figure"]').textContent).toBe('$1,354 → GOOGLx');
    expect(find(step, '[data-ui="sign-hero"]').getAttribute('tabindex')).toBe('-1');
    expect(find(step, '[data-ui="stat-least"]').textContent).toBe('At least3.76 GOOGLx');
    expect(find(step, '[data-ui="sample-tag"]').textContent).toBe('Test network');
    expect(find(step, '.sr-only').textContent).toBe('Step 2 of 2');
    // the state is shown here and said by the order's one announcer, not a region of its own
    const status = find(step, '[data-ui="sign-status"]');
    expect(status.getAttribute('aria-live')).toBeNull();
    expect(status.textContent).toBe('Waiting for the chain…');
    expect(find(step, 'button').textContent).toBe('Sign: swap $1,354 for GOOGLx');
  });

  it('keeps what is folded closed until it is asked for', async () => {
    const host = await mount(
      h(Fold, { ui: 'sign-details', label: 'Details' }, h('p', null, 'exact')),
    );
    const fold = find<HTMLDetailsElement>(host, '[data-ui="sign-details"]');
    expect(fold.open).toBe(false);
    expect(find(fold, 'summary').textContent).toBe('Details');
  });
});
