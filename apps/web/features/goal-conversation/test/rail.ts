import { act } from 'react';

// The conversations panel as the events tests use it: the rail beside the conversation (the phone's
// sheet holds the same list), its rows by name, and the ways to open one.

/** The one element `selector` names under `root`. */
function find(root: Element, selector: string): HTMLElement {
  const found = root.querySelectorAll<HTMLElement>(selector);
  if (found.length !== 1) throw new Error(`expected one ${selector}, found ${found.length}`);
  return found[0] as HTMLElement;
}
const click = (el: Element) =>
  act(async () => {
    (el as HTMLElement).click();
  });

export const rail = (host: HTMLElement) => find(host, 'aside[data-ui="conversations"]');

const rows = (host: HTMLElement) => [
  ...rail(host).querySelectorAll<HTMLElement>('[data-ui="conversation-row"]'),
];
const titleOf = (row: Element) =>
  row.querySelector('[data-ui="conversation-title"]')?.textContent ?? '';

/** The rows' names, in the panel's order: the one on screen first. */
export const titles = (host: HTMLElement) => rows(host).map(titleOf);

/** The name of the conversation on screen, as its row says it. */
export const current = (host: HTMLElement) => {
  const row = rows(host).find((one) => one.dataset.current !== undefined);
  return row ? titleOf(row) : null;
};

/** The row of a draft, by its chain and id, or of a row by its name. */
export const row = (host: HTMLElement, which: string | { chain: string; id: string }) => {
  const found = rows(host).find((one) =>
    typeof which === 'string'
      ? titleOf(one) === which
      : one.dataset.chain === which.chain && one.dataset.id === which.id,
  );
  if (!found) throw new Error(`no row ${JSON.stringify(which)} in ${JSON.stringify(titles(host))}`);
  return found;
};

/** "New conversation" in the rail. */
export const openNew = (host: HTMLElement) =>
  click(find(rail(host), '[data-ui="conversation-new"]'));

/** Opens a draft by its chain and id, or a row by its name. */
export const open = (host: HTMLElement, which: string | { chain: string; id: string }) =>
  click(find(row(host, which), '[data-ui="conversation-open"]'));
