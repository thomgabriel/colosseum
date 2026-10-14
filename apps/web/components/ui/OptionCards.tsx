import { type ReactNode, useId } from 'react';
import { cn } from './cn';

// The house kit's choice between a few ways (STYLE.md, "The house kit"): each way a bordered tile with
// its title and one muted line under it, the chosen one on the accent tint, as the chain choice on
// /goal draws its two chains. A way that cannot be taken here is shown, dimmed, and its line says why.
// With no `onChange` the tiles are a plain list: the ways named, where none can be chosen yet (signed
// out, a portfolio that cannot be followed).

export type OptionCard<V extends string> = {
  value: V;
  title: string;
  /** One line under the title: what the way does, or why it cannot be taken here. */
  line: ReactNode;
  disabled?: boolean;
};

const TILE = 'flex min-w-0 items-start gap-3 rounded-md border border-input px-3 py-2.5';

export function OptionCards<V extends string>({
  legend,
  options,
  value = null,
  onChange,
  locked = false,
  ui,
  className,
}: {
  /** The group's name for a screen reader; it is not drawn. */
  legend: string;
  options: readonly OptionCard<V>[];
  value?: V | null;
  /** Left out: the tiles are a list, nothing to choose. */
  onChange?: (value: V) => void;
  /** A choice under way (a deposit being signed): only the chosen way stays as it is. */
  locked?: boolean;
  ui?: string;
  className?: string;
}) {
  const name = useId();
  const words = (option: OptionCard<V>) => (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="text-body-sm font-medium">{option.title}</span>
      <span className="text-caption text-muted-foreground">{option.line}</span>
    </span>
  );
  if (!onChange)
    return (
      <ul aria-label={legend} data-ui={ui} className={cn('flex min-w-0 flex-col gap-2', className)}>
        {options.map((option) => (
          <li key={option.value} data-option={option.value} className={TILE}>
            {words(option)}
          </li>
        ))}
      </ul>
    );
  return (
    <fieldset data-ui={ui} className={cn('flex min-w-0 flex-col gap-2', className)}>
      <legend className="sr-only">{legend}</legend>
      {options.map((option) => (
        <label
          key={option.value}
          data-option={option.value}
          className={cn(
            TILE,
            'cursor-pointer hover:bg-muted',
            'has-checked:border-transparent has-checked:bg-accent has-checked:hover:bg-accent',
            'has-disabled:cursor-not-allowed has-disabled:hover:bg-transparent has-disabled:has-checked:hover:bg-accent',
            'has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring',
          )}
        >
          <input
            type="radio"
            name={name}
            value={option.value}
            className="mt-0.5 size-4 shrink-0 accent-primary"
            checked={value === option.value}
            disabled={option.disabled || (locked && value !== option.value)}
            onChange={() => {
              if (!locked) onChange(option.value);
            }}
          />
          {words(option)}
        </label>
      ))}
    </fieldset>
  );
}
