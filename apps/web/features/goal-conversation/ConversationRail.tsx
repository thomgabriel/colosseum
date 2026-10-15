'use client';
import Link from 'next/link';
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { buttonClass } from '../../components/ui/button-class';
import { CHAIN_NAMES, ChainBadge } from '../../components/ui/ChainBadge';
import { ChainLogo } from '../../components/ui/ChainLogo';
import { cn } from '../../components/ui/cn';
import { Input } from '../../components/ui/Field';
import { Icon } from '../../components/ui/Icon';
import { KIT_ABOVE_LINK, KIT_ROW_LINK } from '../../components/ui/KitTable';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import {
  MENU_BUTTON,
  MENU_FIELD,
  MENU_MARK,
  MENU_ROW,
  MENU_TEXT,
} from '../../components/ui/side-menu';
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

// The conversations panel of /invest (Thom, Oct 14, in place of the picker). From 1024px a rail beside
// the conversation, a card in the page's frame level with the title, 304px open or a 56px box folded as
// this browser last left it (and as INVEST-CHAT-ROOM folds it); inside, the analytics' side menu (Thom,
// Oct 15; side-menu.ts): "Hide conversations", "New conversation" and a search on top, then one line a
// row, the chain's mark in the menu's mark column and the name, the honey bar on the one on screen; the
// chain and how long ago in its tooltip, and under the name on the row the keyboard is on. Under 1024px
// a sheet over the page, opened from a button over the conversation, whose rows also say the chain, how
// long ago and, for a vault, its value with its pin.
// Both: the person's drafts and vaults in three groups by day, newest first, the one on screen marked;
// a draft renamed or deleted in its row; a vault opening its own page, where its conversation is; the
// arrow keys between the rows. The sheet's search is there from nine rows, the rail's always.

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

export function ConversationSheet({
  rows,
  now,
  id,
  onChosen,
  ...actions
}: RailActions & {
  rows: readonly ConversationRow[];
  now: number;
  /** The button's id, so focus can be put back on it once the head it is in is drawn again. */
  id?: string;
  /** Told before a conversation is chosen in the sheet, which may draw the head again. */
  onChosen?: () => void;
}) {
  const w = useT().goal.explore.picker;
  const [sheet, setSheet] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);

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
      onChosen?.();
      setSheet(false);
      actions.onNew();
    },
    onOpen: (row) => {
      onChosen?.();
      setSheet(false);
      actions.onOpen(row);
    },
    onRename: actions.onRename,
    // the one on screen deleted draws the head again, and this button with it: the focus comes back
    onDelete: (row) => {
      if (row.current) onChosen?.();
      actions.onDelete(row);
    },
  };
  const current = rows.find((row) => row.current);

  return (
    <>
      {/* Under 1024px: one button that names the one on screen; the title row's place for it. */}
      <div className="flex min-w-0 lg:hidden">
        <button
          ref={opener}
          id={id}
          type="button"
          data-ui="conversations-open"
          aria-haspopup="dialog"
          aria-expanded={sheet}
          onClick={() => setSheet(true)}
          className={cn(
            buttonClass({ variant: 'secondary', size: 'dense' }),
            'h-8 max-w-full min-w-0 gap-2 px-3 text-body-sm font-medium',
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
    </>
  );
}

export function ConversationRail({
  rows,
  now,
  drafting = false,
  ...actions
}: RailActions & {
  rows: readonly ConversationRow[];
  now: number;
  /** A draft is beside the chat: the rail folds to its strip until it is opened again (Thom, Oct 15). */
  drafting?: boolean;
}) {
  const w = useT().goal.explore.picker;
  const [closed, setClosed] = useState(false);
  const [reopened, setReopened] = useState(false);
  const listId = useId();

  // A draft on screen folds it, whichever way the draft came (sent, opened from the rail, read back
  // on a return), and whatever this browser kept from another visit; once the person opens it again
  // on this visit it stays open as they move between drafts. A conversation with no draft on screen
  // (a new one, or one started over) lets the next draft fold it again.
  useLayoutEffect(() => {
    if (!drafting) setReopened(false);
  }, [drafting]);
  const folded = closed || (drafting && !reopened);

  // On a wide screen the rail opens as this browser last left it.
  useEffect(() => {
    try {
      setClosed(localStorage.getItem(SIDE_KEY) === '1');
    } catch {
      // the rail works without storage
    }
  }, []);
  const toggle = () => {
    const next = !folded;
    if (!next) setReopened(true);
    setClosed(next);
    try {
      localStorage.setItem(SIDE_KEY, next ? '1' : '0');
    } catch {
      // the rail works without storage
    }
  };

  // From the folded box's search: the rail opens with the focus in its search.
  const search = useRef<HTMLDivElement>(null);
  const [seek, setSeek] = useState(false);
  useEffect(() => {
    if (!seek || folded) return;
    setSeek(false);
    search.current?.querySelector('input')?.focus();
  }, [seek, folded]);
  const head = cn(MENU_BUTTON, 'w-full', FOCUS);
  const square = cn(MENU_BUTTON, 'w-full justify-center px-0', FOCUS);

  // From 1024px: a card beside the conversation, its top level with the title's, under the app's fixed
  // bar as the page scrolls.
  return (
    <div
      data-ui="conversations"
      data-closed={folded || undefined}
      className={cn(
        'max-lg:hidden lg:sticky lg:top-[calc(env(safe-area-inset-top,0px)+88px)] lg:flex lg:max-h-[calc(100dvh-104px)] lg:flex-col lg:self-start lg:overflow-hidden lg:rounded-xl lg:border lg:border-border lg:bg-card',
        MENU_TEXT,
        folded ? 'lg:w-14' : 'lg:w-76',
      )}
    >
      {/* the parent of its day groups' headings, as the sheet's own title is */}
      {!folded && <h2 className="sr-only">{w.label}</h2>}
      <div className={cn('flex flex-col gap-2 px-2 pt-3', folded && 'pb-3')}>
        <button
          type="button"
          data-ui="conversations-toggle"
          aria-expanded={!folded}
          aria-controls={listId}
          onClick={toggle}
          className={folded ? square : head}
          aria-label={folded ? w.show : w.hide}
          title={folded ? w.show : undefined}
        >
          <Icon name="Menu" size={16} />
          {!folded && <span>{w.hide}</span>}
        </button>
        {folded && (
          <>
            <button
              type="button"
              data-ui="conversation-new"
              onClick={actions.onNew}
              className={square}
              aria-label={w.fresh}
              title={w.fresh}
            >
              <Icon name="Plus" size={16} />
            </button>
            <button
              type="button"
              data-ui="conversations-seek"
              onClick={() => {
                toggle();
                setSeek(true);
              }}
              className={square}
              aria-label={w.search}
              title={w.search}
            >
              <Icon name="Search" size={16} />
            </button>
          </>
        )}
      </div>
      <div id={listId} hidden={folded} className="flex min-h-0 flex-1 flex-col">
        {!folded && <ConversationList rows={rows} now={now} dense search={search} {...actions} />}
      </div>
    </div>
  );
}

/** "New conversation", the search, and the rows in their groups: one line a row in the rail. */
function ConversationList({
  rows,
  now,
  dense = false,
  search,
  onNew,
  onOpen,
  onRename,
  onDelete,
}: RailActions & {
  rows: readonly ConversationRow[];
  now: number;
  /** The rail's: the menu's rows of one line, and the search always there. */
  dense?: boolean;
  search?: RefObject<HTMLDivElement | null>;
}) {
  const w = useT().goal.explore.picker;
  const [query, setQuery] = useState('');
  const searchId = useId();
  const nav = useRef<HTMLElement>(null);
  const fresh = useRef<HTMLButtonElement>(null);
  /** Where the focus goes once a deleted row is gone: the row now in its place, else the one before. */
  const refocus = useRef<number | null>(null);
  const names = () => [
    ...(nav.current?.querySelectorAll<HTMLElement>('[data-ui="conversation-open"]') ?? []),
  ];
  const rowsDrawn = () => [
    ...(nav.current?.querySelectorAll<HTMLElement>('[data-ui="conversation-row"]') ?? []),
  ];
  // biome-ignore lint/correctness/useExhaustiveDependencies: once the rows are drawn without the deleted one
  useEffect(() => {
    const at = refocus.current;
    if (at === null) return;
    refocus.current = null;
    const all = rowsDrawn();
    const target = all[Math.min(at, all.length - 1)]?.querySelector<HTMLElement>(
      '[data-ui="conversation-open"]',
    );
    (target ?? fresh.current)?.focus();
  }, [rows]);
  const searching = dense || rows.length >= SEARCH_FROM;
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
    const all = names();
    if (all.length === 0) return;
    // from a row's name or its rename and delete: the row it is in
    const row = target.closest('[data-ui="conversation-row"]');
    const at = all.findIndex((el) => row?.contains(el));
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
    <div className={cn('flex min-h-0 flex-1 flex-col', dense ? 'gap-2 pt-2' : 'gap-3 p-3')}>
      <button
        ref={fresh}
        type="button"
        data-ui="conversation-new"
        onClick={onNew}
        className={
          dense
            ? cn(MENU_BUTTON, 'mx-2', FOCUS)
            : cn(buttonClass({ variant: 'secondary', size: 'dense' }), 'h-9 w-full gap-2')
        }
      >
        <Icon name="Plus" size={16} />
        {w.fresh}
      </button>
      {searching && (
        <div ref={search} data-ui="conversation-search" className={cn('relative', dense && 'mx-2')}>
          <label htmlFor={searchId} className="sr-only">
            {w.search}
          </label>
          <Icon
            name="Search"
            size={16}
            className={cn(
              'pointer-events-none absolute top-1/2 -translate-y-1/2',
              // where the menu's buttons above it have their icon
              dense ? 'left-[11px] text-foreground' : 'left-3 text-muted-foreground',
            )}
          />
          {dense ? (
            <input
              id={searchId}
              type="search"
              placeholder={w.search}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className={cn(MENU_FIELD, FOCUS)}
            />
          ) : (
            <Input
              id={searchId}
              type="search"
              placeholder={w.search}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-9 pl-9 text-body-sm"
            />
          )}
        </div>
      )}
      <nav
        ref={nav}
        aria-label={w.label}
        onKeyDown={move}
        className={cn(
          'min-h-0 flex-1 overflow-y-auto',
          dense ? 'tf-scroll-thin px-2 pt-3 pb-3' : '-mx-1 px-1',
        )}
      >
        {rows.length === 0 && <p className="px-2 text-body-sm text-muted-foreground">{w.empty}</p>}
        {rows.length > 0 && shown.length === 0 && (
          <p data-ui="conversation-no-match" className="px-2 text-body-sm text-muted-foreground">
            {w.noMatch(query.trim())}
          </p>
        )}
        {GROUPS.map((group) =>
          groups[group].length === 0 ? null : (
            <Group key={group} title={w.groups[group]} group={group} dense={dense}>
              {groups[group].map((row) =>
                row.kind === 'vault' ? (
                  <VaultItem key={row.key} row={row} now={now} dense={dense} />
                ) : (
                  <DraftItem
                    key={row.key}
                    row={row}
                    now={now}
                    dense={dense}
                    onOpen={onOpen}
                    onRename={onRename}
                    onDelete={(it) => {
                      refocus.current = Math.max(
                        0,
                        rowsDrawn().findIndex((one) => one.dataset.key === it.key),
                      );
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
  dense,
  children,
}: {
  title: string;
  group: DayGroup;
  dense: boolean;
  children: ReactNode;
}) {
  // a heading and a list, and no landmark of its own: the panel's navigation is the one
  return (
    <div data-ui="conversation-group" data-group={group} className={dense ? 'mb-4' : 'mb-3'}>
      <h3
        className={cn(
          'text-caption text-muted-foreground',
          dense ? 'px-3 pb-1 font-normal' : 'px-2 pb-1 font-medium',
        )}
      >
        {title}
      </h3>
      <ul
        className={cn('grid list-none grid-cols-[minmax(0,1fr)] p-0', dense ? 'gap-px' : 'gap-0.5')}
      >
        {children}
      </ul>
    </div>
  );
}

/**
 * A rail row's one line: the chain's mark in the menu's mark column (its name's first two letters in
 * mono where it has no picture: Base), and the name. A vault's link is named by this line, so a reader
 * hears its name, "Vault", the chain and how long ago. What the sheet writes under the name (the chain
 * and how long ago) is its tooltip, said to a reader after the name, and written under the name on the
 * row the keyboard is on, since a tooltip is the pointer's alone.
 */
function Line({ row, now, kind }: { row: ConversationRow; now: number; kind?: string }) {
  const lang = useLang();
  return (
    <>
      <span aria-hidden="true" className={cn(MENU_MARK, 'flex items-center')}>
        <ChainLogo
          chain={row.chain}
          size={14}
          decorative
          fallback={<span data-ui="chain-code">{CHAIN_NAMES[row.chain].slice(0, 2)}</span>}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span data-ui="conversation-title" className="block truncate">
          {row.title}
        </span>
        <span
          aria-hidden="true"
          data-ui="conversation-said"
          className="hidden truncate text-caption font-normal text-muted-foreground group-focus-visible/open:block"
        >
          {said(row, now, LOCALE[lang], kind)}
        </span>
      </span>
      <span className="sr-only">
        {', '}
        {kind && `${kind}, `}
        <span data-ui="conversation-chain" data-chain={row.chain}>
          {CHAIN_NAMES[row.chain]}
        </span>
        {row.at !== null && (
          <>
            {', '}
            <time dateTime={new Date(row.at).toISOString()}>{ago(row.at, now, LOCALE[lang])}</time>
          </>
        )}
      </span>
    </>
  );
}
/** What a rail row says beside its name: the vault's kind, the chain and how long ago. */
const said = (row: ConversationRow, now: number, locale: string, kind?: string) =>
  [kind, CHAIN_NAMES[row.chain], row.at !== null ? ago(row.at, now, locale) : null]
    .filter(Boolean)
    .join(' · ');
const tip = (row: ConversationRow, now: number, locale: string, kind?: string) =>
  [kind, row.title, said(row, now, locale)].filter(Boolean).join(' · ');

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
/** The rail's row: the menu's row (side-menu.ts) and, for a draft, its rename and delete after it. */
const DENSE_ROW = 'group/row relative flex min-w-0 items-center gap-0.5';
const DENSE_OPEN = cn(MENU_ROW, 'group/open min-w-0 flex-1 text-left', FOCUS);

function DraftItem({
  row,
  now,
  dense,
  onOpen,
  onRename,
  onDelete,
}: {
  row: DraftRow;
  now: number;
  dense: boolean;
  onOpen: (row: DraftRow) => void;
  onRename: (row: DraftRow, name: string) => void;
  onDelete: (row: DraftRow) => void;
}) {
  const w = useT().goal.explore.picker;
  const lang = useLang();
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
    'data-key': row.key,
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
        {/* A draft with a deposit's ids beside it stays (DEPOSIT-IN-PLACE): said, with nothing to press but "Keep". */}
        <p data-ui="conversation-confirm" className="text-caption text-muted-foreground">
          {row.depositing ? w.depositing : w.confirm}
        </p>
        <div className="flex gap-2">
          {!row.depositing && (
            <button
              type="button"
              data-ui="conversation-delete-yes"
              onClick={() => onDelete(row)}
              className={buttonClass({ variant: 'destructive', size: 'dense' })}
            >
              {w.yes}
            </button>
          )}
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
    <li
      {...attrs}
      className={cn(dense ? DENSE_ROW : ROW, row.current && !dense && 'bg-accent hover:bg-accent')}
    >
      <button
        ref={back}
        type="button"
        data-ui="conversation-open"
        aria-current={row.current ? 'true' : undefined}
        onClick={() => onOpen(row)}
        title={dense ? tip(row, now, LOCALE[lang]) : undefined}
        className={dense ? DENSE_OPEN : cn('min-w-0 flex-1 rounded-md text-left', FOCUS)}
      >
        {dense ? (
          <Line row={row} now={now} />
        ) : (
          <>
            <span
              data-ui="conversation-title"
              className="block truncate text-body-sm font-medium text-foreground"
            >
              {row.title}
            </span>
            <Meta row={row} now={now} />
          </>
        )}
      </button>
      {/* On the row the pointer or the focus is on, and always on a touch screen: the name has the row's
          width otherwise. Shown with the focus, they are the next stops of Tab. A new conversation
          with no words is in no list yet: it has nothing to rename or delete. */}
      {row.kept && (
        <span className="flex shrink-0 gap-0.5 [@media(hover:hover)]:hidden [@media(hover:hover)]:group-focus-within/row:flex [@media(hover:hover)]:group-hover/row:flex">
          <button
            type="button"
            data-ui="conversation-rename"
            onClick={() => {
              setName(row.title);
              setMode('naming');
            }}
            className={cn(
              buttonClass({ variant: 'icon', size: 'dense' }),
              dense ? 'size-7 border-0 bg-transparent' : 'size-7 border-0',
            )}
            aria-label={w.rename(row.title)}
            title={w.rename(row.title)}
          >
            <Icon name="Pencil" size={16} />
          </button>
          <button
            type="button"
            data-ui="conversation-delete"
            onClick={() => setMode('deleting')}
            className={cn(
              buttonClass({ variant: 'icon', size: 'dense' }),
              dense ? 'size-7 border-0 bg-transparent' : 'size-7 border-0',
            )}
            aria-label={w.remove(row.title)}
            title={w.remove(row.title)}
          >
            <Icon name="X" size={16} />
          </button>
        </span>
      )}
    </li>
  );
}

function VaultItem({ row, now, dense }: { row: VaultRow; now: number; dense: boolean }) {
  const t = useT();
  const w = t.goal.explore.picker;
  const lang = useLang();
  // In the rail a vault is one line too, with no value: a figure is only ever drawn with its pin,
  // and there is no room for one; the sheet's row, and the vault's own page, carry it.
  if (dense)
    return (
      <li
        data-ui="conversation-row"
        data-kind="vault"
        data-chain={row.chain}
        data-address={row.address}
        className={DENSE_ROW}
      >
        <Link
          href={vaultHref(row.chain, row.address)}
          data-ui="conversation-open"
          title={tip(row, now, LOCALE[lang], w.vault)}
          className={DENSE_OPEN}
        >
          <Line row={row} now={now} kind={w.vault} />
        </Link>
      </li>
    );
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
