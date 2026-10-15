// The side menu of Bearing's analytics (Rodrigo's Analytics 2.0), and Invest's conversations rail
// drawn as it (Thom, Oct 15): one menu, so its parts are written once. A bordered button heads it
// (Hide menu, with its three lines); a row is a short mark in a column of its own, then its label; the
// row on screen has the brand's bar on its left edge over a muted fill. Text at 13px.

/** The menu's text: the analytics' own size. */
export const MENU_TEXT = 'text-[0.8125rem]/5';

/** Its bordered button: "Hide menu"; "Hide conversations" and "New conversation" in the conversations. */
export const MENU_BUTTON =
  'flex min-h-9 cursor-pointer items-center gap-2.5 rounded-md border border-input px-2.5 py-1.5 text-left font-medium hover:border-primary';

/** A search in the menu, drawn as its button: the same box, its icon where the button has its own. */
export const MENU_FIELD =
  'block min-h-9 w-full rounded-md border border-input bg-transparent py-1.5 pr-2.5 pl-[37px] text-foreground placeholder:text-muted-foreground hover:border-primary';

/** A row: its bar's room on the left edge, the honey bar and the fill on the one on screen. */
export const MENU_ROW =
  'flex min-h-9 items-center gap-2.5 rounded-r-md border-l-2 border-transparent px-2.5 py-1.5 text-foreground no-underline hover:bg-muted aria-[current=page]:border-primary aria-[current=page]:bg-muted aria-[current=page]:font-semibold aria-[current=true]:border-primary aria-[current=true]:bg-muted aria-[current=true]:font-semibold';

/** The column of a row's mark: a short code in mono, or a chain's mark. */
export const MENU_MARK = 'w-6 shrink-0 pl-1 font-mono text-caption';
