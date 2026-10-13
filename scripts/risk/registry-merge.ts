import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { nowIso } from '../lib';
import { latestRegistryFile } from './lib-history';
import {
  addedCallsPerHour,
  checkCollectorRegistry,
  mergeRegistries,
  type RegistryFile,
} from './lib-registry-merge';
import { DEFAULT_TIER_RULE } from './lib-tiers';

// `pnpm risk:registry-merge [--base <file>] [--shelf <file>] [--out <dir>]` (PLAN-ASSETS AS.12, ledger ASSET-3): the
// pool collector's registry with the Solana shelf's pools beside the stock pools (lib-registry-merge.ts says how).
//   --base   the stock registry; default the newest <RISK_DATA_DIR>/registry-<stamp>.json, its dust left out: the file
//            retier.ts copied to ~/.colosseum/risk/registry.json. Passing ~/.colosseum/risk/registry.json reads the
//            installed copy (read only).
//   --shelf  the shelf's registry; default the newest <RISK_DATA_DIR>/shelf-registry-solana-<stamp>.json.
//   --out    the folder written to; default RISK_DATA_DIR (data/risk).
// Writes <out>/collector-registry-solana-<stamp>.json and nothing else: no table, nothing under ~/.colosseum. The name
// does not start with `registry-`, so latestRegistryFile, retier.ts and the backfill never take it. Installing it is
// Rodrigo's: scripts/risk/collector/install.sh registry <file> (scripts/risk/assets/README.md, "The collector on the
// shelf's pools"). TIER_A_SHARE and MIN_POOL_TVL_USD change the shelf's tier rule as they change retier.ts's.
const DATA = process.env.RISK_DATA_DIR ?? 'data/risk';
const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const newest = (dir: string, prefix: string) => {
  const name = readdirSync(dir)
    .filter((n) => n.startsWith(prefix) && n.endsWith('.json'))
    .sort()
    .at(-1);
  if (!name) throw new Error(`no ${prefix}*.json in ${dir}`);
  return join(dir, name);
};
const baseFile = resolve(opt('--base') ?? latestRegistryFile(DATA));
const shelfFile = resolve(opt('--shelf') ?? newest(DATA, 'shelf-registry-solana-'));
const out = resolve(opt('--out') ?? DATA);
const rule = {
  tierAShare: Number(process.env.TIER_A_SHARE ?? DEFAULT_TIER_RULE.tierAShare),
  minPoolTvlUsd: Number(process.env.MIN_POOL_TVL_USD ?? DEFAULT_TIER_RULE.minPoolTvlUsd),
};
const read = (f: string) => JSON.parse(readFileSync(f, 'utf8')) as RegistryFile;
const merged = mergeRegistries(read(baseFile), read(shelfFile), {
  baseFile,
  shelfFile,
  now: new Date(),
  rule,
});
const problems = checkCollectorRegistry(merged);
if (problems.length) throw new Error(`the merged registry fails its check: ${problems.join('; ')}`);
mkdirSync(out, { recursive: true });
const file = join(
  out,
  `collector-registry-solana-${nowIso().slice(0, 16).replace(/[-:]/g, '')}.json`,
);
writeFileSync(file, JSON.stringify(merged, null, 1));

// The collector's cost of the shelf, from the shape of pools.ts. Child lists per pool: the mean of the collector's cache
// on 2026-10-13 (tier A: Meteora DLMM 6.9 bin arrays, Orca 13.1 tick arrays, Raydium CLMM 9.3); stale tick maps:
// about 10 re-reads a 5-minute run over 258 tier-A concentrated pools (runs.jsonl, 2026-10-13), 4% a pool a run.
const shelfPools = merged.pools.filter((p) => p.set === 'shelf');
const estimate = addedCallsPerHour(
  shelfPools,
  { meteora_dlmm: 6.9, orca_whirlpool: 13.1, raydium_clmm: 9.3 },
  { runsPerHour: 12, staleRefetchShare: 0.04 },
);
console.log(
  JSON.stringify(
    {
      file,
      counts: merged.counts,
      tierRule: merged.tierRule,
      base: merged.base,
      shelf: merged.shelf,
      shelfByVenueTier: shelfPools.reduce<Record<string, number>>((m, p) => {
        const k = `${p.venue}:${p.tier}`;
        m[k] = (m[k] ?? 0) + 1;
        return m;
      }, {}),
      addedRpcRequestsPerHour: estimate,
    },
    null,
    1,
  ),
);
