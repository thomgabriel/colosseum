'use client';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/Icon';

/**
 * The press that opens and closes a panel folded to its head (a vault's holdings while a draft has the
 * pane): in the head's actions, saying what it shows or hides, and which part it controls.
 */
export function FoldToggle({
  open,
  onToggle,
  controls,
  label,
}: {
  open: boolean;
  onToggle: () => void;
  /** The id of the part it opens. */
  controls: string;
  /** Its words: "Show" or "Hide", and what, for a screen reader. */
  label: { show: string; hide: string; what: string };
}) {
  return (
    <Button
      variant="secondary"
      size="dense"
      data-action="fold-toggle"
      aria-expanded={open}
      aria-controls={controls}
      aria-label={`${open ? label.hide : label.show} ${label.what}`}
      onClick={onToggle}
    >
      {open ? label.hide : label.show}
      <Icon
        name="ChevronDown"
        size={16}
        className={`transition-transform ${open ? 'rotate-180' : ''}`}
      />
    </Button>
  );
}
