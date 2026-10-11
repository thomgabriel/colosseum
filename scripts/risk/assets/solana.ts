import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createDb, riskLendingPools } from '@colosseum/db';
import { decodeMint, METAPLEX_METADATA_PROGRAM } from '@colosseum/risk';
import { type UniverseRead, UniverseVerdicts } from '@colosseum/schemas';
import { address, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { rpc, rpcStats } from '../lib-pools';
import {
  type B64Account,
  type Built,
  type ChainRead,
  candidates,
  ISSUER_MINTS_FILE,
  type IssuerPage,
  type JupiterRow,
  LEFT_OUT_FILE,
  LeftOut,
  type LendingRow,
  type NamedBy,
  readsFileName,
  SELECTION_FLOOR_USD,
  type SolanaReads,
  solanaList,
  VERDICTS_FILE,
} from './solana-list';
import { FILES, repoInputs } from './solana-repo';

// The Solana builder of `pnpm risk:assets solana` (PLAN-ASSETS AS.2). All the I/O is here; the list is
// made by solana-list.ts from what this saves, so a run can be rebuilt with no network.
//   pnpm risk:assets solana [--registry <data/risk/registry-*.json>] [--reads-dir <dir>] [--db <url>]
//   pnpm risk:assets solana --from <solana-reads-*.json[.gz]>      rebuild from saved reads, no network
// Read-only: public GETs (Jupiter's lite API, DefiLlama, the issuers' pages), getMultipleAccounts on
// mainnet through SOLANA_RPC_URL (rpc() of ../lib-pools, with its backoff), one SELECT on the local
// database. The reads are saved to --reads-dir (default data/assets/solana), never committed; freeze
// them for the test with `pnpm risk:freeze-assets-solana <reads.json>`.

const JUPITER = 'https://lite-api.jup.ag/tokens/v2/tag?query=verified';
const LLAMA_STABLES = 'https://stablecoins.llama.fi/stablecoins?includePrices=false';
const LLAMA_PROTOCOLS = 'https://api.llama.fi/protocols';
const LLAMA_CATEGORIES = new Set(['RWA', 'Yield', 'Yield Aggregator']);
const COINGECKO_LIST = 'https://api.coingecko.com/api/v3/coins/list?include_platform=true';
const LOCAL_DB = 'postgres://colosseum:colosseum@localhost:5433/colosseum';
const REGISTRY_DEFAULT = 'data/risk/registry-20261001T0139.json';
const arg = (args: string[], name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const now = () => new Date().toISOString();

/** Loads saved reads, gzipped or not. */
export function loadReads(path: string): SolanaReads {
  const raw = readFileSync(path);
  return JSON.parse((path.endsWith('.gz') ? gunzipSync(raw) : raw).toString()) as SolanaReads;
}

export const loadVerdicts = () => UniverseVerdicts.parse(json(VERDICTS_FILE));
export const loadLeftOut = () => LeftOut.parse(json(LEFT_OUT_FILE));

export async function buildList(args: string[]): Promise<Built> {
  const verdicts = loadVerdicts();
  const from = arg(args, '--from');
  const leftOut = loadLeftOut();
  if (from) return solanaList(loadReads(from), verdicts, leftOut);
  const reads = await readAll(args, verdicts);
  const dir = arg(args, '--reads-dir') ?? 'data/assets/solana';
  mkdirSync(dir, { recursive: true });
  const out = join(dir, readsFileName(reads.startedAt));
  writeFileSync(`${out}.tmp`, JSON.stringify(reads));
  renameSync(`${out}.tmp`, out);
  const built = solanaList(reads, verdicts, leftOut);
  return { list: built.list, lines: [`reads saved: ${out}`, ...built.lines] };
}

/** One timed read: what it called, how many calls and rows, how long, how many errors. */
async function timed<T>(
  name: string,
  what: string,
  fn: () => Promise<{ value: T; calls: number; rows: number; errors?: number }>,
  log: UniverseRead[],
): Promise<T> {
  const at = now();
  const t0 = Date.now();
  const r = await fn();
  log.push({
    name,
    what,
    at,
    calls: r.calls,
    durationMs: Date.now() - t0,
    rows: r.rows,
    errors: r.errors ?? 0,
  });
  return r.value;
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  return res.json();
}

export async function readAll(args: string[], verdicts: UniverseVerdicts): Promise<SolanaReads> {
  const startedAt = now();
  const log: UniverseRead[] = [];
  const named: Record<string, Set<NamedBy>> = {};
  const name = (a: string, by: NamedBy) => {
    named[a] ??= new Set();
    named[a].add(by);
  };

  // 1. Jupiter's verified list, every tag kept, cut to the identity fields
  const jupiter = await timed<JupiterRow[]>(
    'jupiter_verified',
    `GET ${JUPITER}`,
    async () => {
      const rows = (await getJson(JUPITER)) as Array<{
        id: string;
        symbol?: string;
        tags?: string[];
        stats24h?: { buyVolume?: number; sellVolume?: number };
      }>;
      // the volume picks a token for the crypto selection and is dropped here: no figure is saved
      const picked = (t: (typeof rows)[number]) =>
        (t.tags ?? []).some((g) => g === 'major' || g === 'strict') ||
        (t.stats24h?.buyVolume ?? 0) + (t.stats24h?.sellVolume ?? 0) >= SELECTION_FLOOR_USD;
      const value = rows
        .map((t) => ({ id: t.id, symbol: t.symbol ?? '', tags: t.tags ?? [], selected: picked(t) }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return { value, calls: 1, rows: value.length };
    },
    log,
  );

  // 2. the reserves the lending import knows (read-only SELECT on the local database)
  const lending = await timed<LendingRow[]>(
    'lending_reserves',
    'SELECT * FROM risk_lending_pools (local Postgres)',
    async () => {
      const { db, client } = createDb(arg(args, '--db') ?? LOCAL_DB);
      try {
        const rows = await db.select().from(riskLendingPools);
        const value = rows
          .map((r) => {
            const o = (r.oracles ?? {}) as {
              scopePriceFeed?: string;
              scopePriceChain?: number[];
              scopeTwapChain?: number[];
            };
            return {
              account: r.account,
              venue: r.venue,
              marketName: r.marketName,
              role: r.role,
              mint: r.mint,
              symbol: r.symbol,
              debtMint: r.debtMint,
              debtSymbol: r.debtSymbol,
              scope:
                o.scopePriceFeed && o.scopePriceChain
                  ? {
                      feed: o.scopePriceFeed,
                      price: o.scopePriceChain.filter((x) => x !== 65535),
                      twap: (o.scopeTwapChain ?? []).filter((x) => x !== 65535),
                    }
                  : null,
              fetchedAt: new Date(r.fetchedAt).toISOString(),
              provenance: r.provenance,
            };
          })
          .sort((a, b) => (a.account < b.account ? -1 : 1));
        return { value, calls: 1, rows: value.length };
      } finally {
        await client.end();
      }
    },
    log,
  );
  for (const l of lending) {
    name(l.mint, 'lending_db');
    if (l.debtMint) name(l.debtMint, 'lending_db');
  }

  // 3. the research note, its shelf fixture and the files of today's shelf
  const repo = repoInputs();
  for (const a of repo.note.addresses) name(a, 'research_note');
  for (const r of repo.shelf.rows) name(r.address, 'shelf_fixture');
  for (const r of repo.seed.rows) name(r.address, 'launch_shelf_seed');
  for (const r of repo.structurer.rows) name(r.mint, 'structurer_registry');
  for (const r of repo.tracked.rows) name(r.address, 'tracked_list');
  for (const r of repo.scope.rows) name(r.mint, 'scope_table');

  // 4. DefiLlama's public lists, names only
  const stablecoins = await timed(
    'defillama_stablecoins',
    `GET ${LLAMA_STABLES}`,
    async () => {
      const s = (await getJson(LLAMA_STABLES)) as {
        peggedAssets: Array<{ symbol: string; name: string; pegType: string; chains?: string[] }>;
      };
      const value = s.peggedAssets
        .filter((p) => (p.chains ?? []).includes('Solana'))
        .map((p) => ({ symbol: p.symbol, name: p.name, peg: p.pegType }));
      return { value, calls: 1, rows: value.length };
    },
    log,
  );
  const protocols = await timed(
    'defillama_protocols',
    `GET ${LLAMA_PROTOCOLS}`,
    async () => {
      const p = (await getJson(LLAMA_PROTOCOLS)) as Array<{
        name: string;
        category?: string;
        chains?: string[];
      }>;
      const value = p
        .filter(
          (x) => (x.chains ?? []).includes('Solana') && LLAMA_CATEGORIES.has(x.category ?? ''),
        )
        .map((x) => ({ name: x.name, category: x.category as string }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return { value, calls: 1, rows: value.length };
    },
    log,
  );

  // 5. the issuers' pages: each page is fetched and searched for the address it is said to print
  const issuerList = json(ISSUER_MINTS_FILE) as {
    mints: Array<Omit<IssuerPage, 'answered' | 'namesAddress'>>;
  };
  const issuerPages = await timed<IssuerPage[]>(
    'issuer_pages',
    `GET each page of ${ISSUER_MINTS_FILE}, searched for the mint`,
    async () => {
      const pages = new Map<string, string | null>();
      let errors = 0;
      for (const url of new Set(issuerList.mints.map((m) => m.url))) {
        try {
          const res = await fetch(url, {
            signal: AbortSignal.timeout(30_000),
            headers: { 'user-agent': 'Mozilla/5.0 (assets-list read-only check)' },
          });
          pages.set(url, res.ok ? await res.text() : null);
          if (!res.ok) errors++;
        } catch {
          pages.set(url, null);
          errors++;
        }
      }
      const value = issuerList.mints.map((m) => {
        const html = pages.get(m.url) ?? null;
        return { ...m, answered: html !== null, namesAddress: html?.includes(m.address) ?? false };
      });
      return { value, calls: pages.size, rows: value.length, errors };
    },
    log,
  );
  for (const p of issuerPages) name(p.address, 'issuer_page');

  // 6. CoinGecko's coin list: the coin it names for each Solana mint (the source of a new crypto row's mint)
  const coingecko = await timed<SolanaReads['coingecko']>(
    'coingecko_coins_list',
    `GET ${COINGECKO_LIST}`,
    async () => {
      const list = (await getJson(COINGECKO_LIST)) as Array<{
        id: string;
        symbol: string;
        name: string;
        platforms?: Record<string, string | null>;
      }>;
      const wanted = new Set([
        ...jupiter.filter((t) => t.selected).map((t) => t.id),
        ...verdicts.verdicts.map((v) => v.address),
      ]);
      const byMint: SolanaReads['coingecko']['byMint'] = {};
      for (const c of list) {
        const mint = c.platforms?.solana;
        if (mint && wanted.has(mint)) byMint[mint] = { id: c.id, symbol: c.symbol, name: c.name };
      }
      const sorted = Object.fromEntries(
        Object.entries(byMint).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
      return { value: { what: COINGECKO_LIST, byMint: sorted }, calls: 1, rows: list.length };
    },
    log,
  );

  // 7. every candidate's mint, then the Metaplex account of each mint holding no metadata of its own
  const namedSorted = Object.fromEntries(
    Object.entries(named)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([a, s]) => [a, [...s].sort()]),
  ) as Record<string, NamedBy[]>;
  const want = candidates(jupiter, namedSorted, verdicts);
  const mints = await timed<Record<string, ChainRead>>(
    'mint_accounts',
    'getMultipleAccounts on mainnet (SOLANA_RPC_URL), 100 a call, base64',
    async () => {
      const before = rpcStats.calls;
      const value = await readAccounts(want);
      const rows = Object.values(value).filter((v) => v.account).length;
      return { value, calls: rpcStats.calls - before, rows };
    },
    log,
  );
  const enc = getAddressEncoder();
  const needMeta: Array<{ mint: string; pda: string }> = [];
  for (const a of want) {
    const acc = mints[a]?.account;
    if (!acc) continue;
    let own = false;
    try {
      const m = decodeMint(acc.owner, Buffer.from(acc.data, 'base64'));
      own = !!m.tokenMetadata && m.tokenMetadata.mint === a && m.tokenMetadata.symbol.length > 0;
    } catch {
      continue; // not a mint: nothing to look up
    }
    if (own) continue;
    const [pda] = await getProgramDerivedAddress({
      programAddress: address(METAPLEX_METADATA_PROGRAM),
      seeds: ['metadata', enc.encode(address(METAPLEX_METADATA_PROGRAM)), enc.encode(address(a))],
    });
    needMeta.push({ mint: a, pda });
  }
  const metaplex = await timed<Record<string, ChainRead & { pda: string }>>(
    'metaplex_metadata',
    'getMultipleAccounts on the Metaplex metadata address of each mint with no tokenMetadata of its own',
    async () => {
      const before = rpcStats.calls;
      const got = await readAccounts(needMeta.map((m) => m.pda));
      const value: Record<string, ChainRead & { pda: string }> = {};
      for (const m of needMeta) value[m.mint] = { ...(got[m.pda] as ChainRead), pda: m.pda };
      const rows = Object.values(value).filter((v) => v.account).length;
      return { value, calls: rpcStats.calls - before, rows };
    },
    log,
  );

  // 8. the pools the registry file knows for each candidate
  const registryPath = arg(args, '--registry') ?? REGISTRY_DEFAULT;
  const registryName = `data/risk/${registryPath.split('/').pop()}`;
  const registry = await timed(
    'pool_registry',
    `${registryName} (pnpm risk:registry), pools per mint on either side`,
    async () => {
      const reg = json(registryPath) as {
        fetchedAt: string;
        pools: Array<{ mint0: string; mint1: string }>;
      };
      const wanted = new Set(want);
      const pools: Record<string, number> = {};
      for (const p of reg.pools)
        for (const m of new Set([p.mint0, p.mint1]))
          if (wanted.has(m)) pools[m] = (pools[m] ?? 0) + 1;
      const sorted = Object.fromEntries(
        Object.entries(pools).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
      return {
        value: { file: registryName, fetchedAt: reg.fetchedAt, pools: sorted },
        calls: 0,
        rows: reg.pools.length,
      };
    },
    log,
  );

  return {
    chain: 'solana',
    provenance: 'live',
    startedAt,
    finishedAt: now(),
    inputs: {
      jupiter: JUPITER,
      lending: 'risk_lending_pools (local Postgres, the lending import)',
      note: FILES.note,
      shelf: FILES.shelf,
      defillamaStablecoins: LLAMA_STABLES,
      defillamaProtocols: LLAMA_PROTOCOLS,
      issuerPages: ISSUER_MINTS_FILE,
      registry: registryName,
      tracked: FILES.tracked,
      structurer: FILES.structurer,
      deploy: FILES.deploy,
      scope: FILES.scope,
      content: FILES.content,
      seed: FILES.seed,
      legTypes: FILES.legTypes,
    },
    reads: log,
    jupiter,
    named: namedSorted,
    mints,
    metaplex,
    lending,
    registry,
    llama: { stablecoins, protocols },
    issuerPages,
    coingecko,
    repo,
  };
}

/** getMultipleAccounts in calls of 100; each account keeps the slot and time of its call. */
async function readAccounts(addrs: readonly string[]): Promise<Record<string, ChainRead>> {
  const out: Record<string, ChainRead> = {};
  for (let i = 0; i < addrs.length; i += 100) {
    const batch = addrs.slice(i, i + 100);
    const at = now();
    const r = await rpc<{
      context: { slot: number };
      value: Array<{ owner: string; data: [string, string] } | null>;
    }>('getMultipleAccounts', [batch, { encoding: 'base64', commitment: 'confirmed' }]);
    batch.forEach((a, j) => {
      const v = r.value[j];
      const account: B64Account = v ? { owner: v.owner, data: v.data[0] } : null;
      out[a] = { slot: r.context.slot, at, account };
    });
  }
  return out;
}
