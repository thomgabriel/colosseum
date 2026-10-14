'use client';
import { Hint } from '../../components/ui/Hint';

/**
 * Why a holding is there, in one short muted line of a table: cut to the column's width, the whole of
 * it one hover, focus or tap away (Hint, gate TOOLTIP-WORDS).
 */
export function WhyCell({ text }: { text: string }) {
  return (
    <span data-ui="row-why-text" className="inline-flex max-w-full text-muted-foreground">
      <Hint tip={text} label={text} triggerClassName="min-h-6 max-w-[11rem] truncate text-left">
        {text}
      </Hint>
    </span>
  );
}
