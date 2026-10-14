'use client';
import type { ClosedVault } from '@colosseum/schemas';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { buttonClass } from '../../components/ui/button-class';
import { ChainBadge } from '../../components/ui/ChainBadge';
import { KIT_CELL, KIT_ROW, KitTable, KitTh } from '../../components/ui/KitTable';
import { Panel, PanelHead, Plate } from '../../components/ui/Panel';
import { LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { readClosedVaults, reopenVault } from '../portfolio/vault-lifetime';
import { vaultTitle } from '../portfolio/vault-name';
import { useApiFetch } from '../wallet/WalletProvider';
import type { SectionRead } from './api';
import { usePortfolioSection, useSectionRead } from './PortfolioProvider';
import { href } from './pages';
import { PageHead, Say, SectionGate, sampleLine } from './parts';
import { useWords } from './words';

// The closed vaults (/portfolio/closed, gate VAULT-CLOSE-REUSE): the vaults the person closed, newest
// close first, as GET /v1/portfolio/closed lists them, each with the way to open it again. The page
// is reached from the foot of the overview. Nothing here signs: a reopen is our server's note, and the
// vault is back in the person's portfolio, counted from then.

/** The person's closed vaults, as a read of the section. */
export const readClosed = async (
  apiFetch: Parameters<typeof readClosedVaults>[0],
): Promise<SectionRead<ClosedVault[]>> => {
  const read = await readClosedVaults(apiFetch);
  if (read.kind === 'read') return { kind: 'read', answer: read.vaults };
  return read.kind === 'signed-out' ? { kind: 'signed-out' } : { kind: 'unreachable' };
};

export function ClosedVaultsPage() {
  const w = useWords();
  const closed = useSectionRead<ClosedVault[]>('closed', readClosed);
  return (
    <div data-ui="portfolio-closed" className="flex flex-col gap-8">
      <PageHead title={w.closed.title} lead={w.closed.lead} />
      <SectionGate read={closed.reading}>{(vaults) => <ClosedList vaults={vaults} />}</SectionGate>
      <p>
        <Link href={href('overview')} className={buttonClass({ variant: 'link' })}>
          {w.closed.back}
        </Link>
      </p>
    </div>
  );
}

function ClosedList({ vaults }: { vaults: ClosedVault[] }) {
  const w = useWords();
  const t = useT();
  const words = w.closed;
  if (vaults.length === 0) return <Say sentence={words.empty} />;
  // Not live: said once in words on the panel, as the overview's board says it.
  const notLive = vaults.find((v) => v.provenance !== 'live');
  return (
    <Panel aria-labelledby="closed-vaults">
      <PanelHead
        id="closed-vaults"
        title={words.label}
        stats={[{ label: t.plan.kpiAssets, value: <span>{vaults.length}</span> }]}
        actions={notLive ? <Plate>{sampleLine(t.shell, notLive.provenance)}</Plate> : undefined}
      />
      <KitTable
        ui="closed-vaults"
        caption={words.caption}
        minWidth="min-w-[560px]"
        head={
          <>
            <KitTh>{words.columns.vault}</KitTh>
            <KitTh>{words.columns.chain}</KitTh>
            <KitTh>{words.columns.closed}</KitTh>
            <KitTh>
              <span className="sr-only">{words.columns.action}</span>
            </KitTh>
          </>
        }
      >
        {vaults.map((vault) => (
          <Row key={`${vault.chain}:${vault.address}`} vault={vault} />
        ))}
      </KitTable>
    </Panel>
  );
}

function Row({ vault }: { vault: ClosedVault }) {
  const w = useWords();
  const t = useT();
  const lang = useLang();
  const words = w.closed;
  const apiFetch = useApiFetch();
  const { again } = usePortfolioSection();
  const [state, setState] = useState<'closed' | 'busy' | 'open' | 'failed'>('closed');
  const title = vaultTitle(vault, t.portfolio.actions, vault.chainName);
  const reopen = async () => {
    setState('busy');
    const done = await reopenVault(apiFetch, vault);
    if (done.kind !== 'done') return setState('failed');
    setState('open');
    // the overview's plans and sums read it again, with this vault in them
    again();
  };
  return (
    <tr data-ui="closed-vault" data-state={state} className={KIT_ROW}>
      <th scope="row" className={`${KIT_CELL} text-left font-medium`}>
        {state === 'open' ? (
          <Link
            href={`/vaults/${encodeURIComponent(vault.chain)}/${encodeURIComponent(vault.address)}`}
            className="underline"
          >
            {title}
          </Link>
        ) : (
          title
        )}
      </th>
      <td className={KIT_CELL}>
        <ChainBadge chain={vault.chain} />
      </td>
      <td className={`${KIT_CELL} tabular-nums`}>
        {new Intl.DateTimeFormat(LOCALE[lang], { dateStyle: 'medium' }).format(
          new Date(vault.closedAt),
        )}
      </td>
      <td className={`${KIT_CELL} text-right`}>
        {state === 'open' ? (
          <span role="status" className="text-body-sm text-muted-foreground">
            {words.reopened}
          </span>
        ) : (
          <span className="inline-flex flex-col items-end gap-1">
            <Button
              variant="secondary"
              data-action="vault-reopen"
              busy={state === 'busy'}
              onClick={reopen}
            >
              {state === 'busy' ? words.reopening : words.reopen}
            </Button>
            {state === 'failed' && (
              <span role="alert" className="text-caption text-destructive">
                {words.failed}
              </span>
            )}
          </span>
        )}
      </td>
    </tr>
  );
}

/** At the foot of the overview: the way to the closed vaults, where there are any. */
export function ClosedLink() {
  const w = useWords();
  const closed = useSectionRead<ClosedVault[]>('closed', readClosed);
  const count = closed.reading.kind === 'read' ? closed.reading.answer.length : 0;
  if (count === 0) return null;
  return (
    <p data-ui="closed-vaults-link">
      <Link href={href('closed')} className={buttonClass({ variant: 'link' })}>
        {w.closed.link(count)}
      </Link>
    </p>
  );
}
