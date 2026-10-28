'use client';
import {
  type LeaderboardResponse,
  type LeaderboardRow,
  LeaderboardResponse as Schema,
} from '@colosseum/schemas';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { buttonClass } from '../../components/ui/button-class';
import { Card, CardEmpty } from '../../components/ui/Card';
import { cn } from '../../components/ui/cn';
import { type AgeWords, formatAge, sayAge } from '../../components/ui/format';
import { PAGE_TITLE } from '../../components/ui/heading';
import {
  KIT_ABOVE_LINK,
  KIT_CELL,
  KIT_NUMERIC,
  KIT_ROW,
  KIT_ROW_LINK,
  KitTable,
  KitTh,
} from '../../components/ui/KitTable';
import { Panel, PanelHead, Plate } from '../../components/ui/Panel';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import { SkeletonRows } from '../../components/ui/Skeleton';
import { ScreenWait } from '../../components/waits/ScreenWait';
import { type Lang, LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { API } from '../../lib/api';
import { formatBps, tokenName } from '../order/amounts';
import { AssetMark } from '../order/PlanView';
import { dollars } from '../portfolio/figures';
import { localTime } from '../portfolio-section/list-figures';
import { shortAddress } from '../shared/use-person';

// The leaderboard (/leaderboard): every open vault on the chain, ranked by what it made against what
// went into it, for everyone, signed in or not. The order and every figure are the API's
// (GET /v1/leaderboard); this page works nothing out but the words. A row opens the vault's own
// page, which anybody may read. The table is the portfolio overview's (KitTable in a Panel).

type Load =
  | { kind: 'loading' }
  | { kind: 'read'; answer: LeaderboardResponse; now: number }
  | { kind: 'unreachable' | 'unreadable' };

/** The answer, or why there is none. Public: no sign-in is sent. */
export async function readLeaderboard(): Promise<
  { kind: 'read'; answer: LeaderboardResponse } | { kind: 'unreachable' | 'unreadable' }
> {
  let res: Response;
  try {
    res = await fetch(`${API}/v1/leaderboard?chain=solana`, {
      headers: { accept: 'application/json' },
    });
  } catch {
    return { kind: 'unreachable' };
  }
  if (!res.ok) return { kind: 'unreachable' };
  const read = Schema.safeParse(await res.json().catch(() => null));
  return read.success ? { kind: 'read', answer: read.data } : { kind: 'unreadable' };
}

/** How long before `now` a snapshot was read, in the pin's units: "4 min ago", "3 days ago". */
export function readAgo(fetchedAt: string, now: number, words: AgeWords): string {
  const age = formatAge(Math.max(0, (now - Date.parse(fetchedAt)) / 1000));
  return age ? sayAge(age, words) : '—';
}

const UP = 'text-success';
const DOWN = 'text-destructive';
/** How many holdings a row names before it says how many more. */
const SHOWN = 3;

function signedDollars(lang: Lang, usd: string): string {
  const n = Number(usd);
  return `${n >= 0 ? '+' : '−'}${dollars(lang, String(Math.abs(n)))}`;
}

function signedShare(lang: Lang, share: number): string {
  return `${share >= 0 ? '+' : '−'}${new Intl.NumberFormat(LOCALE[lang], {
    style: 'percent',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(share))}`;
}

export function LeaderboardScreen() {
  const t = useT();
  const lang = useLang();
  const w = t.leaderboard;
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [round, setRound] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `round` reads the board again
  useEffect(() => {
    let mine = true;
    setLoad({ kind: 'loading' });
    readLeaderboard().then((read) => {
      // what "4 min ago" counts from: when the answer reached this page
      if (mine) setLoad(read.kind === 'read' ? { ...read, now: Date.now() } : read);
    });
    return () => {
      mine = false;
    };
  }, [round]);

  const chain = load.kind === 'read' ? load.answer.name : t.chain.names.solana;
  // the event window, where the server runs one: said in the reader's own time zone
  const since =
    load.kind === 'read' && load.answer.since ? localTime(lang, load.answer.since) : null;
  return (
    <div data-ui="leaderboard-screen" className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <h1 className={PAGE_TITLE}>{w.title}</h1>
        <p data-ui="leaderboard-lead" className="max-w-(--tf-measure-body) text-body-lg">
          {since ? w.leadSince(chain, since) : w.lead(chain)}
        </p>
        <p className="max-w-(--tf-measure-body) text-body-sm text-muted-foreground">{w.rule}</p>
      </header>
      {load.kind === 'loading' ? (
        <ScreenWait
          label={w.loading}
          skeleton={
            <div
              aria-hidden="true"
              data-ui="leaderboard-wait"
              className="rounded-xl border border-border"
            >
              <SkeletonRows rows={6} columns={6} />
            </div>
          }
        />
      ) : load.kind !== 'read' ? (
        <section data-ui="leaderboard-failure" className="flex flex-col items-start gap-4">
          <p className="max-w-(--tf-measure-body) text-body">{w.failure[load.kind]}</p>
          <Button variant="secondary" onClick={() => setRound((n) => n + 1)}>
            {w.failure.retry}
          </Button>
        </section>
      ) : load.answer.vaults.length === 0 ? (
        <Card>
          <CardEmpty
            sentence={since ? w.emptySince(since) : w.empty(load.answer.name)}
            action={
              since ? (
                <Link
                  href="/invest"
                  data-ui="leaderboard-make-first"
                  className={buttonClass({ variant: 'link' })}
                >
                  {w.makeFirst}
                </Link>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <Board answer={load.answer} now={load.now} />
      )}
    </div>
  );
}

function Board({ answer, now }: { answer: LeaderboardResponse; now: number }) {
  const t = useT();
  const w = t.leaderboard;
  const table = w.table;
  return (
    <Panel
      aria-labelledby="leaderboard-vaults"
      data-ui="leaderboard"
      data-provenance={answer.provenance}
    >
      <PanelHead
        id="leaderboard-vaults"
        title={w.heading}
        stats={[
          {
            label: w.vaults,
            ui: 'leaderboard-count',
            value: <span className="font-medium">{answer.vaults.length}</span>,
          },
        ]}
        actions={
          answer.provenance !== 'live' && (
            // the figures are not live: said once, in words, at the panel's top right (MOCK-QUIET)
            <Plate ui="sample-tag">
              {answer.provenance === 'sandbox' ? t.shell.testNetworkLine : t.shell.mockAnnounce}
            </Plate>
          )
        }
      />
      <KitTable
        ui="leaderboard-table"
        labelledBy="leaderboard-vaults"
        minWidth="min-w-[960px]"
        head={
          <>
            <KitTh>{table.rank}</KitTh>
            <KitTh>{table.vault}</KitTh>
            <KitTh>{table.owner}</KitTh>
            <KitTh>{table.holds}</KitTh>
            <KitTh numeric>{table.value}</KitTh>
            <KitTh numeric>{table.made}</KitTh>
            <KitTh>{table.read}</KitTh>
          </>
        }
      >
        {answer.vaults.map((row) => (
          <Row key={`${row.chain}:${row.address}`} row={row} now={now} />
        ))}
      </KitTable>
    </Panel>
  );
}

/**
 * What a vault is called here: by its address in short. The name its owner typed and its number among
 * their vaults are theirs alone (gate VAULT-NUMBER), and this page is everyone's.
 */
export const titleOf = (row: LeaderboardRow, w: ReturnType<typeof useT>['leaderboard']) =>
  w.unnamed(shortAddress(row.address));

function Row({ row, now }: { row: LeaderboardRow; now: number }) {
  const t = useT();
  const lang = useLang();
  const w = t.leaderboard;
  const title = titleOf(row, w);
  const pinned = `${KIT_ABOVE_LINK} ${KIT_NUMERIC}`;
  const shown = row.holdings.slice(0, SHOWN);
  const more = row.holdings.length - shown.length;
  const { pnl } = row;
  return (
    <tr
      data-ui="leaderboard-row"
      data-rank={row.rank}
      data-address={row.address}
      className={KIT_ROW}
    >
      <td
        data-ui="leaderboard-rank"
        className={cn(KIT_CELL, 'font-display font-semibold tabular-nums')}
      >
        {row.rank}
      </td>
      <td className={cn(KIT_CELL, 'min-w-[11rem] max-w-[18rem]')}>
        {/* The whole row opens the vault's own page, which anybody may read. */}
        <Link
          href={`/portfolio/vaults/${encodeURIComponent(row.chain)}/${encodeURIComponent(row.address)}`}
          data-ui="leaderboard-vault"
          aria-label={w.open(title)}
          className={`font-medium text-foreground [overflow-wrap:anywhere] ${KIT_ROW_LINK} focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring`}
        >
          {title}
        </Link>
        {row.follows && (
          <span data-ui="leaderboard-follows" className="block text-caption text-muted-foreground">
            {w.follows(row.follows.name)}
          </span>
        )}
      </td>
      <td
        data-ui="leaderboard-owner"
        className={cn(KIT_CELL, 'font-mono text-source whitespace-nowrap')}
      >
        {row.owner}
      </td>
      <td data-ui="leaderboard-holds" className={KIT_CELL}>
        {shown.length === 0 ? (
          '—'
        ) : (
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {shown.map((h) => (
              <span key={h.asset} className="inline-flex items-center gap-1.5 whitespace-nowrap">
                <AssetMark asset={h.asset} className="size-5" />
                <span className="font-mono text-source">
                  {tokenName(h.asset)} {formatBps(h.weightBps, LOCALE[lang])}
                </span>
              </span>
            ))}
            {more > 0 && <span className="text-caption text-muted-foreground">{w.more(more)}</span>}
          </span>
        )}
      </td>
      <td data-ui="leaderboard-value" className={cn(KIT_CELL, pinned)}>
        {row.value ? (
          <ProvenancePin
            value={dollars(lang, row.value.usd)}
            obs={row.value}
            what={w.value}
            labels={t.pin}
          />
        ) : (
          <span className="text-muted-foreground">{w.neverRead}</span>
        )}
      </td>
      <td data-ui="leaderboard-made" className={cn(KIT_CELL, pinned)}>
        {pnl ? (
          <>
            <ProvenancePin
              value={signedDollars(lang, pnl.usd)}
              obs={pnl}
              what={w.made}
              labels={t.pin}
              className={cn('font-medium', Number(pnl.usd) >= 0 ? UP : DOWN)}
            />
            {pnl.pct !== null && (
              <span
                data-ui="leaderboard-share"
                className={cn('block text-caption', pnl.pct >= 0 ? UP : DOWN)}
              >
                {signedShare(lang, pnl.pct)}
              </span>
            )}
            {pnl.unvaluedWithdrawals > 0 && (
              <span className="block text-caption text-muted-foreground">
                {w.unvalued(pnl.unvaluedWithdrawals)}
              </span>
            )}
          </>
        ) : (
          <span data-ui="leaderboard-no-figure" className="text-caption text-muted-foreground">
            {row.noPnl === 'never_read' ? w.neverRead : w.noDeposit}
          </span>
        )}
      </td>
      <td
        data-ui="leaderboard-read"
        className={cn(KIT_CELL, 'text-caption whitespace-nowrap text-muted-foreground')}
      >
        {row.value ? (
          // how long ago, with the instant itself on hover
          <time dateTime={row.value.fetchedAt} title={localTime(lang, row.value.fetchedAt)}>
            {readAgo(row.value.fetchedAt, now, w.ago)}
          </time>
        ) : (
          '—'
        )}
      </td>
    </tr>
  );
}
