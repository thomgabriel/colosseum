// `tsx scripts/risk/assets/freeze-history-fixture.ts` (PLAN-ASSETS AS.13): a few real rows of the backfill's files
// into fixtures/risk/assets/history/, laid out as ASSETS_DATA_DIR lays them out, for
// tests/risk-layer/assets-history-import.test.ts. Reads ASSETS_DATA_DIR (the main checkout's data/assets), the
// shelf registry (--registry) and RU.2's creation logs (RISK_EVM_DIR); asks no endpoint. What is cut:
//   Solana     AAVE's three registry pools (USDC, SOL, GHOSTCAT), 2026-10-07 00:00 to 05:59 (a day the manifests
//              hold whole) and the first rows of 2026-10-06 (a day they do not); JTO's SOL pool alone, with JTO's
//              other pools left out of the frozen registry, so no USDC pool prices it (the `none:` case).
//   Robinhood  four NVDA pools (two against USDG, one against WETH, one against ETH) and one pool the creation
//              logs do not name (its first rows of the day), two pools resolved from the chain since
//              (pool-tokens.json: an NVDA pool against an unlisted token, an id no position manager knows),
//              2026-10-11 14:00 to 15:59 and the first rows of 2026-10-10 and 2026-10-13; their manifests,
//              fetched.json and the shelf's count file as they are.
//   Chainlink  NVDA's feed, its first two days of rounds and its manifest.
//   External   one Solana coin, one Robinhood Chain coin and one protocol, their last 12 points each.
// Manifests are copied as they are (their covered windows and days are the real ones).
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { gzLines } from './bars-backfill';

const SRC = process.env.ASSETS_DATA_DIR ?? 'data/assets';
const EVM = process.env.RISK_EVM_DIR ?? 'data/risk-evm';
const OUT = 'fixtures/risk/assets/history';
const args = process.argv.slice(2);
const registryFile = args[args.indexOf('--registry') + 1] as string;

const put = (rel: string, text: string, gz = false) => {
  const f = join(OUT, rel);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, gz ? gzipSync(text) : text);
};
const copy = (rel: string) => {
  mkdirSync(dirname(join(OUT, rel)), { recursive: true });
  copyFileSync(join(SRC, rel), join(OUT, rel));
};
const cut = (rel: string, keep: (l: string, i: number) => boolean) => {
  const lines = [...gzLines(join(SRC, rel))].filter(keep);
  put(rel, `${lines.join('\n')}\n`, true);
  return lines.length;
};
const inHours = (from: string, to: string) => (l: string) => {
  const t = (JSON.parse(l) as { t: number }).t;
  return t >= Date.parse(from) / 1000 && t < Date.parse(to) / 1000;
};

// Solana
const AAVE = [
  '6k7hLzFcL3H64uziJboN3WZNXYj6PiBMP1DZh8zFfhSb',
  '9kf9wUh4Z8r49TD1utiat8obz9iWs12m38KeK1g5ADju',
  'DTm2scPFBDUT3RE5Kc3Z8oUJPusKWk7gsFgJ2iZwhG99',
];
const JTO_SOL = '2UhFnySoJi6c89aydGAGS7ZRemo2dbkFRhvSJqDX4gHJ';
const JTO_JITOSOL = 'G2FiE1yn9N9ZJx5e1E2LxxMnHvb1H3hCuHLPfKJ98smA';
const counts: Record<string, number> = {};
for (const p of AAVE) {
  copy(`solana/swaps/${p}/manifest.json`);
  counts[`${p}/2026-10-07`] = cut(
    `solana/swaps/${p}/2026-10-07.jsonl.gz`,
    inHours('2026-10-07T00:00:00Z', '2026-10-07T06:00:00Z'),
  );
  counts[`${p}/2026-10-06`] = cut(`solana/swaps/${p}/2026-10-06.jsonl.gz`, (_, i) => i < 5);
}
for (const p of [JTO_SOL, JTO_JITOSOL]) {
  copy(`solana/swaps/${p}/manifest.json`);
  counts[`${p}/2026-10-07`] = cut(
    `solana/swaps/${p}/2026-10-07.jsonl.gz`,
    inHours('2026-10-07T00:00:00Z', '2026-10-07T02:00:00Z'),
  );
}
const reg = JSON.parse(readFileSync(registryFile, 'utf8')) as {
  pools: Array<Record<string, unknown> & { address: string }>;
};
put(
  'shelf-registry-solana.json',
  `${JSON.stringify(
    {
      source: `${registryFile.split('/').at(-1)}, cut to AAVE's three pools and JTO's SOL and JitoSOL pools`,
      pools: reg.pools.filter((p) => [...AAVE, JTO_SOL, JTO_JITOSOL].includes(p.address)),
    },
    null,
    1,
  )}\n`,
);

// Robinhood Chain
const RH = [
  '0x6444a8e0b267406a15db74ca00c4a24bdfa81ed3180f5b6d0851f8ed6f4f29c5',
  '0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3',
  '0x62ab521f71431f78ac374cdbadc6cda3c8916b6c',
  '0x71f9660f9535e3e81d720696a58ea80274da8b2c6eb7c3acb22611d977439a5c',
];
const creation = JSON.parse(readFileSync(join(EVM, 'creation-logs-robinhood.json'), 'utf8')) as {
  created: Array<{ id: string }>;
};
const known = new Set(creation.created.map((c) => c.id.toLowerCase()));
const fetchedFile = JSON.parse(
  readFileSync(join(SRC, 'robinhood', 'fetched.json'), 'utf8'),
) as object;
const unknown = readdirSync(join(SRC, 'robinhood', 'swaps')).find(
  (s) => !known.has(s) && existsSync(join(SRC, 'robinhood', 'swaps', s, '2026-10-11.jsonl.gz')),
) as string;
// resolved from the chain since (resolve-pools.ts): an NVDA pool against a token the list does not hold, and an
// id the position manager does not know
const RESOLVED_NVDA = '0x3daec59627656f66048c7c2bcfd4d582d293d43f3fa85a57d093882edb8c997a';
const NOT_A_POOL = '0x001ded79b93e9a3306207fe0645de2ddee5747aee6a8938a220e6adc35cad53c';
const tokensFile = JSON.parse(readFileSync(join(SRC, 'robinhood', 'pool-tokens.json'), 'utf8')) as {
  pools: Record<string, unknown>;
} & Record<string, unknown>;
put(
  'robinhood/pool-tokens.json',
  `${JSON.stringify(
    {
      ...tokensFile,
      pools: Object.fromEntries(
        [unknown, RESOLVED_NVDA, NOT_A_POOL].map((k) => [k, tokensFile.pools[k]]),
      ),
    },
    null,
    1,
  )}\n`,
);
for (const p of [...RH, unknown, RESOLVED_NVDA, NOT_A_POOL]) {
  copy(`robinhood/swaps/${p}/manifest.json`);
  counts[`${p}/2026-10-11`] = cut(
    `robinhood/swaps/${p}/2026-10-11.jsonl.gz`,
    p === unknown || p === NOT_A_POOL || p === RESOLVED_NVDA
      ? (_, i) => i < 5
      : inHours('2026-10-11T14:00:00Z', '2026-10-11T16:00:00Z'),
  );
  // the first rows of the day before and of the newest day (still being fetched: never whole)
  for (const d of ['2026-10-10', '2026-10-13'])
    if (existsSync(join(SRC, 'robinhood', 'swaps', p, `${d}.jsonl.gz`)))
      counts[`${p}/${d}`] = cut(`robinhood/swaps/${p}/${d}.jsonl.gz`, (_, i) => i < 3);
}
put('robinhood/fetched.json', JSON.stringify(fetchedFile));
const countDir = join(SRC, 'robinhood', 'robinhood-logs');
const count = readdirSync(countDir)
  .filter((f) => f.startsWith('count-'))
  .sort()
  .reverse()
  .map(
    (f) =>
      JSON.parse(readFileSync(join(countDir, f), 'utf8')) as { scope?: string; scopeOf?: unknown },
  )
  .find((c) => c.scope?.startsWith('shelf-')) as { scope: string; scopeOf: unknown };
put(
  'robinhood/robinhood-logs/count-fixture.json',
  `${JSON.stringify({ scope: count.scope, scopeOf: count.scopeOf }, null, 1)}\n`,
);
put(
  'creation-logs-robinhood.json',
  `${JSON.stringify({ created: creation.created.filter((c) => RH.includes(c.id.toLowerCase())) }, null, 1)}\n`,
);

// Chainlink: NVDA's feed
const FEED = '0x379ec4f7c378f34a1b47e4f3cbebcbac3e8e9f15';
copy(`robinhood/chainlink/${FEED}/manifest.json`);
const feedDays = readdirSync(join(SRC, 'robinhood', 'chainlink', FEED))
  .filter((f) => f.endsWith('.jsonl.gz'))
  .sort()
  .slice(0, 2);
for (const d of feedDays)
  counts[`${FEED}/${d}`] = cut(`robinhood/chainlink/${FEED}/${d}`, () => true);

// External
const ext = readdirSync(join(SRC, 'external'));
const picks = [
  ext.find((s) => s.startsWith('solana_XsbEhLAt')),
  ext.find((s) => s === `robinhood_${'0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec'}`),
  'protocol_kamino-lend',
].filter((s): s is string => !!s);
for (const s of picks) {
  copy(`external/${s}/manifest.json`);
  const all = [...gzLines(join(SRC, 'external', s, 'daily.jsonl.gz'))];
  const keep = new Set(all.slice(-12));
  counts[s] = cut(`external/${s}/daily.jsonl.gz`, (l) => keep.has(l));
}
console.log(JSON.stringify({ out: OUT, unknownPool: unknown, feedDays, picks, counts }, null, 1));
