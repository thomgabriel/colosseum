// The page title, one register on every product page (gate PAGE-SHELL, Thom, Oct 14): Inter Tight 600
// at the third heading's size, as a panel of the portfolio overview is titled, not a hero's. A page's
// gated states (signed out, not found, another chain) and its loaded state title it the same way, so
// the heading does not change face or size when the page's data comes or does not. The workbenches
// (Invest, an owner's vault) and Bearing's analytics use it too; only the landing has its own.
export const PAGE_TITLE =
  'max-w-(--tf-measure-body) font-display text-h3 font-semibold tracking-[-0.01em]';

/**
 * The way back over a page's title (gate PAGE-SHELL): one line 20px tall, 12px over the title, so a
 * title under one sits at the same height on every page that has one.
 */
export const PAGE_BACK = 'inline-flex h-5 items-center self-start text-body-sm';
