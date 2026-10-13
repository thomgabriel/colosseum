import { cn } from '../cn';

// The parts of the sample mark, for the primitives only (gate MOCK-QUIET, Thom, Oct 6, in place of
// the boxed word MOCK beside every figure). A sample card says so once, in a quiet tag in its
// top-right corner (Thom, Oct 13, in place of its hatched edge); a sample figure keeps a small hatched
// glyph with a name for screen readers. A screen never imports this file: it uses a whole thing
// (`MockPlate`, `MockFrame`, a mocked card, row, leg or figure), each of which draws its mark itself.
// hatch.test.ts fails on an import of this file from outside components/ui, and on a hatch with
// nothing that says it is sample.

/** The words of a sample card's tag or a sample panel's line, when a screen hands none. */
export const SAMPLE_LINE = 'Sample figures';
/** A sample glyph's name for a screen reader, when a screen hands none. */
export const SAMPLE_FIGURE = 'sample figure';
/** Kept for the screens that still hand it: the card's line. */
export const MOCK_ANNOUNCE = SAMPLE_LINE;

/** The 6px band of hatch: the left edge of a mocked row or leg label, and of a stale plate. */
export function HatchBand({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-ui="hatch-band"
      className={cn('tf-hatch block w-1.5 shrink-0 self-stretch rounded-l-[inherit]', className)}
    />
  );
}

export type MockWordProps = {
  /** Gives the glyph its name for screen readers. Once per panel: false on a second glyph in it. */
  announce?: boolean;
  /** That name, when it is not the default ("sample figure"). */
  sentence?: string;
  className?: string;
};

/**
 * The small hatched square that marks a sample figure, row or leg: no word on the page, a name for a
 * screen reader. It replaces the boxed word MOCK (MOCK-QUIET).
 */
export function MockWord({ announce = true, sentence, className }: MockWordProps) {
  return (
    <span
      data-ui="sample-glyph"
      {...(announce
        ? { role: 'img', 'aria-label': sentence ?? SAMPLE_FIGURE }
        : { 'aria-hidden': true })}
      className={cn(
        'tf-hatch inline-block size-2.5 shrink-0 border border-border align-middle',
        className,
      )}
    />
  );
}

/** A sample panel's one quiet line (the embed, a mock frame): "Sample figures · test network". */
export function SampleNote({
  line,
  note,
  className,
}: {
  line?: string;
  /** After the line: "test network". */
  note?: string;
  className?: string;
}) {
  return (
    <p data-ui="sample-note" className={cn('text-sample-line text-sample-foreground', className)}>
      {line ?? SAMPLE_LINE}
      {note ? ` · ${note}` : ''}
    </p>
  );
}

/**
 * A sample card's one tag, in its top-right corner: "Sample figures" or "Test network" (MOCK-QUIET,
 * Thom, Oct 13). Drawn as the portfolio overview's own plate for figures that are not live
 * (`board-plate` in OverviewPage.tsx), the house style. Its words are its screen-reader name.
 */
export function SampleTag({ label, className }: { label?: string; className?: string }) {
  return (
    <span
      data-ui="sample-tag"
      className={cn(
        'inline-flex shrink-0 items-center rounded-full border border-primary/60 bg-honey-tint px-2.5 py-0.5 font-sans text-caption font-medium whitespace-nowrap text-foreground',
        className,
      )}
    >
      {label ?? SAMPLE_LINE}
    </span>
  );
}
