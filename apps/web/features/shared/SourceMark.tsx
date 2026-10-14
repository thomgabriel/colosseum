'use client';
import type { ChainId } from '@colosseum/schemas';
import { StatusMark } from '../../components/ui/StatusMark';
import { useT } from '../../i18n/I18nProvider';
import type { ChainCheck } from './chain-recipe';
import type { TermsSource } from './terms';

// What a person needs to know of where a portfolio's version and weights come from, and no more
// (Thom, Oct 14: the page does not say where a figure was read from). A read that matches says
// nothing. One that could not be made says once that it was not checked against the chain, as a
// word and a shape (STYLE.md rule 6). A difference, or a read that failed, is said as an alarm.

export function SourceMark({
  source,
  check,
  chain,
}: {
  source?: TermsSource;
  check?: ChainCheck;
  chain: ChainId;
}) {
  const t = useT();
  const c = t.shared.check;
  const name = t.chain.names[chain];
  if (check?.state === 'reading') return null;
  const read = check ? check.state === 'read' : source === 'chain';
  // A read that failed where it could be made is an alarm, as a difference is.
  const alarm =
    check?.state === 'read'
      ? check.differs
        ? c.differs(name)
        : null
      : check?.state === 'failed'
        ? c.failed(name)
        : check?.state === 'missing'
          ? c.missing(name)
          : null;
  if (read && !alarm) return null;
  return (
    <p
      data-ui="source-mark"
      data-source={read ? 'chain' : 'api'}
      className={
        alarm
          ? 'flex max-w-(--tf-measure-body) items-start gap-1.5 text-body-sm text-destructive'
          : 'flex max-w-(--tf-measure-body) items-start gap-1.5 text-body-sm'
      }
    >
      <StatusMark status={alarm ? 'off-track' : 'watch'} className="mt-1.5" />
      <span>{alarm ?? `${c.notChecked}.`}</span>
    </p>
  );
}
