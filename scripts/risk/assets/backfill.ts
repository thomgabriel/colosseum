// `pnpm risk:assets-backfill <series> [--count] | --fetch (--window <…> | --all)` (PLAN-ASSETS AS.8, the prompt's
// section 6.4, gate ASSET-HISTORY). Each series is counted before it is fetched: `--count` (the default) samples
// it and writes <out>/<chain>/<series>/count-<stamp>.json with the window, the estimate and how it was made, the
// bytes and hours and whether they fit the budget; `--fetch --window` fetches one window of it to measure the
// walker's rate; `--fetch --all` runs the whole series, and refuses unless the newest count fits the budget.
// The full ingestion is Rodrigo's to start (AS.8): this session never passes --all.
//
//   robinhood-logs    --window <fromBlock>-<toBlock> [--pool <v3 pool | v4 id> | --token <address>] [--kind swaps|supply|liquidity]
//                     count: [--strata 16] [--window-blocks 100000]
//   chainlink-rounds  --feed <proxy>
//   solana-swaps      --pool <address> --window <fromISO>..<toISO> [--per-hour 30] [--before <signature>]
//   solana-mints      --mint <address> --window <fromISO>..<toISO>
//   external-daily    --coin <chain:address> | --protocol <slug>
//
// Files: <out> is ASSETS_DATA_DIR (default data/assets); every run appends a line to <out>/runs.jsonl. The
// budget (DA14, amended): at most 35 GB of new data under <out>, and never below 25 GB free on its disk; a fetch
// checks both before it starts and after every piece and stops, saying why. Inputs: the Robinhood Chain asset
// list (--list, default scripts/risk/assets/robinhood.json), RISK_EVM_DIR for RU.2's creation logs, RISK_DATA_DIR
// for Solana's registry, lending history and Step 5b; Solana calls go through SOLANA_RPC_URL (run with
// DOTENV_CONFIG_PATH pointing at the main checkout's .env; this file never reads it).
import 'dotenv/config';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statfsSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  type AnchoredPage,
  BACKFILL_METHOD_VERSION,
  BACKFILL_SERIES,
  type BackfillSeries,
  estimateSampled,
  estimateSignatures,
  fitsBudget,
  GB,
} from '@colosseum/risk';
import {
  ask,
  type Created,
  classifyPools,
  countLogs,
  type Deps,
  fetchLogs,
  LOG_KINDS,
  type LogKind,
  PoolResolver,
  seriesFilters,
  ZERO_ADDRESS,
} from '../../risk-evm/backfill-logs';
import { countRounds, fetchRounds } from '../../risk-evm/backfill-rounds';
import { CHAINS, type ChainConfig, rpcFor } from '../../risk-evm/config';
import { requestKey, rpcOver } from '../../risk-evm/replay';
import { createRpc, type Rpc, type RpcReply } from '../../risk-evm/rpc';
import { latestRegistryFile, type RegistryPool } from '../lib-history';
import { rpcStats, rpc as solRpc } from '../lib-pools';
import {
  CHART_SPAN_DAYS,
  coinKey,
  dailyChart,
  firstPrices,
  protocolTvl,
  writeSeries,
} from './backfill-external';
import {
  type Anchor,
  anchoredPage,
  anchors,
  blockAnchors,
  fetchWindow,
  pool,
} from './backfill-solana';

const args = process.argv.slice(2);
const series = args[0] as BackfillSeries;
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(name);
if (!BACKFILL_SERIES.includes(series)) {
  console.error(
    `usage: pnpm risk:assets-backfill <${BACKFILL_SERIES.join('|')}> [--count] | --fetch (--window … | --all)`,
  );
  process.exit(1);
}
const mode = has('--fetch') ? 'fetch' : 'count';
const all = has('--all');
const OUT = process.env.ASSETS_DATA_DIR ?? 'data/assets';
const RISK = process.env.RISK_DATA_DIR ?? 'data/risk';
const EVM = process.env.RISK_EVM_DIR ?? 'data/risk-evm';
const chainOf = (s: BackfillSeries) =>
  s === 'robinhood-logs' || s === 'chainlink-rounds' ? 'robinhood' : 'solana';
const seriesDir = join(OUT, chainOf(series), series);
mkdirSync(seriesDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13);
const t0 = Date.now();
const events: Array<Record<string, unknown>> = [];
const log = (e: Record<string, unknown>) => {
  const line = JSON.stringify({ at: new Date().toISOString(), series, ...e });
  events.push(e);
  console.log(line.length > 600 ? `${line.slice(0, 600)}…` : line);
};

// ---------------------------------------------------------------------------------------------------------------
// The budget

function dirBytes(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    n += e.isDirectory() ? dirBytes(p) : statSync(p).size;
  }
  return n;
}
const freeBytes = () => {
  const s = statfsSync(OUT);
  return s.bavail * s.bsize;
};
const budgetNow = (estimateBytes: number) =>
  fitsBudget({ estimateBytes, usedBytes: dirBytes(OUT), freeBytes: freeBytes() });
/** Before a fetch and after each piece: stop when the next piece could pass the budget. */
function guard(nextBytes: number) {
  const b = budgetNow(nextBytes);
  if (!b.fits) {
    log({ event: 'stopped_by_budget', reasons: b.reasons });
    finish({ stopped: b.reasons });
    process.exit(2);
  }
}
/** A whole series only when its newest count says it fits. */
function requireCountThatFits() {
  const counts = readdirSync(seriesDir)
    .filter((f) => f.startsWith('count-'))
    .sort();
  const last = counts.at(-1);
  if (!last) {
    console.error(`--all refused: no count of ${series} in ${seriesDir}; run --count first`);
    process.exit(1);
  }
  const c = JSON.parse(readFileSync(join(seriesDir, last), 'utf8')) as {
    estimate?: { gzBytes?: number };
  };
  const est = c.estimate?.gzBytes ?? Number.POSITIVE_INFINITY;
  const b = budgetNow(est);
  if (!b.fits) {
    console.error(`--all refused: ${b.reasons.join('; ')} (count ${last})`);
    process.exit(1);
  }
}
function finish(result: Record<string, unknown>) {
  const rec = opt('--record');
  if (rec)
    writeFileSync(
      rec,
      gzipSync(
        JSON.stringify({
          recordedAt: new Date().toISOString(),
          args,
          ...recordExtra,
          answers: recorded,
        }),
      ),
    );
  const line = {
    at: new Date().toISOString(),
    series,
    mode,
    args: args.slice(1),
    methodVersion: BACKFILL_METHOD_VERSION,
    seconds: Math.round((Date.now() - t0) / 1000),
    newDataBytes: dirBytes(OUT),
    freeGB: +(freeBytes() / GB).toFixed(1),
    ...result,
  };
  appendFileSync(join(OUT, 'runs.jsonl'), `${JSON.stringify(line)}\n`);
  return line;
}
function writeCount(body: Record<string, unknown>) {
  const file = join(seriesDir, `count-${stamp}.json`);
  writeFileSync(file, `${JSON.stringify(body, null, 1)}\n`);
  return file;
}
if (
  mode === 'fetch' &&
  !all &&
  !opt('--window') &&
  !opt('--feed') &&
  !opt('--coin') &&
  !opt('--protocol')
) {
  console.error(
    '--fetch needs a window (--window, --feed, --coin or --protocol); a whole series needs --all',
  );
  process.exit(1);
}
if (mode === 'fetch' && all) requireCountThatFits();

// ---------------------------------------------------------------------------------------------------------------
// Robinhood Chain

const robinhood = CHAINS.find((c) => c.id === 'robinhood') as ChainConfig;
// --record <file>: every request and its answer, for a fixture (replayed by scripts/risk-evm/replay.ts)
const recorded: Record<string, RpcReply> = {};
/** What a replay needs beside the answers (the feeds a count asked, the feed fetched). */
const recordExtra: Record<string, unknown> = {};
const evmDeps = (): Deps => {
  const inner = createRpc(rpcFor(robinhood).url, { timeoutMs: 120_000 });
  const rpc: Rpc = opt('--record')
    ? rpcOver(async (requests) => {
        const replies = await inner.batch(requests);
        requests.forEach((r, i) => {
          const a = replies[i];
          if (a && !a.error) recorded[requestKey(r)] = a;
        });
        return replies;
      }, inner.stats)
    : inner;
  return { rpc, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => new Date(), log };
};
type ListRow = {
  address: string;
  symbol: string;
  status: string;
  oracle: { kind: string; ref: string } | null;
};
function robinhoodList() {
  const file = opt('--list') ?? 'scripts/risk/assets/robinhood.json';
  const list = JSON.parse(readFileSync(file, 'utf8')) as { assets: ListRow[]; fetchedAt: string };
  const rows = list.assets.filter((a) => a.status !== 'excluded');
  return { file, list, rows };
}
/** The head, asked like every other read (after the live loop's minutes). */
async function head(deps: Deps) {
  const r = await ask(deps, { method: 'eth_blockNumber', params: [] });
  if (r.error || typeof r.result !== 'string')
    throw new Error(`eth_blockNumber: ${r.error?.message ?? 'no result'}`);
  return Number(BigInt(r.result));
}

async function robinhoodLogs() {
  const deps = evmDeps();
  const { file, rows } = robinhoodList();
  const tokens = new Set(rows.map((r) => r.address.toLowerCase()));
  const erc20 = [...tokens].filter((a) => a !== ZERO_ADDRESS);
  const creation = JSON.parse(readFileSync(join(EVM, 'creation-logs-robinhood.json'), 'utf8')) as {
    scannedTo: number;
    created: Created[];
  };
  const cls = classifyPools(creation.created, tokens);
  const resolver = new PoolResolver(robinhood, tokens, cls.classOf);
  const label = rpcFor(robinhood).label;
  if (mode === 'count') {
    const h = await head(deps);
    const k = Number(opt('--strata') ?? 16);
    const size = Number(opt('--window-blocks') ?? 100_000);
    const from = Number.isFinite(cls.firstBlock) ? cls.firstBlock : 0;
    const res = await countLogs(deps, {
      chain: robinhood,
      filters: seriesFilters(robinhood, erc20),
      resolver,
      tokens,
      from,
      head: h,
      strata: k,
      window: size,
    });
    const t = res.estimate.totals;
    const sum = (re: RegExp) =>
      Object.entries(t)
        .filter(([key]) => re.test(key))
        .reduce((a, [, v]) => a + v, 0);
    const listLogs = {
      swaps: sum(/^v[34]_swap:(list_pool|unknown_pool)$/),
      supply: sum(/^(mint|burn):list_token$/),
      liquidity: sum(/^v[34]_liquidity:(list_pool|unknown_pool)$/),
      ofWhichUnknownPool: sum(/:unknown_pool$/),
      otherVenueNotRead: sum(/:other_venue$/),
    };
    const gzBytes = sum(/:gzBytes$/);
    const logsAll = sum(/^(v[34]_swap|mint|burn|v[34]_liquidity):/);
    const queriesPerSample = res.measured.queries / Math.max(1, res.strata);
    const windows = Math.ceil((h - from + 1) / size);
    // the full walk asks the same filters over every window: the sample's queries and seconds a window, scaled
    // the live loop's minutes the count waited out are not the endpoint's time
    const quietS = events
      .filter((e) => e.event === 'quiet')
      .reduce((a, e) => a + Number(e.waitS ?? 0), 0);
    const hours = (((res.measured.rpcSeconds - quietS) / Math.max(1, res.strata)) * windows) / 3600;
    // the loop's minutes take a quarter of every hour
    const wallHours = hours / (46 / 60);
    const budget = budgetNow(gzBytes);
    const body = {
      series,
      chain: 'robinhood',
      countedAt: new Date().toISOString(),
      methodVersion: BACKFILL_METHOD_VERSION,
      rpc: label,
      list: file,
      tokens: { listRows: rows.length, erc20: erc20.length },
      pools: {
        creationLogsTo: creation.scannedTo,
        created: creation.created.length,
        ofTheList: cls.listPools,
        firstBlock: from,
      },
      window: { fromBlock: from, head: h, blocks: h - from + 1, windows, windowBlocks: size },
      method: `stratified sample: ${res.strata} strata of the span, one ${size}-block window at the middle of each, every log of the six filters (v3 Swap and Mint/Burn by topic over every contract, v4 Swap and ModifyLiquidity of the pool manager, Transfer from and to the zero address of the list's ${erc20.length} ERC-20 tokens), each stratum's count × its length ÷ the window's`,
      estimate: {
        listLogs,
        allLogs: logsAll,
        gzBytes,
        gzGB: +(gzBytes / GB).toFixed(2),
        totals: t,
      },
      sampledShare: res.estimate.sampledShare,
      measured: { ...res.measured, resolverCalls: resolver.calls },
      hours: {
        rpc: +hours.toFixed(2),
        wall: +wallHours.toFixed(2),
        queriesPerWindow: +queriesPerSample.toFixed(1),
      },
      budget,
      perStratum: res.estimate.perStratum,
    };
    const f = writeCount(body);
    return finish({
      count: f,
      listLogs,
      gzGB: body.estimate.gzGB,
      hours: body.hours,
      fits: budget.fits,
    });
  }
  // fetch
  const kind = opt('--kind') as LogKind | undefined;
  if (kind && !LOG_KINDS.includes(kind))
    throw new Error(`--kind ${kind}: one of ${LOG_KINDS.join(', ')}`);
  const subject = opt('--pool') ?? opt('--token');
  const subjectKind = opt('--token')
    ? 'token'
    : subject
      ? subject.length === 66
        ? 'v4'
        : 'cl'
      : undefined;
  let from: number;
  let to: number;
  if (all) {
    // the chain's first block: a token's first mint can come before its first pool
    from = 0;
    to = await head(deps);
  } else {
    const [a, b] = (opt('--window') as string).split('-').map(Number);
    if (!Number.isInteger(a) || !Number.isInteger(b) || (b as number) < (a as number))
      throw new Error('--window <fromBlock>-<toBlock>');
    from = a as number;
    to = b as number;
  }
  guard(0);
  const res = await fetchLogs(deps, {
    out: join(OUT, 'robinhood'),
    filters: seriesFilters(robinhood, erc20, { kind, subject, subjectKind }),
    from,
    to,
    window: 100_000,
    prepare: subject ? undefined : (rows) => resolver.resolve(deps, rows),
    keep: (r) =>
      subject
        ? r.subject === subject.toLowerCase()
        : r.kind === 'supply'
          ? tokens.has(r.subject)
          : ['list_pool', 'unknown_pool'].includes(resolver.classOf(r.subject)),
    source: `${robinhood.name} eth_getLogs through ${label}: Swap, Mint/Burn, ModifyLiquidity and Transfer at the zero address (backfill-0.1)`,
  });
  return finish({
    fetched: res,
    window: { from, to },
    subject: subject ?? null,
    kind: kind ?? 'all',
  });
}

async function chainlinkRounds() {
  const deps = evmDeps();
  const { file, rows } = robinhoodList();
  const tracked = JSON.parse(readFileSync('scripts/risk/universe/robinhood.json', 'utf8')) as {
    assets: Array<{ symbol: string; oracle: { kind: string; ref: string } | null }>;
  };
  const seen = new Set<string>();
  const feeds: Array<{ feed: string; symbol: string }> = [];
  for (const r of [...rows, ...tracked.assets])
    if (r.oracle?.kind === 'chainlink' && !seen.has(r.oracle.ref.toLowerCase())) {
      seen.add(r.oracle.ref.toLowerCase());
      feeds.push({ feed: r.oracle.ref.toLowerCase(), symbol: r.symbol });
    }
  const label = rpcFor(robinhood).label;
  const counted = await countRounds(deps, robinhood, feeds);
  recordExtra.feeds = feeds;
  if (opt('--feed')) recordExtra.feed = opt('--feed')?.toLowerCase();
  if (mode === 'count') {
    const rounds = counted.feeds.reduce((a, f) => a + (f.rounds ?? 0), 0);
    // bytes a round: what the feeds fetched so far wrote (their manifests), else SGOV's 158 B of Oct 11
    const done = join(OUT, 'robinhood', 'chainlink');
    const manifests = existsSync(done)
      ? readdirSync(done)
          .map((f) => join(done, f, 'manifest.json'))
          .filter((f) => existsSync(f))
          .map((f) => JSON.parse(readFileSync(f, 'utf8')) as { rows: number; bytes: number })
      : [];
    const fetchedRows = manifests.reduce((a, m) => a + m.rows, 0);
    const perRoundGz = fetchedRows ? manifests.reduce((a, m) => a + m.bytes, 0) / fetchedRows : 158;
    const gzBytes = rounds * perRoundGz;
    const budget = budgetNow(gzBytes);
    const body = {
      series,
      chain: 'robinhood',
      countedAt: new Date().toISOString(),
      methodVersion: BACKFILL_METHOD_VERSION,
      rpc: label,
      list: file,
      method:
        'phaseId() of each proxy, phaseAggregators(p) for p = 1 … phaseId, latestRound() of each phase aggregator, by Multicall3 at the head: the rounds are counted, not sampled',
      feeds: counted.feeds.length,
      rounds,
      calls: {
        multicallRequests: counted.requests,
        fetchCalls: rounds,
        fetchRequests: Math.ceil(rounds / 400),
      },
      estimate: {
        gzBytes,
        perRoundGzBytes: perRoundGz,
        perRoundSource: fetchedRows
          ? `the ${manifests.length} feeds fetched so far (${fetchedRows} rounds)`
          : 'SGOV, 2026-10-11',
      },
      budget,
      perFeed: counted.feeds,
    };
    const f = writeCount(body);
    return finish({ count: f, feeds: counted.feeds.length, rounds, fits: budget.fits });
  }
  const targets = all
    ? counted.feeds
    : counted.feeds.filter((f) => f.feed === opt('--feed')?.toLowerCase());
  if (!targets.length) throw new Error(`--feed ${opt('--feed')}: not a feed the lists name`);
  const results = [];
  for (const f of targets) {
    guard(0);
    results.push(
      await fetchRounds(
        deps,
        robinhood,
        f,
        join(OUT, 'robinhood', 'chainlink'),
        `${robinhood.name} Chainlink proxy ${f.feed} (${f.symbol}): getRoundData of every round of every phase by Multicall3 through ${label}`,
      ),
    );
  }
  return finish({ fetched: results });
}

// ---------------------------------------------------------------------------------------------------------------
// Solana

const SOL_LIMIT = Number(opt('--limit') ?? 250);
const DAY = 86_400;
type Reg = { pools: RegistryPool[] };
function solanaSubjects() {
  const regFile = opt('--registry') ?? latestRegistryFile(RISK);
  const reg = JSON.parse(readFileSync(regFile, 'utf8')) as Reg;
  const tracked = JSON.parse(readFileSync('scripts/risk/universe/solana.json', 'utf8')) as {
    assets: Array<{ address: string; symbol: string }>;
  };
  const trackedMints = new Set(tracked.assets.map((a) => a.address));
  const solList = opt('--sol-list') ?? 'scripts/risk/assets/solana.json';
  // the Solana asset list (AS.2) when it is committed; until then every stock token of the registry, the
  // tracked ones and the rest as candidates (DA16)
  const listed = existsSync(solList)
    ? new Set(
        (
          JSON.parse(readFileSync(solList, 'utf8')) as {
            assets: Array<{ address: string; status: string }>;
          }
        ).assets
          .filter((a) => a.status === 'listed' || a.status === 'candidate')
          .map((a) => a.address),
      )
    : null;
  const pools = reg.pools.filter(
    (p) => trackedMints.has(p.assetMint) || !listed || listed.has(p.assetMint),
  );
  const registryMints = new Set(pools.map((p) => p.assetMint));
  // the mints walked: every listed or candidate token of the list but USDC and USDT (DA15), else the
  // registry's stock tokens
  const mints = listed ? [...listed].filter((m) => !DA15_NOT_WALKED.has(m)) : [...registryMints];
  return { regFile, pools, mints, registryMints, trackedMints, list: listed ? solList : null };
}
/** USDC and USDT on Solana: their supply comes from the external daily series, their mints are not walked (DA15). */
const DA15_NOT_WALKED = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
]);

/**
 * The mint authorities of the list's listed and candidate tokens (not USDC, USDT): walking an authority's
 * signatures gives every mint and burn it signed for its tokens, where walking a mint gives every transfer.
 */
function authoritiesOf(file: string) {
  const list = JSON.parse(readFileSync(file, 'utf8')) as {
    assets: Array<{
      address: string;
      status: string;
      authorities?: { mint?: { holder: string | null } };
    }>;
  };
  const by = new Map<string, number>();
  for (const a of list.assets) {
    if (a.status !== 'listed' && a.status !== 'candidate') continue;
    if (DA15_NOT_WALKED.has(a.address)) continue;
    const h = a.authorities?.mint?.holder;
    if (h) by.set(h, (by.get(h) ?? 0) + 1);
  }
  return [...by.entries()].map(([holder, tokens]) => ({ holder, tokens }));
}

async function solanaCount(kind: 'swaps' | 'mints') {
  const { regFile, pools, mints, registryMints, trackedMints, list } = solanaSubjects();
  // the mints outside the registry's stock tokens are sampled one in `--mint-every` and scaled
  const mintEvery = Number(opt('--mint-every') ?? 10);
  const otherMints = mints.filter((m) => !registryMints.has(m));
  const nowT = Math.floor(Date.now() / 1000);
  const anc = anchors(RISK, nowT, { windowDays: 90, stepDays: 15, oldest: '2025-06-25' });
  const dustEvery = Number(opt('--dust-every') ?? 20);
  const live = pools.filter((p) => p.tier !== 'X');
  const dust = pools.filter((p) => p.tier === 'X');
  const dustSample = dust.filter((_, i) => i % dustEvery === 0);
  const subjects =
    kind === 'swaps'
      ? [
          ...live.map((p) => ({ address: p.address, group: 'live' as const, p })),
          ...dustSample.map((p) => ({ address: p.address, group: 'dust' as const, p })),
        ]
      : opt('--via') === 'authority'
        ? authoritiesOf(opt('--sol-list') ?? 'scripts/risk/assets/solana.json').map((a) => ({
            address: a.holder,
            group: 'mint_authority' as const,
            p: null,
            tokens: a.tokens,
          }))
        : [
            ...mints
              .filter((m) => registryMints.has(m))
              .map((m) => ({
                address: m,
                group: trackedMints.has(m) ? ('tracked' as const) : ('registry_stock' as const),
                p: null,
              })),
            ...otherMints
              .filter((_, i) => i % mintEvery === 0)
              .map((m) => ({ address: m, group: 'other_sampled' as const, p: null })),
          ];
  const parallel = Number(opt('--parallel') ?? 12);
  const jobs = subjects.flatMap((s) => anc.map((a) => ({ s, a })));
  const tc = Date.now();
  let pageBytes = 0;
  const pages = await pool(jobs, parallel, async ({ s, a }) => {
    const got = await anchoredPage(solRpc as never, s.address, a, SOL_LIMIT);
    pageBytes += got.bytes;
    return { address: s.address, page: got.page };
  });
  // an address older than the oldest anchor (no page reached its first transaction): quarterly anchors from
  // blocks, back from 2025-03 to 2020-04, until a page reaches it
  const reached = new Set(
    pages.filter((r) => r.page.exhausted || r.page.n === 0).map((r) => r.address),
  );
  const older = subjects.filter((x) => !reached.has(x.address));
  const deepDates: number[] = [];
  for (
    let d = new Date('2025-03-15T12:00:00Z');
    d >= new Date('2020-04-15T00:00:00Z');
    d.setUTCMonth(d.getUTCMonth() - 3)
  )
    deepDates.push(Math.floor(d.getTime() / 1000));
  const lend = anc.find((a) => a.signature && a.from.startsWith('lending-history'));
  let deep: Anchor[] = [];
  if (older.length && lend) {
    const ref = await solRpc<Array<{ slot: number; blockTime: number }>>(
      'getSignaturesForAddress',
      [older[0]?.address, { limit: 1, before: lend.signature }],
    );
    const r0 = ref[0];
    if (r0)
      deep = await blockAnchors(solRpc as never, { slot: r0.slot, t: r0.blockTime }, deepDates);
  }
  await pool(older, parallel, async (x) => {
    for (const a of deep) {
      const got = await anchoredPage(solRpc as never, x.address, a, SOL_LIMIT);
      pageBytes += got.bytes;
      pages.push({ address: x.address, page: got.page });
      if (got.page.exhausted || got.page.n === 0) break;
    }
  });
  const callSeconds = (Date.now() - tc) / 1000;
  const byAddr = new Map<string, AnchoredPage[]>();
  for (const r of pages) byAddr.set(r.address, [...(byAddr.get(r.address) ?? []), r.page]);
  const d90 = nowT - 90 * DAY;
  // Step 5b's measured bytes a transaction (decoded rows, data/risk/history-full/events), gzipped as the
  // fetch writes them: from three day files of different pools
  const sample = [
    '6truu3rZuiB9rKQg4VYC3Dt3QwV7DgwGqXrYUcrvnDDE/2026-09-20.jsonl',
    'GYqHjuDzTiw7i52Xv1qohDE6eJr6eSZpsrBVikGZyaFV/2026-09-20.jsonl',
    'FCn5zw4gAcfRpQgst5ThFuzBGXbbJ6RocVErgC4vJ9j1/2026-09-20.jsonl',
  ];
  let sRows = 0;
  let sBytes = 0;
  let sGz = 0;
  for (const f of sample) {
    const p = join(RISK, 'history-full', 'events', f);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, 'utf8');
    sRows += text.split('\n').filter(Boolean).length;
    sBytes += text.length;
    sGz += gzipSync(text).length;
  }
  const rowBytes = sRows ? sBytes / sRows : 330;
  const gzPerTx = sRows ? sGz / sRows : 110;
  const per = subjects.map((s) => {
    const ps = byAddr.get(s.address) ?? [];
    // the oldest time any page reached: an address no page saw begin is counted from there (said in the row)
    const lifeFrom = Math.min(...ps.map((p) => p.oldest ?? p.t));
    const w90 = estimateSignatures(ps, d90, nowT);
    const life = estimateSignatures(ps, lifeFrom, nowT);
    const beyond = estimateSignatures(ps, lifeFrom, d90);
    const first = life.firstSeen ?? Math.min(...anc.map((a) => a.t));
    const sampled =
      kind === 'swaps' && s.group !== 'mint_authority'
        ? estimateSampled(
            ps,
            Math.max(first, Math.min(...anc.map((a) => a.t))),
            d90,
            Number(opt('--per-hour') ?? 30),
          )
        : { fetched: 0, hours: 0 };
    return {
      address: s.address,
      group: s.group,
      symbol: s.p?.assetSymbol ?? null,
      venue: s.p?.venue ?? null,
      tier: s.p?.tier ?? null,
      firstSeen: life.firstSeen ? new Date(life.firstSeen * 1000).toISOString() : null,
      countedFrom: Number.isFinite(lifeFrom) ? new Date(lifeFrom * 1000).toISOString() : null,
      failedShare: +life.failedShare.toFixed(3),
      sigs90: Math.round(w90.signatures),
      sigsBeyond90: Math.round(beyond.signatures),
      sigsLife: Math.round(life.signatures),
      sampledBeyond90: Math.round(sampled.fetched),
      activeHoursBeyond90: sampled.hours,
      // the reads themselves, so the estimate can be made again without asking
      pages: ps.map((p) => [p.t, p.n, p.newest, p.oldest, p.failed, p.exhausted ? 1 : 0]),
    };
  });
  const scale = (g: string) =>
    g === 'dust'
      ? dustEvery
      : g === 'other_sampled'
        ? otherMints.length / Math.ceil(otherMints.length / mintEvery)
        : 1;
  const tot = (k: 'sigs90' | 'sigsBeyond90' | 'sigsLife' | 'sampledBeyond90', g?: string) =>
    per.filter((r) => !g || r.group === g).reduce((a, r) => a + r[k] * scale(r.group), 0);
  const ok = (k: 'sigs90' | 'sigsBeyond90' | 'sigsLife') =>
    per.reduce((a, r) => a + r[k] * (1 - r.failedShare) * scale(r.group), 0);
  // calibration: the 34 value pools' walk of Step 5b is exact over its own span; the same estimator over it
  const calib: Array<Record<string, unknown>> = [];
  const exactFile = opt('--exact');
  if (kind === 'swaps' && exactFile && existsSync(exactFile))
    for (const l of readFileSync(exactFile, 'utf8').split('\n').filter(Boolean)) {
      const [address, n, failed, oldest, newest] = l.trim().split(/\s+/);
      const ps = byAddr.get(address as string);
      if (!ps) continue;
      const est = estimateSignatures(ps, Number(oldest), Number(newest)).signatures;
      calib.push({
        address,
        exact: Number(n),
        failed: Number(failed),
        estimate: Math.round(est),
        ratio: +(est / Number(n)).toFixed(3),
      });
    }
  const ratios = calib.map((c) => c.ratio as number).sort((a, b) => a - b);
  const calibration = calib.length
    ? {
        pools: calib.length,
        exactTotal: calib.reduce((a, c) => a + (c.exact as number), 0),
        estimateTotal: calib.reduce((a, c) => a + (c.estimate as number), 0),
        medianRatio: ratios[Math.floor(ratios.length / 2)],
        p10: ratios[Math.floor(ratios.length * 0.1)],
        p90: ratios[Math.floor(ratios.length * 0.9)],
        perPool: calib,
      }
    : null;
  const tx90 = ok('sigs90');
  const txLife = ok('sigsLife');
  const sampledBeyond = tot('sampledBeyond90');
  // calls: signature pages of 1,000, and one getTransaction per successful signature fetched
  const calls =
    kind === 'swaps'
      ? {
          sigPages90: tot('sigs90') / 1000,
          getTransaction90: tx90,
          sigPagesBeyond90: tot('sigsBeyond90') / 1000,
          getTransactionSampled: sampledBeyond,
        }
      : { sigPagesLife: tot('sigsLife') / 1000, getTransactionLife: txLife };
  const gzBytes = kind === 'swaps' ? (tx90 + sampledBeyond) * gzPerTx : txLife * gzPerTx;
  const txRate = Number(opt('--tx-rate') ?? 495);
  const pageRate = Number(opt('--page-rate') ?? 20);
  const hours =
    kind === 'swaps'
      ? {
          at: { txPerSecond: txRate, sigPagesPerSecond: pageRate },
          days90: (tx90 / txRate + tot('sigs90') / 1000 / pageRate) / 3600,
          beyond90: (sampledBeyond / txRate + tot('sigsBeyond90') / 1000 / pageRate) / 3600,
        }
      : {
          at: { txPerSecond: txRate, sigPagesPerSecond: pageRate },
          life: (txLife / txRate + tot('sigsLife') / 1000 / pageRate) / 3600,
        };
  const budget = budgetNow(gzBytes);
  const body = {
    series: kind === 'swaps' ? 'solana-swaps' : 'solana-mints',
    via: kind === 'mints' ? (opt('--via') ?? 'mint') : 'pool',
    chain: 'solana',
    countedAt: new Date().toISOString(),
    methodVersion: BACKFILL_METHOD_VERSION,
    rpc: process.env.SOLANA_RPC_URL
      ? 'SOLANA_RPC_URL (the risk scripts’ RPC)'
      : 'the public mainnet-beta endpoint',
    registry: regFile,
    list: list ?? 'none committed: every stock token of the registry, tracked or candidate (DA16)',
    subjects: {
      pools:
        kind === 'swaps'
          ? {
              live: live.length,
              dust: dust.length,
              dustSampled: dustSample.length,
              dustScale: dustEvery,
            }
          : undefined,
      mints:
        kind === 'mints'
          ? {
              walked: mints.length,
              tracked: per.filter((r) => r.group === 'tracked').length,
              registryStocks: per.filter((r) => r.group === 'registry_stock').length,
              others: otherMints.length,
              othersSampled: per.filter((r) => r.group === 'other_sampled').length,
            }
          : undefined,
    },
    window: { now: new Date(nowT * 1000).toISOString(), day90: new Date(d90 * 1000).toISOString() },
    anchors: anc,
    deepAnchors: { subjects: older.length, anchors: deep },
    method: `anchored pages: getSignaturesForAddress(address, { before: <anchor>, limit: ${SOL_LIMIT} }) at ${anc.length} anchors (now, every 15 days to day 90, monthly to 2025-06-25), each page's mean rate at the middle of what it covers, linear between pages, nothing before an exhausted page's oldest signature (estimateSignatures); the dust pools (tier X) sampled one in ${dustEvery} and the mints outside the registry's stock tokens one in ${mintEvery}, each scaled; successful transactions are the signatures less the pages' failed share; bytes are Step 5b's decoded rows gzipped (${rowBytes.toFixed(0)} B a row, ${gzPerTx.toFixed(0)} B gzipped, from three day files)`,
    estimate: {
      signatures90: Math.round(tot('sigs90')),
      transactions90: Math.round(tx90),
      signaturesBeyond90: Math.round(tot('sigsBeyond90')),
      sampledBeyond90: Math.round(sampledBeyond),
      signaturesLife: Math.round(tot('sigsLife')),
      transactionsLife: Math.round(txLife),
      byGroup: Object.fromEntries(
        [...new Set(per.map((r) => r.group))].map((g) => [
          g,
          { sigs90: Math.round(tot('sigs90', g)), sigsLife: Math.round(tot('sigsLife', g)) },
        ]),
      ),
      gzBytes,
      gzGB: +(gzBytes / GB).toFixed(2),
      bytesPerTx: { row: +rowBytes.toFixed(1), gz: +gzPerTx.toFixed(1) },
    },
    calls,
    hours,
    measured: {
      pages: pages.length,
      pageBytes,
      callSeconds,
      pagesPerSecond: +(pages.length / callSeconds).toFixed(1),
      rpc: rpcStats,
    },
    calibration,
    budget,
    perSubject: per.sort((a, b) => b.sigs90 - a.sigs90),
  };
  const f = writeCount(body);
  return finish({
    count: f,
    estimate: { ...body.estimate, byGroup: undefined },
    hours,
    calibration: calibration && { ...calibration, perPool: undefined },
    fits: budget.fits,
  });
}

async function solanaFetch(kind: 'swaps' | 'mints') {
  const { pools } = solanaSubjects();
  const address = opt(kind === 'swaps' ? '--pool' : '--mint');
  if (all)
    throw new Error('--all on Solana: run per pool from the count file (not run by this session)');
  if (!address) throw new Error(`--${kind === 'swaps' ? 'pool' : 'mint'} <address> is needed`);
  const [a, b] = (opt('--window') as string)
    .split('..')
    .map((x) => Math.floor(Date.parse(x) / 1000));
  if (!a || !b || b <= a) throw new Error('--window <fromISO>..<toISO>');
  const p = pools.find((x) => x.address === address);
  if (kind === 'swaps' && !p) throw new Error(`${address} is not a registry pool of the list`);
  guard(0);
  const res = await fetchWindow({
    rpc: solRpc as never,
    out: join(OUT, 'solana'),
    kind,
    address,
    ...(p ? { pool: p } : {}),
    from: a,
    to: b,
    parallel: Number(opt('--parallel') ?? 32),
    ...(opt('--per-hour') ? { perHour: Number(opt('--per-hour')) } : {}),
    // a signature just after the window (from a walk on disk), so the walk starts there and not at the head
    ...(opt('--before') ? { startBefore: opt('--before') } : {}),
    source: `Solana RPC getSignaturesForAddress and getTransaction (${process.env.SOLANA_RPC_URL ? 'SOLANA_RPC_URL' : 'public'})${p ? `, decoded by @colosseum/risk's ${p.venue} decoder` : ''}`,
    now: () => new Date(),
  });
  return finish({ fetched: res, rpc: rpcStats });
}

// ---------------------------------------------------------------------------------------------------------------
// External daily series

async function externalDaily() {
  const { rows: rh } = robinhoodList();
  const { mints } = solanaSubjects();
  if (mode === 'count') {
    // a sample of every kind of row: Solana's stock tokens and its two dollars and two others; Robinhood
    // Chain's rows, by DefiLlama's two spellings of the chain
    const { registryMints, trackedMints } = solanaSubjects();
    const stockSample = [...trackedMints].slice(0, 8);
    const registryOnly = [...registryMints].filter((m) => !trackedMints.has(m)).slice(0, 6);
    const others = mints.filter((m) => !registryMints.has(m));
    const otherSample = others
      .filter((_, i) => i % Math.max(1, Math.floor(others.length / 10)) === 0)
      .slice(0, 10);
    const solKeys = [
      ...[...stockSample, ...registryOnly, ...otherSample].map((m) => coinKey('solana', m)),
      coinKey('solana', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
      coinKey('solana', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'),
    ];
    const rhSample = rh.slice(0, 25);
    const rhKeys = [
      ...rhSample.map((r) => coinKey('robinhood', r.address)),
      ...rhSample.map((r) => coinKey('robinhood-chain', r.address)),
    ];
    const first = await firstPrices([...solKeys, ...rhKeys]);
    const found = Object.entries(first.coins).filter(([, v]) => v.first);
    // depth: one daily chart from the first price for two Solana tokens
    const depth = [];
    for (const k of [solKeys[0], solKeys.at(-3), rhKeys[0]].filter((x): x is string => !!x)) {
      const f = first.coins[k]?.first;
      if (!f) continue;
      const start = Math.floor(Date.parse(f) / 1000);
      const days = Math.ceil((Date.now() / 1000 - start) / DAY);
      const c = await dailyChart(k, start, days);
      const text = c.prices.map((x) => JSON.stringify(x)).join('\n');
      depth.push({
        key: k,
        first: f,
        days,
        points: c.prices.length,
        requests: c.requests,
        bytes: c.bytes,
        gzBytesPerPoint: c.prices.length ? gzipSync(text).length / c.prices.length : null,
        ms: c.ms,
      });
    }
    const protocols = [];
    for (const slug of ['kamino-lend', 'jupiter-lend', 'maple', 'ondo-finance', 'mellow-lrt']) {
      const r = await protocolTvl(slug);
      protocols.push({ ...r, tvl: undefined });
    }
    // per row of the lists: the share of the sample with a price, its mean days since the first price, the
    // measured gzip bytes a point, and one request every CHART_SPAN_DAYS days
    const share = found.length / Math.max(1, Object.keys(first.coins).length);
    const nowS = Date.now() / 1000;
    const meanDays =
      found.reduce((a, [, v]) => a + (nowS - Date.parse(v.first as string) / 1000) / DAY, 0) /
      Math.max(1, found.length);
    const gzPerPoint =
      depth
        .filter((d) => d.gzBytesPerPoint !== null)
        .reduce((a, d) => a + (d.gzBytesPerPoint as number), 0) /
      Math.max(1, depth.filter((d) => d.gzBytesPerPoint !== null).length);
    const rowsTotal = mints.length + rh.length;
    const points = rowsTotal * share * meanDays;
    const gzBytes = points * gzPerPoint;
    const chartRequests = rowsTotal * share * Math.ceil(meanDays / CHART_SPAN_DAYS);
    const body = {
      series,
      countedAt: new Date().toISOString(),
      methodVersion: BACKFILL_METHOD_VERSION,
      method:
        'DefiLlama, free and without a key: /prices/first for a sample of every kind of row (when its first price is), /chart from it at period=1d for two rows (how many daily points), /protocol/<slug> for five protocols (TVL points and first date)',
      sample: {
        asked: Object.keys(first.coins).length,
        withPrice: found.length,
        solana: found.filter(([k]) => k.startsWith('solana:')).map(([k, v]) => ({ key: k, ...v })),
        robinhood: found
          .filter(([k]) => !k.startsWith('solana:'))
          .map(([k, v]) => ({ key: k, ...v })),
        robinhoodAsked: rhKeys.length,
      },
      depth,
      protocols,
      rows: { solana: mints.length, robinhood: rh.length },
      estimate: {
        rows: rowsTotal,
        withPriceShare: +share.toFixed(3),
        meanDaysSinceFirstPrice: Math.round(meanDays),
        points: Math.round(points),
        gzBytesPerPoint: +gzPerPoint.toFixed(1),
        gzBytes,
        requests: Math.round(chartRequests + rowsTotal / 50),
        hoursAtOneRequestASecond: +((chartRequests + rowsTotal / 50) / 3600).toFixed(2),
        note: 'a first price far older than the chain is the price of the token the row is mapped to (DefiLlama prices a bridged or wrapped token by its source), not of the row itself',
      },
      budget: budgetNow(gzBytes),
      requests: first.requests + depth.reduce((a, d) => a + d.requests, 0) + protocols.length,
    };
    const f = writeCount(body);
    return finish({
      count: f,
      withPrice: found.length,
      asked: Object.keys(first.coins).length,
      protocols: protocols.map((p) => ({
        slug: p.slug,
        status: p.status,
        points: p.points,
        first: p.first,
      })),
    });
  }
  guard(0);
  const out = join(OUT, 'external');
  const at = new Date().toISOString();
  const coin = opt('--coin');
  const protocol = opt('--protocol');
  if (coin) {
    const f = (await firstPrices([coin])).coins[coin]?.first;
    if (!f) throw new Error(`${coin}: no price at DefiLlama`);
    const start = Math.floor(Date.parse(f) / 1000);
    const c = await dailyChart(coin, start, Math.ceil((Date.now() / 1000 - start) / DAY));
    const w = writeSeries(
      out,
      coin,
      c.prices,
      `DefiLlama coins ${coin} /chart period=1d`,
      { from: start, to: Math.floor(Date.now() / 1000) },
      at,
    );
    return finish({ fetched: { coin, first: f, ...w, ms: c.ms } });
  }
  if (protocol) {
    const r = await protocolTvl(protocol);
    const w = writeSeries(
      out,
      `protocol:${protocol}`,
      r.tvl,
      `DefiLlama /protocol/${protocol} tvl`,
      { from: Date.parse(r.first ?? at) / 1000, to: Date.parse(r.last ?? at) / 1000 },
      at,
    );
    return finish({ fetched: { protocol, first: r.first, last: r.last, ...w, ms: r.ms } });
  }
  throw new Error('--coin or --protocol (a whole series needs --all, not run by this session)');
}

const run = {
  'robinhood-logs': robinhoodLogs,
  'chainlink-rounds': chainlinkRounds,
  'solana-swaps': () => (mode === 'count' ? solanaCount('swaps') : solanaFetch('swaps')),
  'solana-mints': () => (mode === 'count' ? solanaCount('mints') : solanaFetch('mints')),
  'external-daily': externalDaily,
}[series];
try {
  const r = await run();
  console.log(JSON.stringify(r).slice(0, 4000));
} catch (e) {
  const r = finish({ error: e instanceof Error ? e.message : String(e) });
  console.error(JSON.stringify(r));
  process.exit(1);
}
