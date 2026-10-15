'use client';
import type { ChainId, Target } from '@colosseum/schemas';
import { useEffect, useState } from 'react';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import { StatusMark } from '../../components/ui/StatusMark';
import { LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { formatBps, tokenName } from '../order/amounts';
import { useApiFetch } from '../wallet/WalletProvider';
import { type ChainRules, overCeiling } from './over-ceiling';
import { readLimits } from './shared-api';

// A shared portfolio's weight over its asset's ceiling on the chain's list, said to whoever deposits
// into it or follows it, before they do (gate SHARED-RULES-V2): under the second rules the registry
// publishes such a weight, and the follower is the one who pays to sell that much of it. The ceiling is
// the chain's, read for this page, with its pin. Under the first rules no such weight is published, and
// nothing is said; while the rules are unread, or unreadable, nothing is said either.

export function OverCapNote({
  chain,
  targets,
}: {
  chain: ChainId;
  /** The version's weights as the page read them. Null: not read yet. */
  targets: readonly Target[] | null;
}) {
  const t = useT();
  const lang = useLang();
  const apiFetch = useApiFetch();
  const [rules, setRules] = useState<{ chain: ChainId; read: ChainRules } | null>(null);
  useEffect(() => {
    let current = true;
    readLimits(apiFetch, chain).then((read) => {
      if (current && read.kind === 'read' && read.value.chain === chain)
        setRules({ chain, read: read.value });
    });
    return () => {
      current = false;
    };
  }, [apiFetch, chain]);
  if (!targets || rules?.chain !== chain || rules.read.limits.rules !== 2) return null;
  const over = overCeiling(
    targets.map((x) => ({ asset: x.asset, bps: x.weightBps })),
    rules.read,
  );
  if (!over.length) return null;
  const pct = (bps: number) => formatBps(bps, LOCALE[lang]);
  return (
    <ul data-ui="over-cap-note" className="flex flex-col gap-1 text-body-sm">
      {over.map((o) => (
        <li key={o.asset} className="flex items-start gap-1.5">
          <StatusMark status="watch" size={12} className="mt-1.5" />
          <span>
            {t.shared.family.overCap(tokenName(o.asset), pct(o.bps), pct(o.ceilingBps))}{' '}
            <ProvenancePin
              value={pct(o.ceilingBps)}
              obs={rules.read.ceilingsFrom}
              what={t.shared.publish.rules.capOnList}
              labels={t.pin}
            />
          </span>
        </li>
      ))}
    </ul>
  );
}
