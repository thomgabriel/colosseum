'use client';
import {
  ChainId,
  chainFamily,
  ORDER_DEFAULT_SLIPPAGE_BPS,
  type VaultResponse,
} from '@colosseum/schemas';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { buttonClass } from '../../components/ui/button-class';
import { ChainBadge } from '../../components/ui/ChainBadge';
import { cn } from '../../components/ui/cn';
import { DataTable } from '../../components/ui/DataTable';
import { Field, Input } from '../../components/ui/Field';
import { PAGE_TITLE } from '../../components/ui/heading';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import { StatusMark } from '../../components/ui/StatusMark';
import { LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { AmountCard, type AmountMode } from '../amount/AmountCard';
import {
  centsOfShare,
  leastCentsOf,
  maxText,
  readAmount,
  shareOfCents,
  toCents,
} from '../amount/amount-check';
import { dollars as wholeDollars } from '../goal/sheet';
import { formatBps, formatRaw, parseRaw, rawOfShown, shownRaw, tokenName } from '../order/amounts';
import type { CallFailure } from '../order/order-api';
import { keepOrder } from '../order/order-record';
import { AssetMark } from '../order/PlanView';
import { chainReady, onMock } from '../order/readiness';
import { unitsFor } from '../order/units';
import { unpriced, vaultValueSource } from '../portfolio/portfolio';
import { vaultTitle } from '../portfolio/vault-name';
import { type ExposureChain, readExposure } from '../portfolio-section/api';
import { basisPoints } from '../portfolio-section/list-figures';
import { exitPin } from '../portfolio-section/pins';
import { useApiFetch, useWalletPort } from '../wallet/WalletProvider';
import { isVaultOf } from './chain-recipe';
import { placeShared, readVault } from './shared-api';
import { type DollarsTerms, type SharedTerms, shareOfRaw, type WithdrawItem } from './terms';
import { WithdrawWait } from './waits';

// Taking money out of a vault (WITHDRAW, Oct 6), for its owner only, on the amount card (gate
// AMOUNT-CARD): how much leaves (a share of the vault, in dollars of its value or 25% · 50% · 75% · Max,
// or chosen tokens, each in full or by amount), what reaches the wallet and where it goes, which is the
// owner's own wallet and nowhere else, then the order (POST /v1/orders, type `withdraw`) and its
// screen, where every step is checked by the guard before it is signed. The tokens leave as they are:
// nothing is sold. Or in dollars (WITHDRAW-DOLLARS, Oct 13): the same share
// of every holding is sold for the chain's cash token and the cash leaves, as one order whose steps
// state each sale's minimum; the tokens themselves stay the way that needs no market. Nothing is
// signed here. With `embedded` the vault's own
// page holds it in its pane: the same card under the page's heading, and the order's id handed to the
// page, which shows the steps there, in place of the order's own page.

type Load = { kind: 'loading' } | { kind: 'read'; read: VaultResponse } | { kind: CallFailure };
type Pick = { on: boolean; text: string };
type Way = 'tokens' | 'dollars';

/** A share typed in percent, as basis points: 0.01 to 100, two places at most. Null when it is not one. */
export function shareBpsOf(text: string): number | null {
  const m = /^(\d{1,3})(?:[.,](\d{1,2}))?$/.exec(text.trim());
  if (!m) return null;
  const bps = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return bps >= 1 && bps <= 10_000 ? bps : null;
}

export function WithdrawScreen({
  chain: chainText,
  address,
  embedded,
}: {
  chain: string;
  address: string;
  /**
   * Held in another screen's pane: no title of its own, and the order made is handed to the host.
   * `onMode`: Deposit | Withdraw on the amount card.
   */
  embedded?: {
    onOrder: (orderId: string) => void;
    onMode?: (mode: AmountMode) => void;
    /** The card's title, as the pane's heading; the amount takes the focus. */
    title?: string;
    /** The way back out of the pane, in the card's head. */
    leave?: { label: string; onLeave: () => void };
    /** Told as the amount card is drawn and taken away. */
    onShown?: (shown: boolean) => void;
  };
}) {
  const t = useT();
  const lang = useLang();
  const w = t.withdraw;
  const a = t.amount;
  const router = useRouter();
  const port = useWalletPort();
  const apiFetch = useApiFetch();
  const known = ChainId.safeParse(chainText);
  const chain = known.success ? known.data : null;
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [way, setWay] = useState<Way>('tokens');
  // The share as typed in dollars of the vault's value, or Max; a share picked where the value is
  // not known; and the tokens chosen one by one, behind their own control.
  const [text, setText] = useState('');
  // A quick share picked (25%, 50%, 75%, Max): held as that share, not as the dollars it types.
  const [chosen, setChosen] = useState<number | null>(null);
  const [picking, setPicking] = useState(false);
  const [choices, setChoices] = useState<Record<string, Pick>>({});
  // Bearing's measured cost of selling each holding, read only once the person looks at dollars.
  const [exits, setExits] = useState<ExposureChain | null>(null);
  const [placing, setPlacing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const titleId = useId();
  const wayId = useId();

  useEffect(() => {
    if (!chain) return setLoad({ kind: 'no-plan' });
    let mine = true;
    setLoad({ kind: 'loading' });
    readVault(apiFetch, chain, address).then((read) => {
      if (mine) setLoad(read.kind === 'read' ? { kind: 'read', read: read.value } : read);
    });
    return () => {
      mine = false;
    };
  }, [apiFetch, chain, address]);

  useEffect(() => {
    if (way !== 'dollars' || !chain) return;
    let mine = true;
    readExposure(apiFetch, { chain, address }).then((read) => {
      if (!mine || read.kind !== 'read') return;
      setExits(read.answer.chains.find((c) => c.chain === chain) ?? null);
    });
    return () => {
      mine = false;
    };
  }, [apiFetch, chain, address, way]);

  const back = (
    <Link href="/monitor" className={buttonClass({ variant: 'secondary' })}>
      {w.back}
    </Link>
  );
  const page = (body: string, more?: React.ReactNode) =>
    embedded ? (
      // in a host's pane: the sentence alone, under the host's heading and beside its way back
      <p data-ui="withdraw-gate" className="max-w-(--tf-measure-body) text-body">
        {body}
      </p>
    ) : (
      <section aria-labelledby={titleId} className="flex flex-col items-start gap-4">
        <h1 id={titleId} className={PAGE_TITLE}>
          {w.title}
        </h1>
        <p className="max-w-(--tf-measure-body) text-body">{body}</p>
        {more ?? back}
      </section>
    );

  if (port.status === 'loading' || load.kind === 'loading') return <WithdrawWait chain={chain} />;
  if (port.status === 'signed-out')
    return page(
      t.plan.signedOut,
      <Link
        href={`/sign-in?next=${encodeURIComponent(`/vaults/${chainText}/${address}/withdraw`)}`}
        className={buttonClass({ variant: 'secondary' })}
      >
        {t.shell.signIn}
      </Link>,
    );
  if (!chain || load.kind === 'no-plan' || load.kind === 'refused') return page(w.notYours);
  if (load.kind !== 'read') return page(load.kind === 'busy' ? t.shell.slowDown : w.failed);

  const { vault } = load.read;
  const owner = port.active(chainFamily(chain))?.address ?? null;
  // The owner's page and nobody else's: a vault pays only its owner, and nobody else is shown the way.
  if (!owner || vault.owner !== owner) return page(w.notYours);
  const holdings = [vault.cash, ...vault.positions].filter((h) => BigInt(h.raw) > 0n);
  if (holdings.length === 0) return page(w.empty);

  const mock = onMock(port, chain);
  const chainName = t.chain.names[chain];
  const units = unitsFor(chain, mock);
  const symbol = (asset: string) => units?.tokens[asset]?.symbol ?? tokenName(asset);
  // Every amount here is the figure the portfolio and the wallet show: the raw amount times the
  // token's multiplier (a stock token's issuer sets one), in the units this repository committed.
  const multiplierOf = (asset: string) =>
    holdings.find((h) => h.asset === asset)?.multiplier ?? '1';
  const whole = (raw: string, asset: string) => {
    const u = units?.tokens[asset];
    const shown = shownRaw(BigInt(raw), multiplierOf(asset)).toString();
    // To the token's last place: an amount typed back as it is shown is the amount that was shown.
    const figure = u ? formatRaw(shown, u.decimals, LOCALE[lang], u.decimals) : null;
    return u && figure !== null ? `${figure} ${u.symbol}` : `${raw} ${tokenName(asset)}`;
  };

  // What the person chose, as raw amounts: null for all of a token. An amount that is not one of this
  // token, or is more than the vault holds, is said beside its field and holds the step.
  const errors: Record<string, string> = {};
  const picked: WithdrawItem[] = !picking
    ? []
    : holdings.flatMap((h) => {
        const pick = choices[h.asset];
        if (!pick?.on) return [];
        const decimals = units?.tokens[h.asset]?.decimals;
        const item = { asset: h.asset, heldRaw: h.raw, multiplier: h.multiplier };
        if (!pick.text.trim() || decimals === undefined) return [{ ...item, amountRaw: null }];
        // Typed as it is shown; signed in exact raw units, rounded down, never above the balance: the
        // whole shown balance is the whole raw balance, whatever the rounding.
        const typed = parseRaw(pick.text, decimals);
        const held = BigInt(h.raw);
        const all = shownRaw(held, h.multiplier);
        const raw = typed === null ? null : typed === all ? held : rawOfShown(typed, h.multiplier);
        if (typed === null || raw === null || raw === 0n) errors[h.asset] = w.what.errors.amount;
        else if (typed > all || raw > held)
          errors[h.asset] = w.what.errors.over(whole(h.raw, h.asset));
        return [{ ...item, amountRaw: raw === null || raw === 0n ? null : raw.toString() }];
      });
  // How much leaves (gate AMOUNT-CARD): one share of the whole vault, typed in dollars of its value or
  // picked as 25% · 50% · 75% · Max, and the same share of every holding leaves: as the tokens
  // themselves, or sold for the cash token (WITHDRAW-DOLLARS). Each amount is rounded down as the
  // server rounds it. Or, the tokens themselves, chosen one by one with an amount for each.
  const value = Number(vault.valueUsd);
  const priced = Number.isFinite(value) && value > 0 && unpriced(vault) === 0;
  const valueObs = vaultValueSource(
    { ...load.read, vaults: [vault] },
    vault,
    t.portfolio.vault.valueMethod,
  );
  // The least a withdrawal by amount can be: one basis point of the vault, the smallest share an
  // order names, up to the cent. Anything under it is refused here, never rounded up to it.
  const leastCents = priced ? leastCentsOf(vault.valueUsd) : null;
  const leastUsd = leastCents !== null ? Number(leastCents) / 100 : 0.01;
  const typed = readAmount(
    text,
    lang,
    {
      least: leastUsd,
      most: Number.MAX_SAFE_INTEGER,
      available: priced ? value : null,
      of: 'vault',
    },
    t,
  );
  // The share the typed dollars come to, cut down to the basis point: what the order sends. In
  // integer cents against the vault's value as our server wrote it, never a float's division.
  const typedBps =
    priced && typed.amount !== null && !typed.over
      ? (shareOfCents(toCents(typed.amount), vault.valueUsd) ?? 0)
      : 0;
  const shareBps: number | null = picking
    ? null
    : chosen !== null
      ? chosen
      : typedBps >= 1
        ? typedBps
        : null;
  const cashSymbol = symbol(vault.cash.asset);
  const dollars: DollarsTerms | null =
    way === 'dollars' && shareBps !== null
      ? {
          shareBps,
          sales: vault.positions
            .map((p) => ({
              asset: p.asset,
              amountRaw: shareOfRaw(BigInt(p.raw), shareBps).toString(),
            }))
            .filter((x) => BigInt(x.amountRaw) > 0n),
          cashRaw: shareOfRaw(BigInt(vault.cash.raw), shareBps).toString(),
        }
      : null;
  // The tokens themselves: everything, that share of each, or the ones chosen.
  const everything = !picking && shareBps === 10_000;
  const items: WithdrawItem[] = picking
    ? picked
    : everything
      ? holdings.map((h) => ({
          asset: h.asset,
          amountRaw: null,
          heldRaw: h.raw,
          multiplier: h.multiplier,
        }))
      : shareBps === null
        ? []
        : holdings
            .map((h) => ({
              asset: h.asset,
              amountRaw: shareOfRaw(BigInt(h.raw), shareBps).toString(),
              heldRaw: h.raw,
              multiplier: h.multiplier,
            }))
            .filter((i) => BigInt(i.amountRaw) > 0n);
  const valid =
    way === 'dollars' ? dollars !== null : items.length > 0 && Object.keys(errors).length === 0;
  // Everything a token holds, taken by amount, empties it as taking all of it does.
  const emptied =
    way === 'dollars'
      ? shareBps === 10_000
      : items.length === holdings.length &&
        items.every((i) => i.amountRaw === null || i.amountRaw === i.heldRaw);

  /** Any change to what leaves takes back what was said of the last press. */
  const change = (apply: () => void) => {
    apply();
    setFailure(null);
  };

  const signable = chainReady(chain, mock) && port.network(chain)?.on !== false;
  const blocked = !signable ? [w.confirm.blocked.chain(chainName)] : [];

  async function review() {
    if (!chain || !owner || !port.userId || !valid) return;
    setPlacing(true);
    setFailure(null);
    // The plan number the steps name has to be this vault's own, as the guard derives its address.
    if (isVaultOf(chain, mock, owner, vault.basketId, vault.address) === false) {
      setPlacing(false);
      setFailure(w.confirm.blocked.vault);
      return;
    }
    // What the withdrawal is held to: the tokens and the amounts shown here, for this owner.
    // In dollars: the sales shown here and that share of the cash; the one token that leaves is the cash.
    const terms: SharedTerms = dollars
      ? {
          kind: 'withdraw',
          vault: vault.address,
          basketId: vault.basketId,
          owner,
          everything: false,
          items: [
            {
              asset: vault.cash.asset,
              amountRaw: null,
              heldRaw: vault.cash.raw,
              multiplier: vault.cash.multiplier,
            },
          ],
          autoFollowOff: vault.autoFollow,
          dollars,
        }
      : {
          kind: 'withdraw',
          vault: vault.address,
          basketId: vault.basketId,
          owner,
          everything,
          items,
          autoFollowOff: vault.autoFollow,
        };
    const placed = await placeShared(
      apiFetch,
      dollars
        ? {
            type: 'withdraw',
            vaults: [vault.address],
            sellToCash: true,
            ...(dollars.shareBps < 10_000 ? { shareBps: dollars.shareBps } : {}),
          }
        : {
            type: 'withdraw',
            vaults: [vault.address],
            sellToCash: false,
            ...(everything
              ? {}
              : { withdrawals: items.map(({ asset, amountRaw }) => ({ asset, amountRaw })) }),
          },
      { chain, owner, type: 'withdraw' },
    );
    if (placed.kind !== 'placed') {
      setPlacing(false);
      setFailure(
        placed.kind === 'said'
          ? t.shared.publish.failure.said(placed.error)
          : placed.kind === 'busy'
            ? t.shell.slowDown
            : placed.kind === 'signed-out'
              ? t.buy.failure.signedOut
              : placed.kind === 'unreadable'
                ? t.buy.failure.unreadable
                : t.buy.failure.unreachable,
      );
      return;
    }
    const kept = keepOrder({
      orderId: placed.order.id,
      userId: port.userId,
      proposalId: '',
      chain,
      amountUsd: 0,
      lines: [],
      terms,
      approved: null,
    });
    if (!kept) {
      setPlacing(false);
      setFailure(t.buy.failure.noStore);
      return;
    }
    if (embedded) {
      setPlacing(false);
      return embedded.onOrder(placed.order.id);
    }
    router.push(`/orders/${encodeURIComponent(placed.order.id)}`);
  }

  const locale = LOCALE[lang];
  const percent = (bps: number) => formatBps(bps, locale);
  const usd = (n: number) => wholeDollars(n, lang);
  // What the share is worth, by the prices the vault's value is read with: said "about".
  // What that share is worth, cut down to the cent: what the button and "You get" say, never the
  // figure typed, which the share may come to less than.
  const worthCents = shareBps !== null && priced ? centsOfShare(shareBps, vault.valueUsd) : null;
  const worth = worthCents !== null ? Number(worthCents) / 100 : null;
  const pin = (n: number) => (
    <ProvenancePin
      value={a.preview.about(usd(n))}
      labelValue={usd(n)}
      obs={valueObs}
      what={t.shared.vault.value}
      labels={t.pin}
    />
  );

  const d = w.check.dollars;
  const costOf = (asset: string) => {
    const exit = exits?.exit.find((x) => x.asset === asset);
    const exitObs = exit && exits ? exitPin(exit, exits.provenance) : null;
    return exit?.measured && exit.costBps !== null && exitObs ? (
      <ProvenancePin
        value={d.costBps(basisPoints(lang, exit.costBps))}
        obs={exitObs}
        what={d.cost}
        labels={t.pin}
      />
    ) : (
      d.notMeasured
    );
  };

  // The tokens one by one, each in full or by amount: the way it always was, behind its own control.
  const picks = (
    <ul data-ui="withdraw-picks" className="flex w-full flex-col divide-y divide-border">
      {holdings.map((h) => {
        const pick = choices[h.asset] ?? { on: false, text: '' };
        const set = (to: Partial<Pick>) =>
          change(() => setChoices((all) => ({ ...all, [h.asset]: { ...pick, ...to } })));
        const byAmount = units?.tokens[h.asset] !== undefined;
        return (
          <li key={h.asset} data-asset={h.asset} className="flex flex-col gap-2 py-3">
            <label className="inline-flex items-center gap-2 text-body">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={pick.on}
                onChange={(e) => set({ on: e.currentTarget.checked })}
              />
              {w.what.take(symbol(h.asset))}
            </label>
            <p className="text-body-sm text-muted-foreground tabular-nums">
              {w.what.holds(whole(h.raw, h.asset))}
            </p>
            {pick.on &&
              (byAmount ? (
                <Field
                  label={w.what.amount(symbol(h.asset))}
                  hint={w.what.amountHint}
                  error={errors[h.asset]}
                >
                  {(control) => (
                    <Input
                      {...control}
                      inputMode="decimal"
                      width="18ch"
                      value={pick.text}
                      onChange={(e) => set({ text: e.currentTarget.value })}
                    />
                  )}
                </Field>
              ) : (
                <p className="text-body-sm text-muted-foreground">{w.what.wholeOnly}</p>
              ))}
          </li>
        );
      })}
    </ul>
  );

  // The two ways out, as the card's own choice: the tokens themselves by default.
  const ways = (
    <fieldset data-ui="withdraw-way" className="flex min-w-0 flex-col gap-2">
      <legend className="sr-only">{w.way.legend}</legend>
      <div className="grid grid-cols-2 gap-1 rounded-md border border-input p-1">
        {(
          [
            ['tokens', a.out.asTokens],
            ['dollars', a.out.asCash(cashSymbol)],
          ] as const
        ).map(([option, label]) => (
          <label
            key={option}
            className={cn(
              'relative flex min-h-9 cursor-pointer items-center justify-center rounded-sm px-2 py-1.5 text-body-sm font-semibold transition-colors',
              'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring',
              way === option
                ? 'bg-honey-tint text-honey-text'
                : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
            )}
          >
            <input
              type="radio"
              name={wayId}
              // over the whole segment, unseen: the segment is the control a pointer or a key meets
              className="absolute inset-0 cursor-pointer appearance-none rounded-sm opacity-0"
              checked={way === option}
              disabled={placing}
              onChange={() =>
                change(() => {
                  setWay(option);
                  if (option === 'dollars') setPicking(false);
                })
              }
            />
            {label}
          </label>
        ))}
      </div>
      {way === 'tokens' && (
        <Button
          variant="link"
          className="self-start text-body-sm"
          data-action="withdraw-pick"
          aria-expanded={picking}
          onClick={() => change(() => setPicking((open) => !open))}
        >
          {picking ? a.out.byShare : a.out.choose}
        </Button>
      )}
      {picking && picks}
      {picking && items.length === 0 && <p className="text-body-sm">{w.what.errors.none}</p>}
    </fieldset>
  );

  // What reaches the wallet: about what the share is worth, then each token in one compact line. The
  // sales of a withdrawal in dollars, with each one's cost, are in the details.
  const inline = (rows: readonly { asset: string; text: string }[], ui: string) => (
    <ul data-ui={ui} className="flex flex-wrap gap-x-4 gap-y-1.5 text-body-sm tabular-nums">
      {rows.map((row) => (
        <li key={row.asset} className="inline-flex min-w-0 items-center gap-1.5">
          <AssetMark asset={row.asset} className="size-5" />
          <span className="[overflow-wrap:anywhere]">{row.text}</span>
        </li>
      ))}
    </ul>
  );
  // Only with a figure: no sentence in its place while there is nothing to say.
  const preview = !valid ? null : (
    <div data-ui="withdraw-gets" className="flex min-w-0 flex-col gap-1.5 text-body-sm">
      {worth !== null && (
        <p
          data-ui="withdraw-worth"
          className="font-display text-[1.25rem]/7 font-semibold tracking-[-0.01em] tabular-nums"
        >
          {pin(worth)}
          {way === 'dollars' && (
            <span className="ml-1.5 font-sans text-body-sm font-normal text-muted-foreground">
              {cashSymbol}
            </span>
          )}
        </p>
      )}
      {way === 'dollars' && dollars ? (
        <p data-ui="withdraw-cash" className="tabular-nums text-muted-foreground">
          {dollars.sales.length === 0
            ? d.nothing
            : BigInt(dollars.cashRaw) > 0n
              ? d.cash(whole(dollars.cashRaw, vault.cash.asset))
              : d.noCash}
        </p>
      ) : (
        inline(
          items.map((item) => ({
            asset: item.asset,
            text:
              item.amountRaw === null
                ? w.check.all(whole(item.heldRaw, item.asset))
                : whole(item.amountRaw, item.asset),
          })),
          'withdraw-tokens',
        )
      )}
    </div>
  );
  // What is sold, each with what it costs to sell: in the details.
  const salesTable = way === 'dollars' && dollars && dollars.sales.length > 0 && (
    <div data-ui="withdraw-sales" className="min-w-0">
      <DataTable
        className="w-full min-w-0"
        caption={d.sold}
        dense
        rows={dollars.sales}
        rowKey={(sale) => sale.asset}
        columns={[
          {
            key: 'asset',
            header: a.preview.asset,
            rowHeader: true,
            cell: (sale) => <AssetCell asset={sale.asset} name={symbol(sale.asset)} />,
          },
          {
            key: 'sold',
            header: d.amount,
            numeric: true,
            cell: (sale) => whole(sale.amountRaw, sale.asset),
          },
          { key: 'cost', header: d.costHeader, numeric: true, cell: (sale) => costOf(sale.asset) },
        ]}
      />
    </div>
  );

  const text2 = 'max-w-(--tf-measure-body)';
  const details = [
    {
      term: w.check.to,
      wide: true,
      value: (
        <>
          {w.check.own}{' '}
          <span data-ui="withdraw-to" className="break-all font-mono text-source font-normal">
            {owner}
          </span>
        </>
      ),
    },
    {
      term: w.check.from,
      wide: true,
      value: <span className="break-all font-mono text-source font-normal">{vault.address}</span>,
    },
    ...(way === 'dollars'
      ? [
          {
            term: a.details.slippage,
            value: a.details.slippageValue(percent(ORDER_DEFAULT_SLIPPAGE_BPS)),
          },
          ...(chainFamily(chain) === 'evm'
            ? [{ term: a.details.tradeLimits, value: a.details.tradeLimitsValue, wide: true }]
            : []),
        ]
      : []),
  ];
  // What the figures do not say, in words, behind one fold.
  const more = {
    label: a.out.what,
    body: (
      <div data-ui="withdraw-what" className="flex flex-col gap-2">
        <p data-ui="withdraw-way-hint" className={text2}>
          {way === 'tokens' ? w.way.tokensHint : w.way.dollarsHint(cashSymbol)}
        </p>
        {salesTable}
        {way === 'dollars' ? (
          <>
            <p className={text2}>{emptied ? d.emptied : d.stays}</p>
            <p className={text2}>{d.quotes}</p>
            <p data-ui="withdraw-not-sold" className={text2}>
              {d.notSold}
            </p>
            <p className={`${text2} text-muted-foreground`}>{d.costNote}</p>
            <p className={`${text2} text-muted-foreground`}>{d.targets}</p>
            <p className={`${text2} text-muted-foreground`}>{d.onlyOwner(cashSymbol)}</p>
          </>
        ) : (
          <>
            <p className={text2}>{emptied ? w.check.emptied : w.check.stays}</p>
            <p className={text2}>{w.check.noSale}</p>
            <p className={`${text2} text-muted-foreground`}>{w.check.onlyOwner}</p>
          </>
        )}
        <p className={`${text2} text-muted-foreground`}>{w.confirm.lead}</p>
      </div>
    ),
  };

  const shareChips = [2500, 5000, 7500, 10_000].map((bps) => ({
    key: String(bps),
    label: bps === 10_000 ? a.out.max : percent(bps),
    on: shareBps === bps,
    onPick: () =>
      change(() => {
        setPicking(false);
        setChosen(bps);
        const chipCents = priced ? centsOfShare(bps, vault.valueUsd) : null;
        if (chipCents !== null) setText(maxText(Number(chipCents) / 100, lang));
      }),
  }));

  const provenance = load.read.provenance;
  const card = (
    <AmountCard
      mode="withdraw"
      {...(embedded?.onMode ? { onMode: embedded.onMode } : {})}
      headingLevel={embedded && !embedded.title ? 3 : 2}
      {...(embedded?.title ? { title: embedded.title, focusOnOpen: true } : {})}
      {...(embedded?.leave ? { leave: embedded.leave } : {})}
      {...(embedded?.onShown ? { onShown: embedded.onShown } : {})}
      reserve
      chain={chain}
      chainName={chainName}
      provenance={provenance}
      // in the vault's own pane the vault is the page: no "From" to say it again
      into={
        embedded
          ? undefined
          : {
              label: t.amount.into.from,
              value: vault.address,
              options: [
                {
                  value: vault.address,
                  title: vault.address,
                  label: vaultTitle(
                    { number: vault.number ?? null },
                    { ...t.portfolio.actions, unnamed: () => t.shared.vault.page.yourVault },
                    chainName,
                  ),
                },
              ],
            }
      }
      field={
        picking
          ? null
          : {
              label: t.amount.field.withdraw,
              text: priced ? text : '',
              onText: (next) =>
                change(() => {
                  setChosen(null);
                  setText(next);
                }),
              token:
                way === 'dollars'
                  ? {
                      asset: vault.cash.asset,
                      symbol: cashSymbol,
                      name: t.amount.tokenOut(cashSymbol),
                    }
                  : null,
              balance: priced
                ? {
                    label: t.amount.balance.vault,
                    state: 'read',
                    figure: usd(cents(value)),
                    obs: valueObs,
                  }
                : undefined,
              chips: shareChips,
              chipsLabel: a.out.chips,
              problem: priced && chosen === null ? typed.problem : null,
              note: priced ? null : a.out.noValue,
            }
      }
      choice={ways}
      preview={preview && { title: a.preview.withdraw, body: preview }}
      {...(valid ? { details, more } : {})}
      notice={
        <>
          {vault.autoFollow && (
            <p
              data-ui="withdraw-keeper"
              className="flex max-w-(--tf-measure-body) items-start gap-1.5 text-body-sm"
            >
              <StatusMark status="watch" size={12} className="mt-1.5" />
              <span>{w.check.autoFollow}</span>
            </p>
          )}
          {failure && (
            <p
              role="alert"
              className="flex max-w-(--tf-measure-body) items-start gap-1.5 text-body-sm text-destructive"
            >
              <StatusMark status="off-track" size={12} className="mt-1.5" />
              <span>{failure}</span>
            </p>
          )}
        </>
      }
      action={{
        // with nothing chosen yet, the button names the action alone
        label: !valid
          ? w.action
          : picking
            ? a.press.withdrawPicked(items.length)
            : everything || (way === 'dollars' && shareBps === 10_000)
              ? a.press.withdrawAll
              : priced && worth !== null
                ? a.press.withdraw(usd(worth))
                : a.press.withdrawShare(percent(shareBps ?? 0)),
        held: !valid,
        reasons: blocked,
        busy: placing,
        busyLabel: w.confirm.busy,
        onPress: () => void review(),
      }}
      locked={placing}
    />
  );

  return (
    <div
      data-ui="withdraw-screen"
      className={embedded ? 'flex min-w-0 flex-col gap-4' : 'flex flex-col gap-8'}
    >
      {/* in a pane, the card alone: it says what leaves and where it goes (gate AMOUNT-CARD) */}
      {embedded ? null : (
        <header className="flex flex-col items-start gap-3">
          <ChainBadge chain={chain} />
          <h1 id={titleId} className={PAGE_TITLE}>
            {w.title}
          </h1>
          <p className="max-w-(--tf-measure-body) text-body-lg">{w.lead(chainName)}</p>
        </header>
      )}
      {card}
    </div>
  );
}

/** A holding in a table: its mark and its name. */
function AssetCell({ asset, name }: { asset: string; name: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <AssetMark asset={asset} className="size-5" />
      <span className="min-w-0 [overflow-wrap:anywhere]">{name}</span>
    </span>
  );
}

/** An amount of dollars cut down to the cent, never rounded up: what is shown is never more than there is. */
const cents = (usd: number) => Math.floor(usd * 100 + 1e-6) / 100;
