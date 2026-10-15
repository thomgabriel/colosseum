import type { ReactNode } from 'react';
import { dictionary, type Lang } from '../../i18n';
import { Disclaimer } from '../ui/Disclaimer';
import { AppNav } from './AppNav';
import { RouterLinks } from './RouterLinks';

// The one frame of the product's routes: the bar, the page, and the foot. The bar is his compact bar,
// fixed at the top (AppNav), with the way past it for a keyboard as its first link; the page starts
// below it. Every product page has the same frame (gate PAGE-SHELL, Thom, Oct 14): the portfolio
// overview's width (`max-w-shell`, 1600px) and its side gutter, so the left edge and the title sit in
// the same place on every route, at every width. A workbench (Invest, an owner's vault) fills the
// window's height in the same frame, and its panes scroll, not the page. The disclaimer is in the foot
// of every product screen, from the one DISCLAIMER constant, at body size, in the language of the
// view: the foot is where it stands while a screen has no plan to sit under. A screen that carries its
// own under its plan or its vaults (disclaimer-block.md) has it once: the foot's is then not drawn, by a
// rule of the stylesheet, so nothing about it waits for a script.

/** The side gutter of every product page: the portfolio overview's. */
export const SHELL_GUTTER = 'px-[clamp(12px,2vw,28px)]';

export type AppShellProps = { lang: Lang; children: ReactNode };

export function AppShell({ lang, children }: AppShellProps) {
  const t = dictionary(lang).shell;
  return (
    <div
      data-ui="app-shell"
      className={`group/shell mx-auto flex min-h-dvh w-full max-w-shell flex-col ${SHELL_GUTTER} md:has-[[data-workbench]]:h-dvh md:has-[[data-workbench]]:min-h-0 md:has-[[data-workbench]]:overflow-hidden`}
    >
      <AppNav />
      <RouterLinks />
      <main
        id="content"
        tabIndex={-1}
        className="flex-1 scroll-mt-24 pt-[calc(env(safe-area-inset-top,0px)+104px)] pb-10 outline-none md:group-has-[[data-workbench]]/shell:flex md:group-has-[[data-workbench]]/shell:min-h-0 md:group-has-[[data-workbench]]/shell:flex-col md:group-has-[[data-workbench]]/shell:pb-0"
      >
        {children}
      </main>
      {/* On a workbench (invest, an owner's vault) the foot is a small blank strip. */}
      <footer
        data-ui="app-foot"
        className="flex flex-col gap-6 border-t border-border py-8 md:group-has-[[data-workbench]]/shell:h-6 md:group-has-[[data-workbench]]/shell:shrink-0 md:group-has-[[data-workbench]]/shell:border-t-0 md:group-has-[[data-workbench]]/shell:py-0 md:group-has-[[data-workbench]]/shell:*:hidden"
      >
        <Disclaimer
          lang={lang}
          heading={dictionary(lang).activity.notAdvice}
          label={t.disclaimer}
          className="group-has-[main_[data-ui=disclaimer]]/shell:hidden"
        />
      </footer>
    </div>
  );
}
