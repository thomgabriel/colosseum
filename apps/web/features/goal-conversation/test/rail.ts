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

export const rail = (host: HTMLElement) => find(host, 'div[data-ui="conversations"]');

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

/**
 * The rail opened, as a person opens it to see the rows, where a draft beside the chat folded it to
 * its strip.
 */
export const unfold = async (host: HTMLElement) => {
  const toggle = find(rail(host), '[data-ui="conversations-toggle"]');
  if (toggle.getAttribute('aria-expanded') === 'false') await click(toggle);
};

/**
 * Opens a draft by its chain and id, or a row by its name, from the rail opened if it is folded; a
 * draft opened folds it again, and it is opened once more to read its rows.
 */
export const open = async (host: HTMLElement, which: string | { chain: string; id: string }) => {
  await unfold(host);
  await click(find(row(host, which), '[data-ui="conversation-open"]'));
  await unfold(host);
};
