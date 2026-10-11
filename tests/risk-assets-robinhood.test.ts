import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  BEACON_CALLS,
  CODE_SELECTORS,
  type CodeContext,
  codeLayout,
  decodeAbiText,
  EIP1967,
  evmAuthorities,
  evmExtensions,
  evmStandard,
  ROUTER_SELECTOR,
  scanCode,
  slotValue,
  TOKEN_CALLS,
  tokenAnswers,
  tokenBasics,
  UPGRADE_SELECTORS,
  WATCHED_SELECTORS,
  wordAddress,
} from '@colosseum/risk';
import { UniverseList, UniverseVerdicts } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { LEG_TYPES } from '../packages/engine/src/personal/leg-types';
import { loadFiles, readGz } from '../scripts/risk-evm/assets-files';
import {
  type AssetFiles,
  coinKind,
  cryptoFeedBases,
  cryptoSelection,
  type FrozenReads,
  NATIVE_ADDRESS,
  poolCount,
  registryTokens,
  robinhoodList,
  VOLUME_FLOOR_USD,
  volumeByToken,
} from '../scripts/risk-evm/assets-list';
import { parseDirectory } from '../scripts/risk-evm/feeds';

// PLAN-ASSETS AS.3 (gate ASSET-UNIVERSE): the asset universe of Robinhood Chain. The reads it is built
// from are frozen under fixtures/risk-evm/assets/ (pnpm risk-evm:assets-freeze): the issuer's registry,
// Chainlink's directory, DexScreener's pairs cut to names and addresses, and every answer of the chain at
// one block, the code reduced to what it pushes. A sample of the code itself is frozen beside them for the
// decoders. No test here calls the network.

const ROOT = join(import.meta.dirname, '..');
const committed = () =>
  JSON.parse(readFileSync(join(ROOT, 'scripts/risk/assets/robinhood.json'), 'utf8'));
const frozenOf = (list: { inputs: Record<string, string> }) =>
  readGz<FrozenReads>(join(ROOT, list.inputs.frozen as string));
const filesFor = (fx: FrozenReads, list: { inputs: Record<string, string> }): AssetFiles => ({
  ...loadFiles(fx.discovery, ROOT),
  frozenPath: list.inputs.frozen as string,
});
const codeFixture = (list: { inputs: Record<string, string> }) =>
  readGz<{ block: number; samples: Array<{ address: string; why: string; code: string }> }>(
    join(ROOT, (list.inputs.frozen as string).replace('robinhood-reads-', 'robinhood-code-')),
  );

const list = committed();
const fx = frozenOf(list);
const files = filesFor(fx, list);
const rows = (list as UniverseList).assets;
const byId = (id: string) => {
  const a = rows.find((r) => r.id === id);
  if (!a) throw new Error(`no row ${id}`);
  return a;
};
const tokenRead = (address: string) => {
  const t = fx.reads.onchain.tokens.find((x) => x.address === address);
  if (!t) throw new Error(`not read: ${address}`);
  return t;
};
const scanOf = (address: string) => {
  const c = fx.reads.onchain.code.find((x) => x.address === address);
  if (!c) throw new Error(`no code read for ${address}`);
  return c;
};
const contextOf = (address: string): CodeContext => {
  const t = tokenRead(address);
  const beacon = slotValue(t.slots.beacon);
  const b =
    beacon.kind === 'address'
      ? fx.reads.onchain.beacons.find((x) => x.address === beacon.address)
      : undefined;
  const own = scanOf(address);
  const routes = fx.reads.onchain.facets.filter((f) => f.token === address);
  return {
    slots: t.slots,
    own,
    codeAt: (a: string) => fx.reads.onchain.code.find((x) => x.address === a) ?? null,
    beacon: b ? { implementation: b.implementation, owner: b.owner } : null,
    cloneTargetSlots: own.minimalProxyTarget
      ? (fx.reads.onchain.cloneTargets.find((c) => c.address === own.minimalProxyTarget)?.slots ??
        null)
      : null,
    facets: routes.length ? Object.fromEntries(routes.map((f) => [f.selector, f.reply])) : null,
  };
};
const authoritiesOf = (address: string) => {
  const a = tokenAnswers(tokenRead(address).replies);
  return evmAuthorities({ owner: a.owner, defaultAdmin: a.defaultAdmin, code: contextOf(address) });
};

describe('the committed list', () => {
  it('validates and is the list its frozen reads give, key for key', () => {
    expect(UniverseList.parse(list).chain).toBe('robinhood');
    const rebuilt = robinhoodList(fx.reads, files).list;
    expect(JSON.parse(JSON.stringify(rebuilt))).toEqual(list);
  });

  it('has a row for every token of the issuer registry, the gas coin, and no row twice', () => {
    const { tokens } = registryTokens(fx.reads);
    expect(tokens.size).toBe(fx.reads.registry.assets);
    const addresses = new Set(rows.map((r) => r.address));
    for (const a of tokens.keys()) expect(addresses.has(a)).toBe(true);
    expect(addresses.has(NATIVE_ADDRESS)).toBe(true);
    expect(addresses.size).toBe(rows.length);
    for (const r of rows.filter((x) => x.issuerRegistry !== null))
      expect(tokens.has(r.address)).toBe(true);
  });

  it('carries no price, no answer of a feed and no supply', () => {
    const keys = new Set<string>();
    const walk = (v: unknown) => {
      if (v && typeof v === 'object')
        for (const [k, x] of Object.entries(v)) {
          keys.add(k);
          if (k !== 'stated') walk(x);
        }
    };
    walk(list);
    for (const k of ['price', 'answer', 'round', 'totalSupply', 'supply', 'tvlUsd', 'apy'])
      expect(keys.has(k)).toBe(false);
  });

  it('keeps the tracked stocks as the tracked list has them', () => {
    const tracked = JSON.parse(
      readFileSync(join(ROOT, 'scripts/risk/universe/robinhood.json'), 'utf8'),
    );
    const ids = rows
      .filter((r) => r.tracked !== null)
      .map((r) => r.id)
      .sort();
    expect(ids).toEqual(tracked.assets.map((a: { id: string }) => a.id).sort());
    for (const r of rows.filter((x) => x.tracked !== null)) {
      expect(r.status).toBe('listed');
      expect(r.listedIn).toContain('tracked_stock');
    }
    // DA16: every other stock token of the registry is a candidate outside the cut
    for (const r of rows.filter((x) => x.issuerRegistry && !x.tracked))
      expect(r.statusReason).toMatch(
        /^outside the cut that names the tracked stocks \(gate UNIVERSE, DA16\)/,
      );
  });

  it('takes the class of a fund from the class table of the tracked list', () => {
    const cat = (symbol: string) => rows.find((r) => r.issuerRegistry?.symbol === symbol)?.category;
    expect([cat('SPY'), cat('QQQ'), cat('GLD'), cat('SLV'), cat('USO'), cat('SGOV')]).toEqual([
      'tokenized_etf',
      'tokenized_etf',
      'tokenized_gold',
      'tokenized_commodity',
      'tokenized_commodity',
      'treasury_fund_open',
    ]);
    expect(byId('robinhood:sgov').legTypes?.map((l) => l.type)).toEqual(['rate']);
  });
});

describe('the verdict table', () => {
  const table = () =>
    UniverseVerdicts.parse(
      JSON.parse(readFileSync(join(ROOT, 'scripts/risk/assets/robinhood.verdicts.json'), 'utf8')),
    );

  it('stops the build on a verdict for an address no read named', () => {
    const v = table();
    // Multicall3: a real contract no listing names as a token
    const extra = { ...v.verdicts[1], address: '0xca11bde05977b3631167028862be2a173976ca11' };
    v.verdicts.push(extra as (typeof v.verdicts)[number]);
    expect(() => robinhoodList(fx.reads, { ...files, verdicts: v })).toThrow(
      /verdicts for addresses no read named/,
    );
  });

  it('stops the build on a verdict for an address that is not a token', () => {
    const v = table();
    // the Uniswap v3 factory, which the note names
    const factory = { ...v.verdicts[1], address: '0x1f7d7550b1b028f7571e69a784071f0205fd2efa' };
    v.verdicts.push(factory as (typeof v.verdicts)[number]);
    expect(() => robinhoodList(fx.reads, { ...files, verdicts: v })).toThrow(
      /has a verdict and does not answer as a token/,
    );
  });

  it('stops the build on a token of a class a listing names with no verdict', () => {
    const v = table();
    v.verdicts = v.verdicts.filter((x) => x.symbol !== 'WETH');
    expect(() => robinhoodList(fx.reads, { ...files, verdicts: v })).toThrow(
      /no verdict in scripts\/risk\/assets\/robinhood.verdicts.json:\n {2}WETH 0x0bd7d308/,
    );
  });

  it('types the leg of a dollar-yield token as leg-types.ts does', () => {
    for (const r of rows.filter((x) => x.legTypes !== null)) {
      const row = LEG_TYPES[r.symbol];
      if (!row) continue;
      expect(r.legTypes?.map((l) => l.type)).toEqual(row.types);
      // the day of the source: leg-types.ts's readAt
      for (const l of r.legTypes ?? [])
        expect([r.symbol, l.readOn]).toEqual([r.symbol, row.readAt]);
    }
    expect(byId('robinhood:steakusdg').legTypes?.map((l) => l.type)).toEqual(['market_deposit']);
    expect(byId('robinhood:spusdg').legTypes).toBeNull();
  });

  it('excludes by rule only tokens with a registry symbol and an address the registry does not hold', () => {
    const { tokens } = registryTokens(fx.reads);
    const symbols = new Set([...tokens.values()].map((t) => t.row.tokenSymbol));
    const ruled = rows.filter((r) => r.decidedBy.includes('rule:not-the-issuers-stock-token'));
    expect(ruled.length).toBeGreaterThan(0);
    for (const r of ruled) {
      expect(symbols.has(r.symbol)).toBe(true);
      expect(tokens.has(r.address)).toBe(false);
      expect(r.status).toBe('excluded');
    }
  });

  it('holds out what is not shown to be the asset it names, and ties it no feed', () => {
    const usdt = rows.find((r) => r.address === '0x5b5448bb4101a136127ca8bf60a9f669f93fc09b');
    expect([usdt?.status, usdt?.statusReason, usdt?.oracleReason]).toEqual([
      'held_out',
      "not shown to be Tether's deployment",
      'issuer_not_confirmed',
    ]);
    // the directory prices USDE and WEETH: by the oracle map's rule, letters as written, they tie no row
    expect(byId('robinhood:usde').oracleReason).toBe('feed_named_in_other_case_not_tied');
    expect(byId('robinhood:weeth').oracleReason).toBe('feed_named_in_other_case_not_tied');
    expect(byId('robinhood:usdg').oracle?.description).toBe('USDG / USD');
  });

  it('lists USDG by the address the mainnet deploy config names', () => {
    const usdg = byId('robinhood:usdg');
    expect(usdg.listedIn).toEqual(['deploy_record']);
    expect(usdg.statusReason).toMatch(/cashToken\) of contracts\/script\/config\/4663\.json/);
    expect(files.mainnetConfig.cashToken.toLowerCase()).toBe(usdg.address);
  });
});

describe('the decoders, on what the chain answered', () => {
  const nvda = '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec';
  const usdg = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
  const steak = '0xbeeff033f34c046626b8d0a041844c5d1a5409dd';
  const weth = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
  const clone = '0x988ee7076ffb6b3d8da43bb993396be1e2031e18';

  it('reads text, decimals and the ERC-4626 test from the answers', () => {
    const a = tokenAnswers(tokenRead(nvda).replies);
    expect(tokenBasics(a)).toEqual({
      ok: true,
      decimals: 18,
      symbol: 'NVDA',
      name: 'NVIDIA • Robinhood Token',
    });
    const s = tokenAnswers(tokenRead(steak).replies);
    expect(evmStandard(s.asset, s.convertToAssets)).toBe('erc4626');
    expect(wordAddress(s.asset.data)).toBe(usdg);
    const u = tokenAnswers(tokenRead(usdg).replies);
    expect(evmStandard(u.asset, u.convertToAssets)).toBe('erc20');
    // a bytes32 symbol, and text that is refused
    expect(decodeAbiText(`0x${Buffer.from('USDG').toString('hex').padEnd(64, '0')}`)).toBe('USDG');
    expect(
      decodeAbiText(`0x${'0'.repeat(62)}20${'0'.repeat(62)}01${'07'.padEnd(64, '0')}`),
    ).toBeNull();
    expect(decodeAbiText('0x')).toBeNull();
  });

  it('scans the frozen code samples as the reads did', () => {
    const { samples, block } = codeFixture(list);
    expect(block).toBe(fx.reads.onchain.block);
    expect(samples.length).toBeGreaterThanOrEqual(5);
    expect(fx.reads.onchain.watched).toEqual([...WATCHED_SELECTORS]);
    for (const s of samples) {
      const { address: _a, sha256: _h, ...frozen } = scanOf(s.address);
      expect(scanCode(s.code)).toEqual(frozen);
    }
  });

  it('finds the stock tokens behind one beacon, pausable and able to block an address', () => {
    const ext = evmExtensions(contextOf(nvda));
    expect(ext.proxy.value).toBe(true);
    // implementation() of the beacon the stock tokens share, read at the block
    expect(ext.implementation).toBe('0xb35490d6f9163de4f80d88dc75c3516eb64c5ae2');
    expect(ext.pausable.value).toBe(true);
    expect(ext.blacklist.read).toMatch(/isBlocked\(address\)/);
    expect(authoritiesOf(nvda).admin.read).toMatch(/^owner\(\) of the EIP-1967 beacon 0x/);
  });

  it('reads an EIP-1967 proxy, a code that delegates without a slot, and a clone', () => {
    const u = evmExtensions(contextOf(usdg));
    expect(u.proxy.value).toBe(true);
    expect(u.implementation).toBe('0x68184c449e1a8f34fa18d289737129fd27b66f8f');
    const s = evmExtensions(contextOf(steak));
    expect([s.proxy.value, s.proxy.reason, s.implementation]).toEqual([
      null,
      'delegatecall_without_eip1967_slot',
      null,
    ]);
    const c = evmExtensions(contextOf(clone));
    expect(c.proxy.read).toMatch(/EIP-1167 clone of 0x3be8b97fd0e713b5abe0649fa830223b6b4bc599/);
    expect(c.implementation).toBeNull();
    // a clone cannot be upgraded only where its target does not delegate; its target's slots are named
    const target = scanOf('0x3be8b97fd0e713b5abe0649fa830223b6b4bc599');
    expect(c.proxy.value).toBe(target.delegatecall ? null : false);
    expect(c.proxy.read).toMatch(/the target's own slots: implementation/);
    const w = authoritiesOf(weth);
    expect(w.owner.reason).toBe('no_owner_function');
    expect(w.admin.holder).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it('never reads a flag as false where the code that runs delegates', () => {
    let nulls = 0;
    for (const r of rows) {
      if (r.extensions?.family !== 'evm') continue;
      const layout = codeLayout(contextOf(r.address));
      const delegates = layout.codes.some((c) => !c.shell && c.scan?.delegatecall);
      for (const f of [r.extensions.pausable, r.extensions.blacklist]) {
        if (delegates || layout.proxy.value === null) expect(f.value).not.toBe(false);
        if (f.value === null) nulls++;
      }
    }
    expect(nulls).toBeGreaterThan(0);
  });

  it('reads the dollar token through its facet router, and its admin as a UUPS proxy', () => {
    const u = evmExtensions(contextOf(usdg));
    expect(scanOf('0x68184c449e1a8f34fa18d289737129fd27b66f8f').selectors).toContain(
      ROUTER_SELECTOR[1],
    );
    expect(fx.reads.onchain.facets.filter((f) => f.token === usdg).length).toBeGreaterThan(0);
    for (const f of [u.pausable, u.blacklist]) {
      expect(f.value).not.toBe(false);
      if (f.value === true) expect(f.read).toMatch(/facet router: getFacet\(\) of the token sends/);
    }
    const a = authoritiesOf(usdg).admin;
    expect([a.holder, a.reason]).toEqual([null, 'uups_upgrade_in_implementation']);
    expect(a.read).toMatch(/owner\(\) answers 0x/);
    expect(byId('robinhood:usdg').authorities?.admin?.reason).toBe(
      'uups_upgrade_in_implementation',
    );
  });

  it('refuses reads whose code was scanned for other selectors', () => {
    const stale = JSON.parse(JSON.stringify(fx.reads)) as typeof fx.reads;
    stale.onchain.watched = stale.onchain.watched.slice(1);
    expect(() => robinhoodList(stale, files)).toThrow(/scanned for other selectors/);
  });

  it('writes each selector and slot as the hash of its name', () => {
    // viem is chain-evm's dependency, not the root's: it is asked for from there, for this one check
    const { keccak256, toBytes } = createRequire(join(ROOT, 'packages/chain-evm/package.json'))(
      'viem',
    ) as { keccak256: (b: Uint8Array) => string; toBytes: (s: string) => Uint8Array };
    const sel = (sig: string) => keccak256(toBytes(sig)).slice(2, 10);
    for (const [sig, s] of [
      ...TOKEN_CALLS,
      ...BEACON_CALLS,
      ...UPGRADE_SELECTORS,
      ROUTER_SELECTOR,
      ...CODE_SELECTORS.pausable,
      ...CODE_SELECTORS.blacklist,
    ])
      expect([sig, s]).toEqual([sig, sel(sig)]);
    for (const [name, slot] of Object.entries(EIP1967))
      expect(BigInt(slot)).toBe(BigInt(keccak256(toBytes(`eip1967.proxy.${name}`))) - 1n);
  });
});

describe('the pool counts', () => {
  const usdg = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
  const usde = '0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34';
  const nvda = '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec';

  it('counts a stock pool from the discovery file and any other from DexScreener, by hand', () => {
    const counts = poolCount({
      address: usde,
      aliases: [],
      discovery: {
        file: 'discovery.json',
        fetchedAt: '2026-10-05T20:11:13.000Z',
        groups: [
          [nvda, usde, true, 2],
          [nvda, usde, false, 1],
          [nvda, usdg, true, 9],
        ],
      },
      dex: [
        // USDe against USDG: no stock token, counted from DexScreener
        {
          pairAddress: '0x00e7c2cc7a9e92425c9a995b11b2ee85645c2010',
          dexId: 'alandale',
          labels: [],
          base: { address: usde, symbol: 'USDe', name: 'USDe' },
          quote: { address: usdg, symbol: 'USDG', name: 'Global Dollar' },
        },
        // NVDA against USDe: a stock pool, counted from the discovery file only
        {
          pairAddress: '0x5206ff70b86d5e293f1a776a94687707f655cf74',
          dexId: 'uniswap',
          labels: ['v3'],
          base: { address: nvda, symbol: 'NVDA', name: 'NVIDIA' },
          quote: { address: usde, symbol: 'USDe', name: 'USDe' },
        },
      ],
      registry: new Set([nvda]),
    });
    expect(counts).toEqual({ confirmed: 2, unconfirmed: 2 });
  });
});

describe('crypto beyond the listings', () => {
  const registry = new Set(registryTokens(fx.reads).tokens.keys());
  const feeds = parseDirectory(fx.reads.directory.entries).feeds.map((f) => f.name);
  const symbols = [...registryTokens(fx.reads).tokens.values()].map((t) => t.row.tokenSymbol ?? '');
  const selected = cryptoSelection(fx.reads, registry, feeds, symbols);
  const coins = new Map(fx.reads.coingecko.coins.map((c) => [c.address, c]));
  const rowSet = new Set(rows.map((r) => r.address));
  const own = new Set(
    JSON.parse(
      readFileSync(join(ROOT, 'scripts/risk/assets/robinhood.verdicts.json'), 'utf8'),
    ).verdicts.map((v: { address: string }) => v.address),
  );

  it('selects by the day volume of the pairs or a Chainlink feed, and writes no volume in a row', () => {
    const volume = volumeByToken(fx.reads);
    // a crypto feed's base: no stock token's feed selects a token of the same symbol
    const bases = cryptoFeedBases(feeds, symbols);
    for (const b of ['LINK', 'WSTETH', 'CBBTC']) expect(bases.has(b)).toBe(true);
    for (const b of ['NVDA', 'SPY', 'GLD']) expect(bases.has(b)).toBe(false);
    for (const [a, t] of selected) {
      const byVolume = (volume.get(a) ?? 0) >= VOLUME_FLOOR_USD;
      expect(byVolume || t.why.includes('feed')).toBe(true);
      expect(t.why.includes('volume')).toBe(byVolume);
      if (t.why.includes('feed')) expect(bases.has(t.symbol.toUpperCase())).toBe(true);
    }
    expect(JSON.stringify(list)).not.toMatch(/"(?:h24|volume|volumeUsd)"/);
    // every selected token was looked up on CoinGecko
    for (const a of selected.keys()) expect(coins.has(a)).toBe(true);
  });

  it('rows a selected token only by its own verdict or as a protocol by CoinGecko, never a memecoin', () => {
    const ruled = rows.filter((r) => r.decidedBy.includes('rule:crypto-protocol'));
    expect(ruled.length).toBeGreaterThan(0);
    for (const r of ruled) {
      expect(selected.has(r.address)).toBe(true);
      expect(coinKind(coins.get(r.address), r.address)).toBe('protocol');
      if (r.status !== 'excluded')
        expect([r.category, r.status]).toEqual(['governance', 'candidate']);
    }
    for (const a of selected.keys()) {
      const kind = coinKind(coins.get(a), a);
      if (kind !== 'protocol' && !own.has(a) && !registry.has(a)) {
        const r = rows.find((x) => x.address === a);
        // a row only by another path (a class name that must be decided), never by the selection
        if (r) expect(r.decidedBy).not.toContain('rule:crypto-protocol');
      }
    }
    const memes = [...selected.keys()].filter(
      (a) => coinKind(coins.get(a), a) === 'meme' && !rowSet.has(a),
    ).length;
    expect(list.stated.cryptoLeftOut).toContain(`meme ${memes}`);
  });

  it("finds wstETH, LINK, TAO and cbBTC through Chainlink CCIP's directory", () => {
    const ccip = new Set(fx.reads.ccip.tokens.map((t) => t.address));
    for (const [id, category] of [
      ['robinhood:wsteth', 'liquid_staking'],
      ['robinhood:link', 'governance'],
      ['robinhood:tao', 'wrapped_other'],
      ['robinhood:cbbtc', 'wrapped_btc'],
    ] as const) {
      const r = byId(id);
      expect([r.category, r.status]).toEqual([category, 'candidate']);
      expect(ccip.has(r.address)).toBe(true);
      expect(r.listingTags).toContain('chainlink_ccip');
    }
    expect(byId('robinhood:wsteth').oracleReason).toBe('feed_named_in_other_case_not_tied');
  });
});
