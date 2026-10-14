'use client';
import { Hint } from '../../components/ui/Hint';

/**
 * Why a holding is there, in at most two short muted lines of a table, cut after them; the whole of it
 * one hover, focus or tap away (Hint, gate TOOLTIP-WORDS). The cap is on the wrapper: the trigger's own
 * `max-w-full` would win over a width given to it, and the column would take the whole sentence.
 */
export function WhyCell({ text }: { text: string }) {
  return (
    <span data-ui="row-why-text" className="inline-flex max-w-[15rem] text-muted-foreground">
      <Hint tip={text} label={text} triggerClassName="min-h-6 line-clamp-2 text-left">
        {text}
      </Hint>
    </span>
  );
}
