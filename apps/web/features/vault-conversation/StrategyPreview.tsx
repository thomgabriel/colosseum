'use client';
import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Card, CardBody } from '../../components/ui/Card';
import { cn } from '../../components/ui/cn';
import { Disclaimer } from '../../components/ui/Disclaimer';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import { StatusMark } from '../../components/ui/StatusMark';
import { WaitMark } from '../../components/ui/WaitMark';
import { type Lang, LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { displayName, isCashId } from '../order/plain';
import { dollars } from '../portfolio/figures';
import { Composition, withVenue } from '../shared/Composition';
import { type ReplyFigures, referencesIn, type VaultStrategyPreview } from './agent';
import { FiguredText } from './Figures';
import { ProjectionChart } from './ProjectionChart';

export function sourceValue(lang: Lang, value: number | null | undefined, unit?: string): string {
  if (value == null) return '—';
  if (unit === 'USD') return dollars(lang, String(value));
  if (unit === 'fraction' || unit === 'bps' || unit === 'percent' || unit === '%') {
    return new Intl.NumberFormat(LOCALE[lang], {
      style: 'percent',
      maximumFractionDigits: 2,
    }).format(unit === 'fraction' ? value : unit === 'bps' ? value / 10000 : value / 100);
  }
  return `${new Intl.NumberFormat(LOCALE[lang], { maximumFractionDigits: 6 }).format(value)}${unit ? ` ${unit}` : ''}`;
}

/**
 * A sourced visual preview; this component has no order, signing or execution capability.
 *
 * The draft is drawn as a ring beside a row for every holding with its exact share and why
 * (Composition.tsx); a change to a vault's targets as the targets now over the proposed ones. Every
 * figure on the card is the proposal's own from the first frame: nothing counts up to it.
 */
export function StrategyPreview({
  proposal,
  figures,
  now = null,
  targets,
  previewOnly,
  wait,
  pending: waiting = false,
  onDiscuss,
  use,
  tradeoffsShown = false,
}: {
  proposal: VaultStrategyPreview;
  /** The host shows the tradeoffs elsewhere (under the reply on /invest): not again in the reasons. */
  tradeoffsShown?: boolean;
  /**
   * The proposal's prose with the figures it states in their places (FIGURES-BY-REFERENCE): each is
   * then drawn with its pin instead of read from the plain words. `now` is the reader's clock.
   */
  figures?: ReplyFigures;
  now?: number | null;
  targets?: { asset: string; targetBps: number }[];
  previewOnly?: string;
  /**
   * For a host that keeps the draft on the card while the next reply is on its way: what the card
   * says then. `banner` leads the card ("Reading your message. Below is the draft from before."),
   * and `action` stands in the action's place beside the loader ("Waiting for the reply…"). Given
   * always, so their places are kept and nothing moves when the wait starts or ends.
   */
  wait?: { banner: string; action: string };
  /**
   * A reply is on its way and this is the draft before it. The draft stays, set back as a whole (grey
   * ink, never faded text: it still reads at 4.5:1), so the next one can show what changed.
   */
  pending?: boolean;
  onDiscuss?: () => void;
  /**
   * The one action this preview leads to: a deposit for a new goal, which is the card's primary
   * button, or applying it to the vault.
   */
  use?: { label: string; onUse: () => void; primary?: boolean };
}) {
  const pending = waiting && wait !== undefined;
  // A field of the proposal: its figures drawn where the reply states any, else its plain words.
  const placed = figures?.prose.proposal;
  const said = (plain: string, template: string | undefined) =>
    figures && template !== undefined && referencesIn(template).length > 0 ? (
      <FiguredText template={template} facts={figures.facts} now={now} />
    ) : (
      plain
    );
  const t = useT();
  const copy = t.shared.vault.conversation;
  const language = useLang();
  // The mix, or the monthly evolution when the server projected one from sourced yields.
  const [view, setView] = useState<'mix' | 'monthly'>('mix');
  const monthly = proposal.projection;
  const showing = monthly ? view : 'mix';
  const rows = [
    ...proposal.allocations.map((line, piece) => ({
      asset: line.assetId,
      piece: piece as number | null,
      symbol: line.symbol,
      proposed: line.weightBps,
      current: targets?.find((row) => row.asset === line.assetId)?.targetBps ?? 0,
      why: line.why,
    })),
    ...(targets ?? [])
      .filter((row) => !proposal.allocations.some((line) => line.assetId === row.asset))
      .map((row) => ({
        asset: row.asset,
        piece: null,
        symbol: undefined,
        proposed: 0,
        current: row.targetBps,
        why: copy.removed,
      })),
  ];
  const allocationShare = (bps: number) => sourceValue(language, bps / 10000, 'fraction');
  const m = t.mix.preview;
  const nameOf = (asset: string) =>
    proposal.allocations.find((line) => line.assetId === asset)?.symbol ??
    displayName(asset, t.plan);
  // a change of targets in percentage points: "+2 pp", never "+2%", which reads as a relative change
  const change = (bps: number) =>
    `${new Intl.NumberFormat(LOCALE[language], { maximumFractionDigits: 2, signDisplay: 'exceptZero' }).format(bps / 100).replace('-', '−')} ${copy.points}`;
  return (
    <>
      <Card
        as="section"
        aria-label={copy.proposed}
        mock={proposal.sources.some((source) => source.provenance !== 'live')}
        mockLabels={{
          announce: proposal.sources.some((source) => source.provenance === 'mock')
            ? t.shell.mockAnnounce
            : t.shell.testNetworkLine,
        }}
      >
        <CardBody className="flex min-w-0 flex-col gap-4">
          {/* One place for two lines, as tall as the taller: the note on the draft, or the banner that
              says a reply is on its way and this is the draft from before. Nothing under it moves. */}
          <div className="grid">
            <p
              aria-hidden={pending ? true : undefined}
              className={cn(
                'col-start-1 row-start-1 self-center text-caption text-muted-foreground',
                pending && 'invisible',
              )}
            >
              {previewOnly ?? copy.previewOnly}
            </p>
            {wait && !pending && (
              // the banner's size, kept while there is none
              <p
                aria-hidden="true"
                className="invisible col-start-1 row-start-1 flex items-center gap-3 px-3 py-2 text-body-sm font-medium"
              >
                <span className="size-5 shrink-0" />
                {wait.banner}
              </p>
            )}
            {/* not a live region: the conversation announces the wait, once (ReplyAnnouncer) */}
            <p
              data-ui="preview-pending"
              className={cn(
                'col-start-1 row-start-1 flex items-center gap-3 self-center rounded-md text-body-sm font-medium',
                pending ? 'bg-honey-tint px-3 py-2' : 'invisible',
              )}
            >
              {pending && (
                <>
                  <WaitMark size={20} tone="current" />
                  {wait?.banner}
                </>
              )}
            </p>
          </div>
          {/* The draft from before, set back as a whole while a reply is on its way: its ink goes
              grey. Nothing is dimmed: the picture keeps its colours and every word and figure stays
              readable. */}
          <div
            data-ui="preview-draft"
            data-set-back={pending ? true : undefined}
            className={cn(
              'flex min-w-0 flex-col gap-4 motion-safe:transition-colors motion-safe:duration-(--tf-dur-fade)',
              pending && 'text-muted-foreground',
            )}
          >
            <p className="text-body font-medium [overflow-wrap:anywhere]">
              {said(proposal.objective, placed?.objective)}
            </p>
            <p className="text-body-sm [overflow-wrap:anywhere]">
              {said(proposal.summary, placed?.summary)}
            </p>
            {monthly && (
              <fieldset
                aria-label={copy.view.label}
                data-ui="preview-view"
                className="m-0 flex min-w-0 gap-1 self-start rounded-full border border-border p-0.5"
              >
                {(['mix', 'monthly'] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    aria-pressed={showing === v}
                    onClick={() => setView(v)}
                    className={cn(
                      'rounded-full px-3 py-1 text-caption font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                      showing === v
                        ? 'bg-honey-tint text-foreground'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {copy.view[v]}
                  </button>
                ))}
              </fieldset>
            )}
            {showing === 'monthly' && monthly && (
              <ProjectionChart
                projection={monthly}
                lang={language}
                sample={monthly.sourceIds.some(
                  (id) =>
                    proposal.sources.find((source) => source.id === id)?.provenance !== 'live',
                )}
              />
            )}
            {/* The draft as a strip and its rows; a change to a vault's targets as its current
                targets over the proposed ones, never as what it holds (Composition.tsx, gate
                WEIGHTS-RING). */}
            <Composition
              mode={targets ? 'compare' : 'single'}
              share={allocationShare}
              signed={change}
              labels={{
                caption: targets ? copy.comparison : copy.proposed,
                weight: copy.proposedShare,
                before: copy.currentTarget,
                after: t.shared.composition.proposed,
                change: copy.change,
              }}
              items={rows.map((row) => ({
                key: row.asset,
                ...(row.symbol ? { name: row.symbol } : withVenue(displayName(row.asset, t.plan))),
                asset: row.asset,
                cash: isCashId(row.asset),
                bps: row.proposed,
                ...(targets ? { beforeBps: row.current } : {}),
                detail: (
                  <span
                    data-part="why"
                    className="block text-caption text-muted-foreground [overflow-wrap:anywhere]"
                  >
                    {said(row.why, placed?.why[row.asset])}
                  </span>
                ),
              }))}
            />
            <WeightNotes notes={proposal.weightNotes} allocations={proposal.allocations} />
            {proposal.warnings.length > 0 && (
              <div data-ui="mix-warnings" className="flex flex-col gap-2">
                <h3 className="text-caption font-medium">{m.warnings}</h3>
                {proposal.warnings.map((warning) => {
                  const figure = proposal.sources.find(
                    (source) => source.id === warning.evidenceId,
                  );
                  return (
                    <p
                      key={`${warning.code}:${warning.assetId}`}
                      data-warning={warning.code}
                      className="flex max-w-(--tf-measure-body) items-start gap-1.5 text-body-sm"
                    >
                      <StatusMark status="watch" className="mt-1.5" />
                      <span className="[overflow-wrap:anywhere]">
                        {warning.code === 'over_exit_capacity'
                          ? m.warning.overExit(nameOf(warning.assetId))
                          : m.warning.outsideGoal(nameOf(warning.assetId))}
                        {warning.code === 'over_exit_capacity' && figure?.value != null && (
                          <>
                            {' '}
                            <ProvenancePin
                              value={`${figure.label ?? ''}: ${sourceValue(language, figure.value, figure.unit)}`}
                              obs={figure}
                              labels={t.pin}
                            />
                          </>
                        )}
                      </span>
                    </p>
                  );
                })}
              </div>
            )}
          </div>
          {(onDiscuss || use) && (
            <div className="flex flex-wrap gap-3">
              {use && (
                <Button
                  variant={use.primary ? 'primary' : 'secondary'}
                  size={use.primary ? 'default' : 'dense'}
                  data-action={use.primary ? 'deposit' : 'use-mix'}
                  // while a reply is on its way the action waits, and says so beside the loader
                  {...(wait ? { busy: pending, busyLabel: wait.action, busyMark: true } : {})}
                  onClick={use.onUse}
                >
                  {use.label}
                </Button>
              )}
              {onDiscuss && (
                <Button variant="secondary" size="dense" onClick={onDiscuss}>
                  {copy.discuss}
                </Button>
              )}
            </div>
          )}
          <details>
            <summary className="cursor-pointer text-body-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
              {copy.reasons}
            </summary>
            <div className="flex flex-col gap-3 pt-3">
              {proposal.tradeoffs.length > 0 && !tradeoffsShown && (
                <div>
                  <h3 className="text-caption font-medium">{copy.tradeoffs}</h3>
                  <ul className="list-inside list-disc text-body-sm">
                    {proposal.tradeoffs.map((word, at) => (
                      <li key={word} className="[overflow-wrap:anywhere]">
                        {said(word, placed?.tradeoffs[at])}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {proposal.unknowns.length > 0 && (
                <div>
                  <h3 className="text-caption font-medium">{copy.unknowns}</h3>
                  <ul className="list-inside list-disc text-body-sm">
                    {proposal.unknowns.map((word, at) => (
                      <li key={word} className="[overflow-wrap:anywhere]">
                        {said(word, placed?.unknowns[at])}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <h3 className="text-caption font-medium">{copy.sources}</h3>
              {proposal.sources.map((source) => (
                <div key={source.id} className="min-w-0 text-caption [overflow-wrap:anywhere]">
                  <ProvenancePin
                    value={
                      source.label
                        ? `${source.label}: ${sourceValue(language, source.value, source.unit)}`
                        : source.id
                    }
                    obs={source}
                    labels={t.pin}
                  />
                </div>
              ))}
            </div>
          </details>
        </CardBody>
      </Card>
      <Disclaimer lang={language} label={t.shell.disclaimer} />
    </>
  );
}

/**
 * What the server did with the weights, in words: the code, the served picks and the person's own
 * quote. Also stands alone under a reply with no proposal, where a share was not applied.
 */
export function WeightNotes({
  notes,
  allocations = [],
}: {
  notes: readonly VaultStrategyPreview['weightNotes'][number][];
  allocations?: VaultStrategyPreview['allocations'];
}) {
  const t = useT();
  const language = useLang();
  const m = t.mix.preview;
  if (notes.length === 0) return null;
  const names = (assets: readonly string[]) =>
    new Intl.ListFormat(LOCALE[language], { type: 'conjunction' }).format(
      assets.map(
        (asset) =>
          allocations.find((line) => line.assetId === asset)?.symbol ?? displayName(asset, t.plan),
      ),
    );
  const noteOf = (note: (typeof notes)[number]): string => {
    switch (note.code) {
      case 'equal_split':
        return note.assetIds.length === allocations.length
          ? m.note.equalAll
          : m.note.equalRest(names(note.assetIds));
      case 'stated':
        return m.note.stated(names(note.assetIds), note.quote ?? '');
      case 'scaled':
        return m.note.scaled;
      case 'pick_dropped':
        return m.note.dropped(names(note.assetIds));
      case 'share_unmet':
        return m.note.unmet(note.quote ?? '');
      case 'share_unread':
        return m.note.unread(note.quote ?? '');
      case 'share_withdrawn':
        return m.note.withdrawn(note.quote ?? '');
    }
  };
  return (
    <div data-ui="weight-notes">
      <h3 className="text-caption font-medium">{allocations.length ? m.notes : m.notesAlone}</h3>
      <ul className="list-inside list-disc text-body-sm">
        {notes.map((note) => (
          <li
            key={`${note.code}:${note.assetIds.join(',')}:${note.quote ?? ''}`}
            className="[overflow-wrap:anywhere]"
          >
            {noteOf(note)}
          </li>
        ))}
      </ul>
    </div>
  );
}
