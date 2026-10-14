'use client';
import Link from 'next/link';
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { buttonClass } from '../../components/ui/button-class';
import { ChainBadge } from '../../components/ui/ChainBadge';
import { cn } from '../../components/ui/cn';
import { Input } from '../../components/ui/Field';
import { Icon } from '../../components/ui/Icon';
import { KIT_ABOVE_LINK, KIT_ROW_LINK } from '../../components/ui/KitTable';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import { LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { dollars } from '../portfolio/figures';
import {
  ago,
  type ConversationRow,
  type DayGroup,
  type DraftRow,
  groupByDay,
  matching,
  SEARCH_FROM,
  type VaultRow,
} from './conversation-list';
import { NAME_LENGTH } from './conversations';

// The conversations panel of /invest (Thom, Oct 14, in place of the picker): a rail beside the
// conversation from 1024px, open at 304px or closed to a 56px strip as this browser last left it, and
// a sheet over the page under that, opened from a button over the conversation. "New conversation" on
// top, then the person's drafts and vaults in three groups by day, newest first: each with its name,
// its chain, how long ago it was written and, for a vault, its value with its pin. The one on screen
// is marked. Over eight rows a search narrows them by name. A draft is renamed or deleted in its row;
// a vault opens its own page, where its conversation is. The arrow keys move between the rows.

const SIDE_KEY = 'tf-conversations-closed';
const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const GROUPS: readonly DayGroup[] = ['today', 'yesterday', 'earlier'];

/** A vault's own page: its conversation beside its plan (the overview's link to it). */
const vaultHref = (chain: string, address: string) =>
  `/portfolio/vaults/${encodeURIComponent(chain)}/${encodeURIComponent(address)}`;

export type RailActions = {
  onNew: () => void;
  onOpen: (row: DraftRow) => void;
  onRename: (row: DraftRow, name: string) => void;
  onDelete: (row: DraftRow) => void;
};

export function ConversationRail({
  rows,
  now,
  ...actions
}: RailActions & { rows: readonly ConversationRow[]; now: number }) {
  const w = useT().goal.explore.picker;
  const [closed, setClosed] = useState(false);
  const [sheet, setSheet] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const listId = useId();

  // On a wide screen the rail opens as this browser last left it.
  useEffect(() => {
    try {
      setClosed(localStorage.getItem(SIDE_KEY) === '1');
    } catch {
      // the rail works without storage
    }
  }, []);
  const toggle = () => {
    const next = !closed;
    setClosed(next);
    try {
      localStorage.setItem(SIDE_KEY, next ? '1' : '0');
    } catch {
      // the rail works without storage
    }
  };

  // The sheet is a modal dialog: the page under it is out of reach, Escape closes it, and the focus
  // goes back to the button that opened it.
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (sheet && !node.open) {
      if (typeof node.showModal === 'function') node.showModal();
      else node.setAttribute('open', '');
    }
    if (!sheet && node.open) {
      if (typeof node.close === 'function') node.close();
      else node.removeAttribute('open');
      opener.current?.focus();
    }
  }, [sheet]);
  // Whatever is chosen in the sheet closes it.
  const inSheet: RailActions = {
    onNew: () => {
      setSheet(false);
      actions.onNew();
    },
    onOpen: (row) => {
      setSheet(false);
      actions.onOpen(row);
    },
    onRename: actions.onRename,
    onDelete: actions.onDelete,
  };
  const current = rows.find((row) => row.current);

  return (
    <>
      {/* Under 1024px: one button over the conversation, which names the one on screen. */}
      <div className="flex min-w-0 lg:hidden">
        <button
          ref={opener}
          type="button"
          data-ui="conversations-open"
          aria-haspopup="dialog"
          aria-expanded={sheet}
          onClick={() => setSheet(true)}
          className={cn(
            buttonClass({ variant: 'secondary', size: 'dense' }),
            'h-9 max-w-full min-w-0 gap-2 px-3 text-body-sm font-medium',
          )}
        >
          <Icon name="Menu" size={16} />
          <span className="shrink-0">{w.label}</span>
          {current && (
            <span className="min-w-0 truncate font-normal text-muted-foreground">
              {current.title}
            </span>
          )}
        </button>
      </div>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard closes it with Escape (onCancel); a press on the dimmed page is the pointer's way */}
      <dialog
        ref={dialog}
        aria-label={w.label}
        data-ui="conversations-sheet"
        onCancel={(event) => {
          event.preventDefault();
          setSheet(false);
        }}
        onClick={(event) => {
          // a press on the dimmed page around the sheet closes it
          if (event.target === event.currentTarget) setSheet(false);
        }}
        className="fixed inset-y-0 left-0 m-0 h-dvh max-h-dvh w-[min(22rem,calc(100vw-3rem))] max-w-none border-0 border-r border-border bg-card p-0 text-card-foreground backdrop:bg-black/50 lg:hidden"
      >
        {sheet && (
          <div className="flex h-full flex-col">
            <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
              <h2 className="text-body-lg font-semibold">{w.label}</h2>
              <button
                type="button"
                data-ui="conversations-close"
                onClick={() => setSheet(false)}
                className={buttonClass({ variant: 'icon', size: 'dense' })}
                aria-label={w.close}
              >
                <Icon name="X" size={16} />
              </button>
            </div>
            <ConversationList rows={rows} now={now} {...inSheet} />
          </div>
        )}
      </dialog>

      {/* From 1024px: the rail beside the conversation, under the app's fixed bar. */}
      <aside
        aria-label={w.label}
        data-ui="conversations"
        data-closed={closed || undefined}
        className={cn(
          'max-lg:hidden lg:sticky lg:top-[calc(env(safe-area-inset-top,0px)+88px)] lg:flex lg:max-h-[calc(100dvh-104px)] lg:flex-col lg:self-start lg:overflow-hidden lg:rounded-xl lg:border lg:border-border lg:bg-card',
          closed ? 'lg:w-14' : 'lg:w-76',
        )}
      >
        <div
          className={cn(
            'flex items-center gap-2 border-b border-border',
            closed ? 'flex-col px-2 py-3' : 'justify-between px-4 py-3',
          )}
        >
          {!closed && <h2 className="text-body-lg font-semibold">{w.label}</h2>}
          <button
            type="button"
            data-ui="conversations-toggle"
            aria-expanded={!closed}
            aria-controls={listId}
            onClick={toggle}
            className={buttonClass({ variant: 'icon', size: 'dense' })}
            aria-label={closed ? w.show : w.hide}
            title={closed ? w.show : w.hide}
          >
            <Icon name="Menu" size={16} />
          </button>
          {closed && (
            <button
              type="button"
              data-ui="conversation-new"
              onClick={actions.onNew}
              className={buttonClass({ variant: 'icon', size: 'dense' })}
              aria-label={w.fresh}
              title={w.fresh}
            >
              <Icon name="Plus" size={16} />
            </button>
          )}
        </div>
        <div id={listId} hidden={closed} className="flex min-h-0 flex-1 flex-col">
          {!closed && <ConversationList rows={rows} now={now} {...actions} />}
        </div>
      </aside>
    </>
  );
}

/** "New conversation", the search where there are many, and the rows in their groups. */
function ConversationList({
  rows,
  now,
  onNew,
  onOpen,
  onRename,
  onDelete,
}: RailActions & { rows: readonly ConversationRow[]; now: number }) {
  const w = useT().goal.explore.picker;
  const [query, setQuery] = useState('');
  const [said, setSaid] = useState('');
  const searchId = useId();
  const nav = useRef<HTMLElement>(null);
  const searching = rows.length >= SEARCH_FROM;
  const shown = useMemo(
    () => (searching ? matching(rows, query) : [...rows]),
    [rows, query, searching],
  );
  const groups = groupByDay(shown, now);

  /** Up and down move between the rows' names; Home and End go to the first and the last. */
  const move = (event: KeyboardEvent) => {
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    const target = event.target as HTMLElement;
    if (target.closest('input')) return;
    const all = [
      ...(nav.current?.querySelectorAll<HTMLElement>('[data-ui="conversation-open"]') ?? []),
    ];
    if (all.length === 0) return;
    const at = all.findIndex((el) => el === target || el.contains(target));
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? all.length - 1
          : event.key === 'ArrowDown'
            ? Math.min(all.length - 1, at + 1)
            : Math.max(0, at < 0 ? 0 : at - 1);
    event.preventDefault();
    all[next]?.focus();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
      <button
        type="button"
        data-ui="conversation-new"
        onClick={onNew}
        className={cn(buttonClass({ variant: 'secondary', size: 'dense' }), 'h-9 w-full gap-2')}
      >
        <Icon name="Plus" size={16} />
        {w.fresh}
      </button>
      {searching && (
        <div data-ui="conversation-search" className="relative">
          <label htmlFor={searchId} className="sr-only">
            {w.search}
          </label>
          <Icon
            name="Search"
            size={16}
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            id={searchId}
            type="search"
            placeholder={w.search}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-9 pl-9 text-body-sm"
          />
        </div>
      )}
      <span role="status" className="sr-only">
        {said}
      </span>
      <nav
        ref={nav}
        aria-label={w.label}
        onKeyDown={move}
        className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1"
      >
        {rows.length === 0 && <p className="px-2 text-body-sm text-muted-foreground">{w.empty}</p>}
        {rows.length > 0 && shown.length === 0 && (
          <p data-ui="conversation-no-match" className="px-2 text-body-sm text-muted-foreground">
            {w.noMatch(query.trim())}
          </p>
        )}
        {GROUPS.map((group) =>
          groups[group].length === 0 ? null : (
            <Group key={group} title={w.groups[group]} group={group}>
              {groups[group].map((row) =>
                row.kind === 'vault' ? (
                  <VaultItem key={row.key} row={row} now={now} />
                ) : (
                  <DraftItem
                    key={row.key}
                    row={row}
                    now={now}
                    onOpen={onOpen}
                    onRename={onRename}
                    onDelete={(it) => {
                      setSaid(w.removed(it.title));
                      onDelete(it);
                    }}
                  />
                ),
              )}
            </Group>
          ),
        )}
      </nav>
    </div>
  );
}

function Group({
  title,
  group,
  children,
}: {
  title: string;
  group: DayGroup;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section data-ui="conversation-group" data-group={group} aria-labelledby={id} className="mb-3">
      <h3 id={id} className="px-2 pb-1 text-caption font-medium text-muted-foreground">
        {title}
      </h3>
      <ul className="grid list-none grid-cols-[minmax(0,1fr)] gap-0.5 p-0">{children}</ul>
    </section>
  );
}

/** The chain and how long ago, under a row's name. */
function Meta({ row, now, children }: { row: ConversationRow; now: number; children?: ReactNode }) {
  const lang = useLang();
  return (
    <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-muted-foreground">
      <ChainBadge chain={row.chain} />
      {row.at !== null && (
        <time dateTime={new Date(row.at).toISOString()}>{ago(row.at, now, LOCALE[lang])}</time>
      )}
      {children}
    </span>
  );
}

const ROW =
  'group/row relative flex min-w-0 items-start gap-2 rounded-md px-2 py-2 hover:bg-muted/60';

function DraftItem({
  row,
  now,
  onOpen,
  onRename,
  onDelete,
}: {
  row: DraftRow;
  now: number;
  onOpen: (row: DraftRow) => void;
  onRename: (row: DraftRow, name: string) => void;
  onDelete: (row: DraftRow) => void;
}) {
  const w = useT().goal.explore.picker;
  const [mode, setMode] = useState<'shown' | 'naming' | 'deleting'>('shown');
  const [name, setName] = useState(row.title);
  const nameId = useId();
  const keep = useRef<HTMLButtonElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (mode === 'deleting') keep.current?.focus();
  }, [mode]);
  const done = () => {
    setMode('shown');
    // back to the row's name once it is drawn again
    requestAnimationFrame(() => back.current?.focus());
  };
  const attrs = {
    'data-ui': 'conversation-row',
    'data-kind': 'draft',
    'data-chain': row.chain,
    'data-id': row.id,
    'data-current': row.current || undefined,
  };

  if (mode === 'naming')
    return (
      <li {...attrs} className={cn(ROW, 'flex-col gap-2 bg-muted/60')}>
        <form
          data-ui="conversation-name"
          className="flex w-full flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            onRename(row, name);
            done();
          }}
        >
          <label htmlFor={nameId} className="sr-only">
            {w.name}
          </label>
          <Input
            id={nameId}
            value={name}
            maxLength={NAME_LENGTH}
            autoFocus
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              event.preventDefault();
              event.stopPropagation();
              setName(row.title);
              done();
            }}
            className="h-9 text-body-sm"
          />
          <div className="flex gap-2">
            <button
              type="submit"
              data-ui="conversation-name-save"
              className={buttonClass({ variant: 'secondary', size: 'dense' })}
            >
              {w.save}
            </button>
            <button
              type="button"
              onClick={() => {
                setName(row.title);
                done();
              }}
              className={buttonClass({ variant: 'link' })}
            >
              {w.cancel}
            </button>
          </div>
        </form>
      </li>
    );

  if (mode === 'deleting')
    return (
      <li
        {...attrs}
        className={cn(ROW, 'flex-col gap-2 bg-muted/60')}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          done();
        }}
      >
        <p data-ui="conversation-title" className="text-body-sm font-medium">
          {row.title}
        </p>
        <p data-ui="conversation-confirm" className="text-caption text-muted-foreground">
          {w.confirm}
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            data-ui="conversation-delete-yes"
            onClick={() => onDelete(row)}
            className={buttonClass({ variant: 'destructive', size: 'dense' })}
          >
            {w.yes}
          </button>
          <button
            ref={keep}
            type="button"
            data-ui="conversation-delete-keep"
            onClick={done}
            className={buttonClass({ variant: 'secondary', size: 'dense' })}
          >
            {w.keep}
          </button>
        </div>
      </li>
    );

  return (
    <li {...attrs} className={cn(ROW, row.current && 'bg-accent hover:bg-accent')}>
      <button
        ref={back}
        type="button"
        data-ui="conversation-open"
        aria-current={row.current ? 'true' : undefined}
        onClick={() => onOpen(row)}
        className={cn('min-w-0 flex-1 rounded-md text-left', FOCUS)}
      >
        <span
          data-ui="conversation-title"
          className="block truncate text-body-sm font-medium text-foreground"
        >
          {row.title}
        </span>
        {row.current && <span className="sr-only">, {w.here}</span>}
        <Meta row={row} now={now} />
      </button>
      {/* On the row the pointer or the focus is on, and always on a touch screen: the name has the row's
          width otherwise. Shown with the focus, they are the next stops of Tab. */}
      <span className="flex shrink-0 gap-0.5 [@media(hover:hover)]:hidden [@media(hover:hover)]:group-focus-within/row:flex [@media(hover:hover)]:group-hover/row:flex">
        <button
          type="button"
          data-ui="conversation-rename"
          onClick={() => {
            setName(row.title);
            setMode('naming');
          }}
          className={cn(buttonClass({ variant: 'icon', size: 'dense' }), 'size-7 border-0')}
          aria-label={w.rename(row.title)}
          title={w.rename(row.title)}
        >
          <Icon name="Pencil" size={16} />
        </button>
        <button
          type="button"
          data-ui="conversation-delete"
          onClick={() => setMode('deleting')}
          className={cn(buttonClass({ variant: 'icon', size: 'dense' }), 'size-7 border-0')}
          aria-label={w.remove(row.title)}
          title={w.remove(row.title)}
        >
          <Icon name="X" size={16} />
        </button>
      </span>
    </li>
  );
}

function VaultItem({ row, now }: { row: VaultRow; now: number }) {
  const t = useT();
  const w = t.goal.explore.picker;
  const lang = useLang();
  return (
    <li
      data-ui="conversation-row"
      data-kind="vault"
      data-chain={row.chain}
      data-address={row.address}
      className={ROW}
    >
      <div className="min-w-0 flex-1">
        {/* The whole row opens the vault: the link's box covers it, the pin sits over it. */}
        <Link
          href={vaultHref(row.chain, row.address)}
          data-ui="conversation-open"
          aria-label={w.openVault(row.title)}
          className={cn(
            'line-clamp-2 rounded-md text-body-sm font-medium text-foreground',
            KIT_ROW_LINK,
            FOCUS,
          )}
        >
          <span data-ui="conversation-title">{row.title}</span>
        </Link>
        <Meta row={row} now={now}>
          <span className="sr-only">{w.vault}</span>
          {/* Its value at the end of the line, as a list of vaults shows it, with its pin. */}
          {row.value && (
            <span
              data-ui="conversation-value"
              className={cn(KIT_ABOVE_LINK, 'ml-auto text-body-sm text-foreground tabular-nums')}
            >
              <ProvenancePin
                value={dollars(lang, row.value.usd)}
                obs={row.value.obs}
                labels={t.pin}
              />
            </span>
          )}
        </Meta>
      </div>
    </li>
  );
}
