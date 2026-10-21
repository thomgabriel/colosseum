import { describe, expect, it } from 'vitest';
import { PAGE_TITLE } from './heading';
import { read, sourceFiles } from './test/css';

// One register for a page's title on every product page (gate PAGE-SHELL, Thom, Oct 14): `PAGE_TITLE`
// (Inter Tight 600, IDENTITY-2; no serif), in its gated states as in its loaded one, on the workbenches
// and on Bearing's analytics too. The landing's hero is its own, and so is the sans heading over goal
// cards, whose sentences are the display face there (goal-card.md): the monitor's, which switches on
// its `vaults.length`.

const OWN = new Set(['features/landing/Landing.tsx', 'features/wallet/dev/DevWallet.tsx']);

/** Every <h1 …> in a file whose class is not the page title's. */
export function otherTitles(text: string): string[] {
  return [...text.matchAll(/<h1\b[^>]*>/gs)]
    .map((m) => m[0])
    .filter(
      (tag) => !/className=\{(`\$\{|cn\()?PAGE_TITLE[`},]/.test(tag) && !/vaults\.length/.test(tag),
    );
}

describe('a page’s title', () => {
  it('is the h1 of PAGE_TITLE on every product page, gated or loaded, workbench or not', () => {
    const files = [...sourceFiles()].filter(
      (f) => /^features\/.+\.tsx$/.test(f) && !f.includes('.test.') && !OWN.has(f),
    );
    const found = files.flatMap((f) => otherTitles(read(f)).map((tag) => `${f}: ${tag}`));
    expect(found).toEqual([]);
    expect(PAGE_TITLE.split(' ')).toEqual(
      expect.arrayContaining(['font-display', 'text-h3', 'font-semibold']),
    );
    expect(PAGE_TITLE.split(' ')).not.toEqual(expect.arrayContaining(['font-normal', 'text-h1']));
  });

  it('bites: a title in another register is found, wherever it is', () => {
    expect(otherTitles('<h1 className="font-sans text-h2 font-semibold">x</h1>')).toHaveLength(1);
    expect(otherTitles('<h1 className="text-body-lg font-semibold">Invest</h1>')).toHaveLength(1);
    expect(otherTitles('<h1 className={PAGE_TITLE_BIG}>x</h1>')).toHaveLength(1);
    expect(otherTitles('<h1 id={a} className={PAGE_TITLE}>x</h1>')).toHaveLength(0);
    expect(otherTitles("<h1 className={cn(PAGE_TITLE, 'mt-2')}>x</h1>")).toHaveLength(0);
    expect(otherTitles('<h1 className={`${PAGE_TITLE} sr-only`}>x</h1>')).toHaveLength(0);
  });
});
