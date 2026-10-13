import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type CategoryMembers, MEME_CATEGORIES, PROTOCOL_CATEGORIES } from './solana-list';

// The members of CoinGecko's meme and protocol categories (MEME_CATEGORIES, PROTOCOL_CATEGORIES in
// solana-list.ts), the data the Solana list's meme and protocol calls are made from (PLAN-ASSETS AS.2).
// Keyless and slow (CoinGecko allows a few calls a minute without a key), so it is its own command,
// resumable; the list's build takes its file (--categories) and freezes it with the reads.
//   tsx scripts/risk/assets/coingecko-categories.ts [--out <file>]
// Keeps each member's coin id only: the market figures of the answer are dropped. Public GETs only.

const API = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&per_page=250';
const LIST = 'https://api.coingecko.com/api/v3/coins/categories/list';
const PACE_MS = 8_000;
const BACKOFF_MS = 70_000;

const args = process.argv.slice(2);
const i = args.indexOf('--out');
const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const out =
  i >= 0 ? (args[i + 1] as string) : join('data/assets/solana', `coingecko-categories-${day}.json`);
mkdirSync(join(out, '..'), { recursive: true });

const saved: CategoryMembers = existsSync(out)
  ? (JSON.parse(readFileSync(out, 'utf8')) as CategoryMembers)
  : {
      what: `GET ${API}&category=<id>&page=<n>, and GET ${LIST}`,
      at: new Date().toISOString(),
      calls: 0,
      durationMs: 0,
      errors: 0,
      categories: {},
    };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const save = () => {
  writeFileSync(`${out}.tmp`, JSON.stringify(saved));
  renameSync(`${out}.tmp`, out);
};

for (const id of [...MEME_CATEGORIES, ...PROTOCOL_CATEGORIES]) {
  saved.categories[id] ??= { members: [], pages: 0, complete: false };
  const c = saved.categories[id];
  while (!c.complete) {
    const t0 = Date.now();
    let page: string[] | null = null;
    for (let attempt = 0; attempt < 10 && page === null; attempt++) {
      saved.calls++;
      const res = await fetch(`${API}&category=${id}&page=${c.pages + 1}`, {
        signal: AbortSignal.timeout(60_000),
      }).catch(() => null);
      if (!res || res.status === 429) {
        await sleep(BACKOFF_MS);
        continue;
      }
      if (!res.ok) {
        saved.errors++;
        break;
      }
      page = ((await res.json()) as Array<{ id: string }>).map((x) => x.id);
    }
    if (page === null) break; // left incomplete: the build says so
    c.members.push(...page);
    c.pages++;
    c.complete = page.length < 250;
    save();
    console.log(`${id} page ${c.pages}: ${page.length}`);
    await sleep(PACE_MS);
    saved.durationMs += Date.now() - t0;
  }
}
// the names of every category: where a launchpad platform's own category ("Pons Launchpad") is found
if (!saved.categoryNames) {
  saved.calls++;
  const res = await fetch(LIST, { signal: AbortSignal.timeout(60_000) }).catch(() => null);
  if (res?.ok)
    saved.categoryNames = ((await res.json()) as Array<{ name: string }>).map((c) => c.name).sort();
  else saved.errors++;
}
save();
console.log(
  JSON.stringify({ out, calls: saved.calls, categories: Object.keys(saved.categories).length }),
);
