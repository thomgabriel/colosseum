'use client';
import type { ChainId, RebalanceQuoteResponse } from '@colosseum/schemas';
import { Fragment, useEffect, useState } from 'react';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import { pinSourceOfPrice } from '../../components/ui/price-source';
import { LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { formatRaw } from '../order/amounts';
import { displayName } from '../order/plain';
import { unitsFor } from '../order/units';
import { dollars, share } from '../portfolio/figures';
import { basisPoints } from '../portfolio-section/list-figures';
import { useApiFetch } from '../wallet/WalletProvider';
import { quoteRebalance } from './rebalance-api';
import { rebalanceWhy } from './rebalance-why';

// In the review of a follow, before anything is signed (Thom, Oct 13): what following this portfolio
// would do to the vault, as a quote taken now. Each trade with what goes in, what the quote says comes
// out, the least an order would take and the quote's cost; the vault's shares before and after against
// the portfolio's weights; and the cost of all the trades together. Every figure is our server's
// (`POST /v1/vaults/{chain}/{address}/rebalance/quote`) and carries its pin: a share and a dollar value
// the reference prices', a trade's own figures the chain's quote. Where the trades cannot be quoted it
// says which and why, and the follow can still be reviewed. Nothing here signs or stores anything: the
// trades are planned and quoted again when the rebalance is ordered.

type Load =
  | { kind: 'reading' }
  | { kind: 'failed' }
  | { kind: 'read'; quote: RebalanceQuoteResponse };

export function FollowQuote({
  chain,
  mock,
  address,
  slug,
  version,
}: {
  chain: ChainId;
  mock: boolean;
  address: string;
  slug: string;
  version: number;
}) {
  const t = useT();
  const lang = useLang();
  const q = t.shared.vaults.quote;
  const api = useApiFetch();
  const [load, setLoad] = useState<Load>({ kind: 'reading' });

  useEffect(() => {
    let mine = true;
    setLoad({ kind: 'reading' });
    quoteRebalance(api, chain, address, { slug, version }).then((answer) => {
      if (!mine) return;
      setLoad(answer.kind === 'ok' ? { kind: 'read', quote: answer.value } : { kind: 'failed' });
    });
    return () => {
      mine = false;
    };
  }, [api, chain, address, slug, version]);

  const quote = load.kind === 'read' ? load.quote : null;
  const provenance = quote?.provenance ?? (mock ? 'mock' : null);
  const units = unitsFor(chain, mock)?.tokens;
  const name = (asset: string) => displayName(asset, t.plan);
  const amountOf = (asset: string, raw: string): string | null => {
    const unit = units?.[asset];
    const figure = unit ? formatRaw(raw, unit.decimals, LOCALE[lang]) : null;
    return unit && figure !== null ? `${figure} ${unit.symbol}` : null;
  };
  /** The pin of a share or a dollar value: the reference price it was worked out with. */
  const priced = (asset: string) => {
    const price = quote?.prices.find((p) => p.asset === asset);
    return price ? pinSourceOfPrice(price) : (quote?.quote ?? null);
  };

  let body = (
    <p data-ui="follow-quote-reading" role="status" className="text-body-sm text-muted-foreground">
      {q.reading}
    </p>
  );
  if (load.kind === 'failed')
    body = (
      <p data-ui="follow-quote-failed" className="max-w-(--tf-measure-body) text-body-sm">
        {q.failed}
      </p>
    );
  if (quote) {
    // in this app's words, from the codes: never our server's English sentence
    const reason = quote.unavailable ? rebalanceWhy(quote.unavailable.issues, t, chain).why : null;
    body = (
      <>
        {quote.status === 'on_target' && (
          <p data-ui="follow-quote-on-target" className="max-w-(--tf-measure-body) text-body-sm">
            {q.onTarget}
          </p>
        )}
        {reason !== null && (
          <p data-ui="follow-quote-unavailable" className="max-w-(--tf-measure-body) text-body-sm">
            {q.unavailable(reason)}
          </p>
        )}
        {quote.trades.length > 0 && (
          <ol data-ui="follow-quote-trades" className="flex list-none flex-col gap-4 p-0">
            {quote.trades.map((trade) => {
              const sells = trade.buy === quote.holdings[0]?.asset;
              const asset = sells ? trade.sell : trade.buy;
              const put = amountOf(trade.sell, trade.amountInRaw);
              const out = amountOf(trade.buy, trade.expectedOutRaw);
              const least = amountOf(trade.buy, trade.minOutRaw);
              const cost = (Number(trade.valueUsd) * trade.costBps) / 10_000;
              const rows: [string, string, string | null, 'price' | 'quote'][] = [
                ['worth', q.worth, dollars(lang, trade.valueUsd), 'price'],
                ['receive', q.receive, out, 'quote'],
                ['minimum', q.minimum, least, 'quote'],
                [
                  'cost',
                  q.cost,
                  q.costOf(basisPoints(lang, trade.costBps), dollars(lang, cost.toFixed(2))),
                  'quote',
                ],
              ];
              return (
                <li
                  key={`${trade.sell}>${trade.buy}`}
                  data-ui="follow-quote-trade"
                  data-asset={asset}
                  className="flex flex-col gap-1.5"
                >
                  <p className="text-body">
                    {put === null
                      ? sells
                        ? q.sellPlain(name(asset))
                        : q.intoPlain(name(asset))
                      : sells
                        ? q.sell(put, name(asset))
                        : q.into(put, name(asset))}
                  </p>
                  <dl className="grid gap-x-6 gap-y-1 text-body-sm min-[480px]:grid-cols-[auto_1fr]">
                    {rows.map(([id, term, value, from]) => {
                      const obs = from === 'price' ? priced(asset) : quote.quote;
                      return value !== null && obs ? (
                        <Fragment key={id}>
                          <dt className="text-muted-foreground">{term}</dt>
                          <dd data-row={id} className="tabular-nums">
                            <ProvenancePin value={value} obs={obs} what={term} labels={t.pin} />
                          </dd>
                        </Fragment>
                      ) : null;
                    })}
                  </dl>
                </li>
              );
            })}
          </ol>
        )}
        {quote.status === 'quoted' && quote.costUsd !== null && (
          <p data-ui="follow-quote-total" className="text-body-sm">
            {q.total}{' '}
            <span className="font-medium tabular-nums">
              <ProvenancePin
                value={dollars(lang, quote.costUsd)}
                obs={quote.quote}
                what={q.total}
                labels={t.pin}
              />
            </span>
          </p>
        )}
        {quote.status === 'quoted' && (
          <p className="max-w-(--tf-measure-body) text-caption text-muted-foreground">
            {q.slippage(basisPoints(lang, quote.slippageBps))}
          </p>
        )}
        {quote.valueUsd !== null && (
          <table data-ui="follow-quote-holdings" className="w-full text-body-sm">
            <caption className="pb-2 text-left text-caption text-muted-foreground">
              {q.holdings}
            </caption>
            <thead>
              <tr className="text-left text-caption text-muted-foreground">
                <th scope="col" className="font-normal">
                  {q.columns.asset}
                </th>
                <th scope="col" className="text-right font-normal">
                  {q.columns.before}
                </th>
                {quote.status === 'quoted' && (
                  <th scope="col" className="text-right font-normal">
                    {q.columns.after}
                  </th>
                )}
                <th scope="col" className="text-right font-normal">
                  {q.columns.target}
                </th>
              </tr>
            </thead>
            <tbody>
              {quote.holdings.map((h) => {
                const obs = h.cash ? quote.quote : priced(h.asset);
                const cell = (bps: number, what: string) =>
                  obs ? (
                    <ProvenancePin value={share(lang, bps)} obs={obs} what={what} labels={t.pin} />
                  ) : (
                    '—'
                  );
                return (
                  <tr key={h.asset} data-asset={h.asset}>
                    <th scope="row" className="py-1 text-left font-normal">
                      {h.cash ? q.cash : name(h.asset)}
                    </th>
                    <td data-col="before" className="py-1 text-right tabular-nums">
                      {cell(h.beforeBps, q.columns.before)}
                    </td>
                    {quote.status === 'quoted' && (
                      <td data-col="after" className="py-1 text-right tabular-nums">
                        {cell(h.afterBps, q.columns.after)}
                      </td>
                    )}
                    <td data-col="target" className="py-1 text-right tabular-nums">
                      {share(lang, h.targetBps)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </>
    );
  }

  return (
    <Card
      as="section"
      aria-label={q.title}
      mock={provenance === 'mock'}
      mockLabels={{ announce: t.shell.mockAnnounce }}
      className="w-full"
    >
      <CardHeader title={q.title} level={3} meta={t.chain.names[chain]} />
      <CardBody className="flex flex-col gap-4">
        {provenance === 'sandbox' && (
          <p data-ui="data-note" className="text-caption text-muted-foreground">
            {t.buy.steps.note.testNetwork(t.chain.names[chain])}
          </p>
        )}
        <p className="max-w-(--tf-measure-body) text-body-sm text-muted-foreground">{q.lead}</p>
        {body}
      </CardBody>
    </Card>
  );
}
