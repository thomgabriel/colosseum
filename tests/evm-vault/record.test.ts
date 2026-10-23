import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  deploymentAssets,
  deploymentPools,
  EvmDeploymentRecord,
  poolOf,
  ROBINHOOD_V3,
  v3PoolAddress,
  v4Pools,
} from '@colosseum/chain-evm/vault';
import { deploymentsOf } from '@colosseum/sdk';
import { describe, expect, it } from 'vitest';

// The guard's deployment for Robinhood Chain's test network is the deploy's record, address for
// address: the guard derives every contract it holds a transaction to from it, so it may say nothing
// the deploy did not.

const ROOT = join(import.meta.dirname, '..', '..');
const record = EvmDeploymentRecord.parse(
  JSON.parse(readFileSync(join(ROOT, 'deployments', 'robinhood-testnet.json'), 'utf8')),
);

describe("the guard's Robinhood Chain test network", () => {
  it('is the record: chain id, factory, beacon, registry, router, cash and every token with its decimals', () => {
    const guard = deploymentsOf('testnet').robinhood;
    if (guard?.family !== 'evm') throw new Error('the guard has no EVM entry for robinhood');
    expect(guard.evmChainId).toBe(record.evmChainId);
    expect(guard.factory.toLowerCase()).toBe(record.contracts.factory);
    expect(guard.beacon.toLowerCase()).toBe(record.contracts.beacon);
    expect(guard.registry?.toLowerCase()).toBe(record.contracts.registry);
    expect(guard.routers.map((r) => r.toLowerCase())).toEqual(record.routers.map((r) => r.address));
    expect(guard.cash).toBe(record.cash.id);
    expect(
      Object.fromEntries(
        Object.entries(guard.assets).map(([id, a]) => [id, [a.token.toLowerCase(), a.decimals]]),
      ),
    ).toEqual(
      Object.fromEntries(deploymentAssets(record).map((a) => [a.id, [a.address, a.decimals]])),
    );
  });

  it("names each asset's pool as the record does: what the builder trades through is what the guard holds it to", () => {
    const guard = deploymentsOf('testnet').robinhood;
    if (guard?.family !== 'evm') throw new Error('the guard has no EVM entry for robinhood');
    const pools = deploymentPools(record);
    expect(guard.assets[guard.cash]?.pool).toBeUndefined();
    const listed = Object.entries(guard.assets).filter(([id]) => id !== guard.cash);
    expect(listed.length).toBe(record.assets.length);
    for (const [id, asset] of listed) {
      const built = poolOf(
        pools,
        record.cash.address as `0x${string}`,
        asset.token.toLowerCase() as `0x${string}`,
      );
      expect(asset.pool, id).toEqual(built);
      expect(asset.pool, id).toEqual(record.assets.find((a) => a.id === id)?.pool);
    }
    // The router's route names no pool of its own: the shape is each asset's.
    expect(Object.values(guard.routes)).toEqual([
      { kind: 'universal-router-v4', hooks: `0x${'0'.repeat(40)}` },
    ]);
  });
});

// Mainnet is not deployed to: the guard's file is a placeholder and the contracts' file is refused
// while it holds an unconfirmed value. What both can already say is which tokens are listed and which
// pool each trades in, and they have to say the same, token for token.
describe("Robinhood Chain mainnet, before a deploy: the guard's file and the contracts' file", () => {
  type GuardFile = {
    placeholder?: boolean;
    chains: {
      robinhood: {
        evmChainId: number;
        cash: string;
        routers: string[];
        routes: Record<string, { kind: string; hooks: string }>;
        assets: Record<
          string,
          {
            address: string;
            decimals: number;
            pool?: { fee: number; tickSpacing: number };
            v3Pool?: { pool: string; fee: number };
          }
        >;
      };
    };
  };
  type ContractsFile = {
    chainId: number;
    cashToken: string;
    routers: { router: string }[];
    assets: {
      token: string;
      tokenDecimals: number;
      feed: string;
      feedDescription?: string;
      pool?: { fee: number; tickSpacing: number };
      v3Pool?: { pool: string; fee: number };
    }[];
  };
  const guard = (
    JSON.parse(
      readFileSync(join(ROOT, 'packages', 'sdk', 'deployments', 'mainnet.json'), 'utf8'),
    ) as GuardFile
  ).chains.robinhood;
  // The deploy file the committed record was made from: the redeploy's (its Safe holds the keys
  // itself) once Thom has run it, the file of 2026-10-12 (its timelock) until then.
  const recordNow = JSON.parse(
    readFileSync(join(ROOT, 'deployments', 'robinhood-mainnet.json'), 'utf8'),
  ) as { safe?: unknown; hidden?: { address: string }[] };
  // Listed on chain and kept out of the app, so out of the guard's file (DELL, held back).
  const hidden = new Set((recordNow.hidden ?? []).map((h) => h.address.toLowerCase()));
  const deployFile = recordNow.safe ? '4663.json' : '4663-2026-10-12.json';
  const contracts = JSON.parse(
    readFileSync(join(ROOT, 'contracts', 'script', 'config', deployFile), 'utf8'),
  ) as ContractsFile;
  const lower = (s: string) => s.toLowerCase();

  it('list the same tokens, with the same decimals and the same pool for each', () => {
    expect(guard.evmChainId).toBe(contracts.chainId);
    expect(lower(guard.assets[guard.cash]?.address ?? '')).toBe(lower(contracts.cashToken));
    expect(guard.routers.map(lower)).toEqual(contracts.routers.map((r) => lower(r.router)));
    const [cash, ...listedOnChain] = contracts.assets;
    const stocks = listedOnChain.filter((a) => !hidden.has(lower(a.token)));
    expect(lower(cash?.token ?? '')).toBe(lower(contracts.cashToken));
    expect(cash?.pool).toBeUndefined();
    expect(guard.assets[guard.cash]?.pool).toBeUndefined();
    // More than NVDA: the launch lists every token that has a pool which quotes.
    expect(stocks.length).toBeGreaterThan(1);
    const fromGuard = Object.fromEntries(
      Object.entries(guard.assets)
        .filter(([id]) => id !== guard.cash)
        .map(([, a]) => [
          lower(a.address),
          { decimals: a.decimals, pool: a.pool, v3Pool: a.v3Pool },
        ]),
    );
    // And the tokens the Safe listed later through the timelock, once the record lists them
    // (`4663-assets-2.json`, `pnpm ops:add-assets --promote`): the guard learns a token with the record.
    const listed = new Set(
      (
        JSON.parse(readFileSync(join(ROOT, 'deployments', 'robinhood-mainnet.json'), 'utf8')) as {
          assets: { address: string }[];
        }
      ).assets.map((a) => lower(a.address)),
    );
    // On the redeploy, the Safe's own batches after the deploy (`4663-assets-3.json`, gate LIST-13).
    const added = (
      JSON.parse(
        readFileSync(
          join(
            ROOT,
            'contracts',
            'script',
            'config',
            recordNow.safe ? '4663-assets-3.json' : '4663-assets-2.json',
          ),
          'utf8',
        ),
      ) as ContractsFile
    ).assets.filter((a) => listed.has(lower(a.token)));
    const fromContracts = Object.fromEntries(
      [...stocks, ...added].map((a) => [
        lower(a.token),
        {
          decimals: a.tokenDecimals,
          pool: a.pool,
          v3Pool: a.v3Pool ? { pool: lower(a.v3Pool.pool), fee: a.v3Pool.fee } : undefined,
        },
      ]),
    );
    expect(fromGuard).toEqual(fromContracts);
    for (const a of [...stocks, ...added]) {
      // One route each: a v4 pool, or a v3 pool (gate V3-ROUTE).
      if (a.v3Pool) {
        expect(a.pool, a.token).toBeUndefined();
        expect(a.v3Pool.fee, a.token).toBeGreaterThan(0);
      } else
        expect(a.pool, a.token).toMatchObject({
          fee: expect.any(Number),
          tickSpacing: expect.any(Number),
        });
      expect(a.feedDescription, a.token).toBeTruthy();
    }
    // The five whose money is in Uniswap v3 are shown and traded through it, and GME (gate LIST-13).
    expect(
      [...stocks, ...added]
        .filter((a) => a.v3Pool)
        .map((a) => lower(a.token))
        .sort(),
    ).toEqual(
      Object.values(guard.assets)
        .filter((a) => a.v3Pool)
        .map((a) => lower(a.address))
        .sort(),
    );
    // One token, one entry, one feed.
    expect(new Set(stocks.map((a) => lower(a.token))).size).toBe(stocks.length);
    expect(new Set(stocks.map((a) => lower(a.feed))).size).toBe(stocks.length);
  });

  it('state the bound to the feed and a largest trade for every token, the thinnest the tightest', () => {
    const file = contracts as ContractsFile & { priceBoundBps?: number };
    // 2%: the bound the fork test holds every listed token's fill to (MAX_COST_BPS).
    expect(file.priceBoundBps).toBe(200);
    const [, ...stocks] = contracts.assets as (ContractsFile['assets'][number] & {
      maxTradeUsd?: number;
      feedDescription?: string;
    })[];
    for (const a of stocks) {
      expect(Number.isInteger(a.maxTradeUsd), a.token).toBe(true);
      expect(a.maxTradeUsd, a.token).toBeGreaterThanOrEqual(1_000);
    }
    const least = Math.min(...stocks.map((a) => a.maxTradeUsd ?? 0));
    // GLD, whose feed is itself made from pools, has the tightest limit of all.
    expect(stocks.find((a) => a.feedDescription === 'GLD / USD')?.maxTradeUsd).toBe(least);
    expect(least).toBe(1_000);
  });

  it('state what stands in for a stale feed: the rail, and an average pool per token that says whether it can be used', () => {
    const file = contracts as ContractsFile & {
      staleRailBps?: number;
      maxTradeUsdNotLive?: number;
      staleRailMaxAge?: number;
      sessionPriceAge?: number;
    };
    expect(file.staleRailBps).toBe(1_000);
    // A feed is live for an hour; past it one trade is $20,000 at most; the rail leans on a feed's
    // last answer for four days and no longer.
    expect(file.sessionPriceAge).toBe(3_600);
    expect(file.maxTradeUsdNotLive).toBe(20_000);
    expect(file.staleRailMaxAge).toBe(4 * 86_400);
    const [, ...stocks] = contracts.assets as (ContractsFile['assets'][number] & {
      feedDescription?: string;
      average?: { pool: string; fee: number; minLiquidity: string; usable: boolean };
    })[];
    // The pool and its floor are the ones the keeper's pool-average file names for the token.
    const feeds = JSON.parse(
      readFileSync(join(ROOT, 'contracts', 'script', 'config', 'pool-feeds', '4663.json'), 'utf8'),
    ) as { assets: { token: string; pool: string; fee: number; minLiquidity: string }[] };
    // The nine of 2026-10-12 were listed with the keeper's file's floors; a token added by the
    // redeploy states the floor measured with it (QQQ's on 2026-10-14 is below the keeper file's of
    // 2026-10-09), and the keeper is off on mainnet, so only its pool and fee are held to that file.
    const first = new Set(
      (
        JSON.parse(
          readFileSync(join(ROOT, 'contracts', 'script', 'config', '4663-2026-10-12.json'), 'utf8'),
        ) as ContractsFile
      ).assets.map((x) => lower(x.token)),
    );
    for (const a of stocks) {
      const found = feeds.assets.find((f) => lower(f.token) === lower(a.token));
      const named =
        found && !first.has(lower(a.token))
          ? { ...found, pool: lower(found.pool), minLiquidity: expect.stringMatching(/^\d+$/) }
          : found;
      // A token the keeper's file names has that file's pool; one listed since (the redeploy's, with
      // the keeper off) states its own, measured with it in contracts/script/config/4663-tokens-2026-10-14.json.
      expect(a.average, a.token).toEqual(
        named
          ? {
              pool: named.pool,
              fee: named.fee,
              minLiquidity: named.minLiquidity,
              usable: expect.any(Boolean),
            }
          : {
              pool: expect.stringMatching(/^0x[0-9a-f]{40}$/),
              fee: expect.any(Number),
              minLiquidity: expect.stringMatching(/^\d+$/),
              usable: expect.any(Boolean),
            },
      );
    }
    // Those whose pools keep under an hour of history say so, and are not traded on a stale feed.
    const unusable = stocks.filter((a) => !a.average?.usable).map((a) => a.feedDescription);
    expect(unusable.sort()).toEqual(
      recordNow.safe
        ? [
            'BTC / USD',
            'GLD / USD',
            'Robinhood BABA / USD',
            'Robinhood COIN / USD',
            'Robinhood DELL-USD',
            'Robinhood META / USD',
            'Robinhood PLTR / USD',
            'Robinhood SLV / USD',
            'Robinhood TSM / USD',
          ]
        : ['GLD / USD', 'Robinhood META / USD'],
    );
  });

  it('list each token the redeploy added with the values measured in its record of 2026-10-14', () => {
    if (!recordNow.safe) return;
    // The tokens the redeploy added (gate WIDER-LIST-B) are taken from their measured records, value
    // for value: the deploy file adds no figure of its own to them.
    const first = new Set(
      (
        JSON.parse(
          readFileSync(join(ROOT, 'contracts', 'script', 'config', '4663-2026-10-12.json'), 'utf8'),
        ) as ContractsFile
      ).assets.map((x) => lower(x.token)),
    );
    const measured = new Map(
      (
        JSON.parse(
          readFileSync(
            join(ROOT, 'contracts', 'script', 'config', '4663-tokens-2026-10-14.json'),
            'utf8',
          ),
        ) as { tokens: Record<string, unknown>[] }
      ).tokens.map((x) => [lower(String(x.token)), x]),
    );
    const added = (contracts.assets as unknown as Record<string, unknown>[]).filter(
      (a) => !first.has(lower(String(a.token))),
    );
    expect(added).toHaveLength(16);
    const fields = [
      'feed',
      'feedDescription',
      'tokenDecimals',
      'maxWeightBps',
      'maxTradeUsd',
      'average',
      'pool',
      'maxAge',
      'session',
    ];
    for (const a of added) {
      const r = measured.get(lower(String(a.token)));
      expect(r, String(a.symbol)).toBeDefined();
      for (const f of fields) expect(a[f], `${String(a.symbol)} ${f}`).toEqual(r?.[f]);
    }
  });

  it('the builder writes each mainnet token the pool the guard would hold it to', () => {
    // With the tokens the Safe listed after the deploy, once the record shows them (gate LIST-13).
    const shown = new Set(
      (
        JSON.parse(readFileSync(join(ROOT, 'deployments', 'robinhood-mainnet.json'), 'utf8')) as {
          assets: { address: string }[];
        }
      ).assets.map((a) => lower(a.address)),
    );
    const later = (
      JSON.parse(
        readFileSync(join(ROOT, 'contracts', 'script', 'config', '4663-assets-3.json'), 'utf8'),
      ) as ContractsFile
    ).assets.filter((a) => shown.has(lower(a.token)));
    const stocks = [...contracts.assets.slice(1), ...later];
    const pools = v4Pools(
      contracts.cashToken,
      stocks.map((a) => ({ address: a.token, pool: a.pool ?? null, v3Pool: a.v3Pool })),
    );
    for (const [id, a] of Object.entries(guard.assets)) {
      if (id === guard.cash) continue;
      const built = poolOf(pools, pools.cash, lower(a.address) as `0x${string}`);
      expect(built, id).toEqual(
        a.v3Pool ? { v3Pool: lower(a.v3Pool.pool), fee: a.v3Pool.fee } : a.pool,
      );
      // A v3 pool is the router's own: the v3 factory's pool of the two tokens at its fee.
      if (a.v3Pool)
        expect(
          v3PoolAddress(ROBINHOOD_V3, pools.cash, lower(a.address) as `0x${string}`, a.v3Pool.fee),
          id,
        ).toBe(lower(a.v3Pool.pool));
    }
    expect(
      new Set(
        Object.values(pools.byToken).map((p) =>
          'v3Pool' in p ? `v3/${p.fee}` : `${p.fee}/${p.tickSpacing}`,
        ),
      ).size,
    ).toBeGreaterThan(1);
  });

  it("the guard's file names the deployed contracts; the contracts' file holds no unconfirmed value", () => {
    // Deployed on 2026-10-12: the guard loads mainnet, and its three addresses are the record's.
    const record = JSON.parse(
      readFileSync(join(ROOT, 'deployments', 'robinhood-mainnet.json'), 'utf8'),
    ) as { contracts: { factory: string; beacon: string; registry: string } };
    const loaded = deploymentsOf('mainnet').robinhood as unknown as Record<string, string>;
    for (const name of ['factory', 'beacon', 'registry'] as const)
      expect(loaded[name]?.toLowerCase(), name).toBe(record.contracts[name]);
    // Every value of the contracts' file was confirmed by a person on 2026-10-12: the marker word the
    // deploy script refuses on is gone, and every note that stood beside a proposed value says who
    // confirmed it and when.
    const text = readFileSync(join(ROOT, 'contracts', 'script', 'config', deployFile), 'utf8');
    expect(text).not.toContain('TODO');
    const file = JSON.parse(text) as Record<string, unknown> & {
      assets: Record<string, unknown>[];
    };
    const notes = [file, ...file.assets.slice(1)].flatMap((o) =>
      Object.entries(o).filter(
        ([k, v]) =>
          /Note$|^note$/.test(k) &&
          typeof v === 'string' &&
          k !== 'ownerNote' &&
          k !== 'guardianNote' &&
          // Why a token is listed and not shown, or shown since: a decision's words, not a value's
          // confirmation.
          k !== 'hiddenNote' &&
          k !== 'shownNote',
      ),
    );
    expect(notes.length).toBeGreaterThan(40);
    // The deploy of 2026-10-12's values, and the redeploy's 17 tokens confirmed on 2026-10-15.
    for (const [key, note] of notes)
      expect(note, key).toMatch(/^Confirmed by Thom( Gabriel)?,? (on )?2026-10-1[25]/);
    // A ceiling for every token, none at zero.
    for (const a of file.assets.slice(1)) expect(a.maxWeightBps).toBeGreaterThan(0);
  });
});
