// Which colour each holding takes in <Composition> (Composition.tsx), apart from React so it can be
// tested alone.

/** The categorical colours, in their fixed order (identity/share-palette.md). Past these, `rest`. */
export const SLOTS = 6;

/** A holding's colour: `share-1` … `share-6` in the order the holdings come, `share-rest` after, cash its own. */
export type ShareColour = `share-${1 | 2 | 3 | 4 | 5 | 6}` | 'share-rest' | 'share-cash';

/**
 * The colour of each holding, by its place among the holdings that are not cash, in the order the
 * caller gives them. A colour follows the holding, never its size, so the same holding keeps its colour
 * in both bars of a comparison and while the shares change.
 */
export function coloursOf(items: readonly { cash?: boolean }[]): ShareColour[] {
  let next = 0;
  return items.map((item) => {
    if (item.cash) return 'share-cash';
    next += 1;
    return next <= SLOTS ? (`share-${next}` as ShareColour) : 'share-rest';
  });
}

export const colourVar = (colour: ShareColour) => `var(--tf-${colour})`;
