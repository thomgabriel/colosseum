// The closed vaults page (/portfolio/closed), in English: the vaults the person closed (gate
// VAULT-CLOSE-REUSE), each with the way to open it again. A close is our server's note: the chain is
// not touched, and the vault stays at its address.

export const closed = {
  /** The page's name, in a tab and on the link at the foot of the overview. */
  label: 'Closed vaults',
  /** The page's title. */
  title: 'Closed vaults.',
  lead: 'The vaults you closed. Each stays at its address on its chain, empty, and is in none of your totals. Open one again to have it back in your portfolio.',
  /** Every chain read, and no vault closed. */
  empty: 'You haven’t closed a vault.',
  /** At the foot of the overview, with how many there are. */
  link: (n: number) => `Closed vaults (${n})`,
  caption: 'Your closed vaults',
  columns: { vault: 'Vault', chain: 'Chain', closed: 'Closed', action: 'Open again' },
  reopen: 'Reopen',
  reopening: 'Opening…',
  /** Said beside the row once it is open again, with the way to it. */
  reopened: 'Open again: it is back in your portfolio.',
  failed: 'I couldn’t open it again: our server didn’t answer. Try again.',
  back: 'Back to the overview',
};

export type Closed = typeof closed;
