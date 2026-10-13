// @vitest-environment happy-dom
import { createElement as h } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { find, hintOf, mount, unmountAll } from '../../components/ui/test/dom';
import { ChangeTable, Fold, SignedSteps, StepPanel, StepStrip } from './SignFlow';

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

  it('marks every place done once the last one is reached', async () => {
    const host = await strip(2);
    const items = [...host.querySelectorAll('[data-ui="sign-progress"] li')];
    expect(items.map((li) => li.getAttribute('data-done'))).toEqual(['true', 'true', 'true']);
    expect(items[2]?.getAttribute('aria-current')).toBe('step');
  });
});

describe('the picture of what changes', () => {
  it('reads each figure rounded, with the exact one on hover, and a dash where a side has none', async () => {
    const host = await mount(
      h(ChangeTable, {
        picture: {
          caption: 'Your vault’s targets',
          columns: ['Now', 'New'],
          rows: [
            {
              key: 'g',
              name: 'GOOGLx',
              cells: [null, { shown: '33%', exact: '33.33%' }],
            },
            { key: 'cash', name: 'Cash', cells: [{ shown: '100%', exact: '100%' }, null] },
          ],
        },
      }),
    );
    const rows = [...host.querySelectorAll('tbody tr')].map((tr) =>
      [...tr.querySelectorAll('th, td')].map((cell) => cell.textContent),
    );
    expect(rows).toEqual([
      ['GOOGLx', '—', '33%'],
      ['Cash', '100%', '—'],
    ]);
    expect(host.textContent).toContain('Your vault’s targets');
    expect(await hintOf(find(host, 'tbody tr td:last-child [data-ui="hint"]'))).toBe('33.33%');
    // a figure with nothing more to say has no hint
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
  it('says its place, what it does and its worst case, and its state in a polite live region', async () => {
    const host = await mount(
      h(
        StepPanel,
        {
          place: 'Step 2 of 2',
          title: 'Swap $1,354 of cash for GOOGLx',
          worst: 'At worst you get 3.76 GOOGLx, 1% under today’s price.',
          status: h('p', null, 'Waiting for the chain…'),
        },
        h('button', { type: 'button' }, 'Sign: swap $1,354 for GOOGLx'),
      ),
    );
    const step = find(host, '[data-ui="sign-step"]');
    expect(step.getAttribute('aria-label')).toBe('Swap $1,354 of cash for GOOGLx');
    expect(find(step, 'h3').textContent).toBe('Swap $1,354 of cash for GOOGLx');
    expect(find(step, '[data-ui="sign-worst"]').textContent).toContain('3.76 GOOGLx');
    const status = find(step, '[data-ui="sign-status"]');
    expect(status.getAttribute('aria-live')).toBe('polite');
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
