import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { shelfReplacedWarning } from '../scripts/risk/lib-installed';
import {
  addedCallsPerHour,
  type CollectorPool,
  checkCollectorRegistry,
  isStockSetPool,
  mergeRegistries,
  type RegistryFile,
} from '../scripts/risk/lib-registry-merge';
import { SPLIT_FILTER_MARK, selectSplitPools } from '../scripts/risk/lib-split';
import { DEFAULT_TIER_RULE, tierByShare } from '../scripts/risk/lib-tiers';

// PLAN-ASSETS AS.12 (ledger ASSET-3): the pool collector's registry with the Solana shelf's pools beside the stock pools.
// Made-up pools; the shape is the collector's (scripts/risk/collector/pools.ts RegPool).
const pool = (
  address: string,
  tvlUsd: number,
  extra: Partial<CollectorPool> = {},
): CollectorPool => ({
  address,
  venue: 'raydium_clmm',
  program: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  assetMint: `mint-${address}`,
  assetSymbol: address.toUpperCase(),
  quoteMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  quoteSymbol: 'USDC',
  exitPath: 'direct_usd',
  assetIsToken0: 1,
  vault0: `v0-${address}`,
  vault1: `v1-${address}`,
  decimals0: 8,
  decimals1: 6,
  transferFeeBps0: 0,
  transferFeeBps1: 0,
  tvlUsd,
  tier: 'B',
  ...extra,
});
const base: RegistryFile = {
  methodVersion: 'registry-0.1',
  fetchedAt: '2026-10-01T01:38:24.027Z',
  pools: [
    pool('s1', 900_000, { tier: 'A' }),
    pool('s2', 50_000, { tier: 'A' }),
    pool('s3', 2_000, { tier: 'B' }),
    pool('dust', 10, { tier: 'X' }),
  ],
};
const shelf: RegistryFile = {
  methodVersion: 'shelf-registry-0.1',
  fetchedAt: '2026-10-13T13:52:57.048Z',
  pools: [
    // the stock registry has this one already, as B: it stays as the stock registry has it
    pool('s3', 2_000, { tier: 'B', tierReason: 'shelf' }),
    pool('h1', 50_000_000),
    pool('h2', 400_000, { venue: 'meteora_dlmm' }),
    pool('h3', 100_000, { venue: 'orca_whirlpool' }),
    pool('h4', 500, { venue: 'raydium_cpmm' }),
  ],
};
const merge = (rule = DEFAULT_TIER_RULE) =>
  mergeRegistries(base, shelf, {
    baseFile: 'base.json',
    shelfFile: 'shelf.json',
    now: new Date(0),
    rule,
  });

describe('the tier rule (lib-tiers.ts, as retier.ts applies it)', () => {
  it('A until the share is reached, B after, X under the floor', () => {
    const t = tierByShare(
      [
        { address: 'a', tvlUsd: 98 },
        { address: 'b', tvlUsd: 1 },
        { address: 'c', tvlUsd: 1 },
        { address: 'd', tvlUsd: 0.5 },
      ],
      { tierAShare: 0.99, minPoolTvlUsd: 1 },
    );
    // 98 of 100 is below 99%: b is still A; then 99 is reached and c is B; d is dust
    expect(Object.fromEntries(t)).toEqual({ a: 'A', b: 'A', c: 'B', d: 'X' });
  });
  it('is the function retier.ts calls', () => {
    const src = readFileSync('scripts/risk/retier.ts', 'utf8');
    expect(src).toContain("import { tierByShare } from './lib-tiers';");
    expect(src).toContain('const tierOf = tierByShare(reg.pools, {');
  });
});

describe('the merge', () => {
  const m = merge();
  it('keeps the stock pools as they are, tier and order, without the dust', () => {
    const stocks = m.pools.filter((p) => p.set === 'stocks');
    expect(stocks.map((p) => [p.address, p.tier])).toEqual([
      ['s1', 'A'],
      ['s2', 'A'],
      ['s3', 'B'],
    ]);
    expect(stocks.every((p) => p.tierReason === undefined)).toBe(true);
  });
  it('holds a pool once: a shelf pool the stock registry has is the stock registry’s', () => {
    const addresses = m.pools.map((p) => p.address);
    expect(new Set(addresses).size).toBe(addresses.length);
    expect(m.duplicates).toEqual([
      { address: 's3', assetSymbol: 'S3', stockTier: 'B', shelfTier: 'B' },
    ]);
    expect(m.pools.find((p) => p.address === 's3')?.set).toBe('stocks');
  });
  it('tiers the shelf pools by the rule over the shelf alone, and leaves its dust out', () => {
    const shelfPools = m.pools.filter((p) => p.set === 'shelf');
    // 50M of 50.5M is 99.0099%: h1 is A, then the share is passed and h2, h3 are B; h4 is under $1,000
    expect(shelfPools.map((p) => [p.address, p.tier])).toEqual([
      ['h1', 'A'],
      ['h2', 'B'],
      ['h3', 'B'],
    ]);
    expect(m.shelfLeftOut).toEqual([
      { address: 'h4', assetSymbol: 'H4', reason: 'dust: tvl < 1000 USD' },
    ]);
    expect(shelfPools.every((p) => typeof p.tierReason === 'string')).toBe(true);
    // over the merged set the same rule would have moved s2 (a stock pool of tier A) to B; the merge does not
    const overAll = tierByShare([...base.pools, ...shelf.pools.slice(1)]);
    expect(overAll.get('s2')).toBe('B');
    expect(m.pools.find((p) => p.address === 's2')?.tier).toBe('A');
  });
  it('a lower share puts fewer shelf pools in A', () => {
    const half = merge({ tierAShare: 0.5, minPoolTvlUsd: 1000 });
    expect(half.counts.bySetTier).toEqual({
      'stocks:A': 2,
      'stocks:B': 1,
      'shelf:A': 1,
      'shelf:B': 2,
    });
  });
  it('has the file shape the collector and the other jobs read', () => {
    expect(checkCollectorRegistry(m)).toEqual([]);
    expect(m.fetchedAt).toBe(base.fetchedAt);
    expect(m.methodVersion).toBe('registry-merge-0.1');
    expect(m.counts).toMatchObject({
      pools: 6,
      stocks: 3,
      shelf: 3,
      duplicates: 1,
      shelfLeftOut: 1,
    });
    expect(m.base).toMatchObject({ file: 'base.json', pools: 3 });
    expect(m.shelf).toMatchObject({ file: 'shelf.json', pools: 5 });
    // the round trip through JSON keeps every field the collector needs
    expect(checkCollectorRegistry(JSON.parse(JSON.stringify(m)))).toEqual([]);
  });
  it('leaves out a shelf pool of a stock-set asset: no stock gains a pool in its routed curve', () => {
    const more = { ...shelf, pools: [...shelf.pools, pool('s1b', 3e6, { assetMint: 'mint-s1' })] };
    const r = mergeRegistries(base, more, {
      baseFile: 'b',
      shelfFile: 's',
      now: new Date(0),
      rule: DEFAULT_TIER_RULE,
    });
    expect(r.pools.some((p) => p.address === 's1b')).toBe(false);
    expect(r.shelfLeftOut.find((x) => x.address === 's1b')?.reason).toMatch(
      /asset of the stock set/,
    );
    const stockAssets = new Set(r.pools.filter((p) => p.set === 'stocks').map((p) => p.assetMint));
    expect(r.pools.filter((p) => p.set === 'shelf').some((p) => stockAssets.has(p.assetMint))).toBe(
      false,
    );
  });
  it('leaves out a shelf pool on a venue the collector cannot read, with the reason', () => {
    const more = {
      ...shelf,
      pools: [...shelf.pools, pool('amm', 9e6, { venue: 'raydium_amm_v4' })],
    };
    const r = mergeRegistries(base, more, {
      baseFile: 'b',
      shelfFile: 's',
      now: new Date(0),
      rule: DEFAULT_TIER_RULE,
    });
    expect(r.pools.some((p) => p.address === 'amm')).toBe(false);
    expect(r.shelfLeftOut.find((x) => x.address === 'amm')?.reason).toMatch(
      /raydium_amm_v4: the pool collector has no reader/,
    );
    // its TVL takes no part in the shelf's tiers: the same tiers as without it
    expect(r.pools.map((p) => p.tier)).toEqual(merge().pools.map((p) => p.tier));
  });
  it('refuses a pool the collector could not read, and a pool twice', () => {
    const bad = { ...base, pools: [pool('x', 5_000, { venue: 'byreal_clmm', tier: 'A' })] };
    expect(() =>
      mergeRegistries(bad, shelf, {
        baseFile: 'b',
        shelfFile: 's',
        now: new Date(0),
        rule: DEFAULT_TIER_RULE,
      }),
    ).toThrow(/venue byreal_clmm/);
    const broken = { ...shelf, pools: [{ ...pool('y', 5_000), vault0: '' }] };
    expect(() =>
      mergeRegistries(base, broken, {
        baseFile: 'b',
        shelfFile: 's',
        now: new Date(0),
        rule: DEFAULT_TIER_RULE,
      }),
    ).toThrow(/vault0/);
    const twice = { ...shelf, pools: [pool('x', 5_000), pool('x', 5_000)] };
    expect(() =>
      mergeRegistries(base, twice, {
        baseFile: 'b',
        shelfFile: 's',
        now: new Date(0),
        rule: DEFAULT_TIER_RULE,
      }),
    ).toThrow(/twice/);
  });
  it('the install check refuses a dust tier, a pool twice and a missing vault', () => {
    expect(checkCollectorRegistry({ pools: [pool('a', 1, { tier: 'X' })] })[0]).toMatch(/tier X/);
    expect(checkCollectorRegistry({ pools: [pool('a', 1), pool('a', 1)] })[0]).toMatch(/twice/);
    expect(checkCollectorRegistry({ pools: [{ ...pool('a', 1), vault1: '' }] })[0]).toMatch(
      /vault1/,
    );
    expect(checkCollectorRegistry({})).toEqual(['no pools array']);
  });
});

describe('the jobs keep their extras to the stock pools', () => {
  const m = merge();
  it('the split snapshot does not route the shelf pools', () => {
    // the registry as the split snapshot reads it (JSON, venues of its own type)
    const pools = m.pools as unknown as Parameters<typeof selectSplitPools>[0];
    const sel = selectSplitPools(pools, { twoHop: false, tracked: new Set() });
    expect(sel.direct.map((p) => p.address)).toEqual(['s1', 's2', 's3']);
    expect(m.pools.filter(isStockSetPool).map((p) => p.address)).toEqual(['s1', 's2', 's3']);
  });
  it('the pool collector, the quote cross-check: the lines that keep to the stock set', () => {
    const pools = readFileSync('scripts/risk/collector/pools.ts', 'utf8').replace(/\s+/g, ' ');
    expect(pools).toContain("const isStockSet = (p: RegPool) => p.set !== 'shelf';");
    expect(pools).toContain(
      'await snapshotMarkets(now, new Set(stockPools.map((p) => p.assetMint)))',
    );
    // every pool of the registry is still due (tier A every run, B hourly): the shelf gets its snapshots
    expect(pools).toContain("const due = reg.pools.filter((p) => p.tier === 'A' || hourly);");
    const quotes = readFileSync('scripts/risk/collector/quotes.ts', 'utf8');
    expect(quotes).toContain("reg.pools = reg.pools.filter((p) => p.set !== 'shelf');");
  });
});

describe('the split job built from this code carries the mark the installer looks for', () => {
  it('bundles scripts/risk/jobs/facts-split.ts with splitKeepsTheStockSetOnly in it', () => {
    const pnpmDir = 'node_modules/.pnpm';
    const esbuild = readdirSync(pnpmDir)
      .filter((d) => d.startsWith('esbuild@'))
      .map((d) => join(pnpmDir, d, 'node_modules/esbuild/bin/esbuild'))
      .find((f) => existsSync(f));
    expect(esbuild).toBeDefined();
    const out = join(mkdtempSync(join(tmpdir(), 'split-bundle-')), 'split.mjs');
    const r = spawnSync(
      esbuild as string,
      [
        'scripts/risk/jobs/facts-split.ts',
        '--bundle',
        '--platform=node',
        '--format=esm',
        '--target=node22',
        '--tsconfig=tsconfig.json',
        `--outfile=${out}`,
        '--log-level=error',
      ],
      { encoding: 'utf8' },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(out, 'utf8')).toContain(SPLIT_FILTER_MARK);
  });
});

describe('retier.ts and build-registry.ts warn before writing over a merged registry', () => {
  it('names the shelf pools the installed file holds, and says nothing for a stock registry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'installed-'));
    const f = join(dir, 'registry.json');
    expect(shelfReplacedWarning(f)).toBeNull();
    writeFileSync(f, JSON.stringify(base));
    expect(shelfReplacedWarning(f)).toBeNull();
    writeFileSync(f, JSON.stringify(merge()));
    expect(shelfReplacedWarning(f)).toMatch(/holds 3 shelf pools/);
    for (const script of ['scripts/risk/retier.ts', 'scripts/risk/build-registry.ts'])
      expect(readFileSync(script, 'utf8')).toContain(
        "const warning = shelfReplacedWarning(join(home, 'registry.json'));",
      );
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('the estimate of the added calls', () => {
  it('counts batches of 100, one discovery a concentrated pool (two on Orca) and the stale re-reads', () => {
    const e = addedCallsPerHour(
      [
        { venue: 'orca_whirlpool', tier: 'A' },
        { venue: 'meteora_dlmm', tier: 'A' },
        { venue: 'raydium_cpmm', tier: 'B' },
      ],
      { meteora_dlmm: 7, orca_whirlpool: 13, raydium_clmm: 9 },
      { runsPerHour: 12, staleRefetchShare: 0.05 },
    );
    expect(e).toEqual({
      headers: 12,
      children: 12,
      discoveries: 3,
      staleRefetches: 2,
      total: 29,
      firstRunDiscoveries: 3,
    });
  });
});

// The installer's registry mode, under a made-up HOME with a stand-in for launchctl first on the PATH: nothing here
// can reach this machine's ~/.colosseum, its ~/Library/LaunchAgents or its launchd.
const INSTALL = resolve('scripts/risk/collector/install.sh');
const hasZsh = spawnSync('zsh', ['-c', 'exit 0']).status === 0;
describe.skipIf(!hasZsh)('the installer: install.sh registry <file>', { timeout: 180_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'registry-install-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const stub = join(root, 'bin');
  const calls = join(root, 'launchctl.log');
  mkdirSync(stub);
  writeFileSync(join(stub, 'launchctl'), `#!/bin/sh\necho "launchctl $*" >> "${calls}"\n`);
  chmodSync(join(stub, 'launchctl'), 0o755);
  const file = join(root, 'merged.json');
  writeFileSync(file, JSON.stringify(merge()));
  const home = join(root, 'home');
  mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
  const install = (args: string[], env: Record<string, string> = {}) => {
    const base: Record<string, string | undefined> = { ...process.env };
    for (const k of Object.keys(base))
      if (k.startsWith('RISK_') || k === 'COLOSSEUM_HOME') delete base[k];
    const r = spawnSync('zsh', [INSTALL, ...args], {
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...base, HOME: home, PATH: `${stub}:${process.env.PATH}`, ...env },
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const tree = (dir: string): string[] =>
    existsSync(dir)
      ? readdirSync(dir, { recursive: true, withFileTypes: true })
          .filter((e) => e.isFile())
          .map((e) => join(e.parentPath, e.name).slice(dir.length + 1))
          .sort()
      : [];

  // a folder as the collectors leave it: the stock registry retier.ts installed (its dust out) and a split bundle,
  // with the stock-set filter or without it
  const SPLIT_OLD = 'export const x = (p) => ["A", "B"].includes(p.tier);\n';
  const SPLIT_NEW = 'function splitKeepsTheStockSetOnly(p) { return p.set !== "shelf"; }\n';
  const installed = { ...base, pools: base.pools.filter((p) => p.tier !== 'X') };
  const folder = (name: string, split: string | null, registry: unknown = installed) => {
    const dir = join(root, name);
    mkdirSync(dir);
    writeFileSync(join(dir, 'registry.json'), JSON.stringify(registry));
    if (split !== null) writeFileSync(join(dir, 'risk-facts-split.mjs'), split);
    return dir;
  };
  const without = (dir: string, ...names: string[]) => tree(dir).filter((f) => !names.includes(f));

  it('a rehearsal puts the registry and the two bundles under the folder given, keeps the old registry, loads nothing', () => {
    const dir = folder('rehearsal', SPLIT_NEW);
    const r = install(['registry', file, '--no-load'], { COLOSSEUM_HOME: dir });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('nothing is loaded');
    expect(r.out).toContain('registry checked: 6 pools');
    expect(r.out).toContain('its stock set is the installed one');
    const files = tree(dir);
    expect(files.filter((f) => !f.startsWith('registry.before-'))).toEqual([
      'registry.json',
      'risk-facts-split.mjs',
      'risk-pools.mjs',
      'risk-quotes.mjs',
    ]);
    expect(files.filter((f) => f.startsWith('registry.before-'))).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, 'registry.json'), 'utf8')).counts.shelf).toBe(3);
    expect(existsSync(calls)).toBe(false);
    expect(tree(join(home, '.colosseum'))).toEqual([]);
    expect(tree(join(home, 'Library', 'LaunchAgents'))).toEqual([]);
  });
  it('refuses while the installed split bundle lacks the stock-set filter, or is absent, and changes nothing', () => {
    for (const [name, split] of [
      ['rehearsal-old-split', SPLIT_OLD],
      ['rehearsal-no-split', null],
    ] as const) {
      const dir = folder(name, split);
      const before = tree(dir);
      const r = install(['registry', file, '--no-load'], { COLOSSEUM_HOME: dir });
      expect(r.status).not.toBe(0);
      expect(r.out).toContain('does not leave the shelf');
      expect(r.out).toContain('scripts/risk/jobs/install.sh facts-split');
      expect(tree(dir)).toEqual(before);
      expect(JSON.parse(readFileSync(join(dir, 'registry.json'), 'utf8'))).toEqual(installed);
    }
  });
  it('refuses a file whose stock set is not the installed one, and changes nothing', () => {
    const other = {
      ...installed,
      pools: installed.pools.map((p) => (p.address === 's2' ? { ...p, tier: 'B' } : p)),
    };
    const dir = folder('rehearsal-other-stocks', SPLIT_NEW, other);
    const r = install(['registry', file, '--no-load'], { COLOSSEUM_HOME: dir });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('stock pool s2 differs from the installed one');
    expect(r.out).toContain('nothing was changed');
    expect(without(dir, 'registry.json', 'risk-facts-split.mjs')).toEqual([]);
  });
  it('refuses a file that fails the check, and changes nothing', () => {
    const dir = folder('rehearsal-bad', SPLIT_NEW);
    const bad = join(root, 'bad.json');
    writeFileSync(bad, JSON.stringify({ pools: [pool('a', 1, { tier: 'X' })] }));
    const r = install(['registry', bad, '--no-load'], { COLOSSEUM_HOME: dir });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('nothing was changed');
    expect(without(dir, 'registry.json', 'risk-facts-split.mjs')).toEqual([]);
  });
  it('refuses --no-load at the live folder, and a rehearsal folder inside ~/.colosseum', () => {
    const live = install(['registry', file, '--no-load']);
    expect(live.status).not.toBe(0);
    expect(live.out).toContain('refusing --no-load');
    const inside = install(['registry', file, '--no-load'], {
      COLOSSEUM_HOME: join(home, '.colosseum', 'x'),
    });
    expect(inside.status).not.toBe(0);
    expect(inside.out).toContain('refusing: a rehearsal folder inside');
    expect(tree(join(home, '.colosseum'))).toEqual([]);
    expect(existsSync(calls)).toBe(false);
  });
});
