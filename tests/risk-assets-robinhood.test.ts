import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  BEACON_CALLS,
  CODE_SELECTORS,
  decodeAbiText,
  EIP1967,
  evmAuthorities,
  evmExtensions,
  evmStandard,
  scanCode,
  slotValue,
  TOKEN_CALLS,
  tokenAnswers,
  tokenBasics,
  WATCHED_SELECTORS,
  wordAddress,
} from '@colosseum/risk';
import { UniverseList, UniverseVerdicts } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { LEG_TYPES } from '../packages/engine/src/personal/leg-types';
import { loadFiles, readGz } from '../scripts/risk-evm/assets';
import {
  type AssetFiles,
  type FrozenReads,
  NATIVE_ADDRESS,
  poolCount,
  registryTokens,
  robinhoodList,
} from '../scripts/risk-evm/assets-list';

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
const contextOf = (address: string) => {
  const t = tokenRead(address);
  const beacon = slotValue(t.slots.beacon);
  const b =
    beacon.kind === 'address'
      ? fx.reads.onchain.beacons.find((x) => x.address === beacon.address)
      : undefined;
  return {
    slots: t.slots,
    own: scanOf(address),
    codeAt: (a: string) => fx.reads.onchain.code.find((x) => x.address === a) ?? null,
    beacon: b ? { implementation: b.implementation, owner: b.owner } : null,
  };
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
      expect(r.statusReason).toMatch(/^outside the 80% cut \(DA16\)/);
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
      if (row) expect(r.legTypes?.map((l) => l.type)).toEqual(row.types);
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

  it('says of the excluded dollars only what the frozen code shows', () => {
    // the verdicts of USDT, one USDC and both GOLD say their code has the length of the code of seven
    // tokens named after stocks of the registry and not in it (they are not byte for byte the same)
    const ruled = new Set(
      rows
        .filter((r) => r.decidedBy.includes('rule:not-the-issuers-stock-token'))
        .map((r) => r.address),
    );
    expect(
      fx.reads.onchain.code.filter((c) => ruled.has(c.address) && c.size === 3248),
    ).toHaveLength(7);
    for (const a of [
      '0x5b5448bb4101a136127ca8bf60a9f669f93fc09b',
      '0x8dffab0c883818963b97f37a5792952296621f77',
      '0x362db5af0367315ad57ade8f3c132d6e0b7d19df',
      '0xa62f748f8d16009cb19366da8d1160fb29de428f',
    ]) {
      expect(scanOf(a).sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(scanOf(a).size).toBe(3248);
      expect(rows.find((r) => r.address === a)?.statusReason).toMatch(
        /3,248 bytes, as the code of seven tokens/,
      );
    }
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
    const auth = evmAuthorities({
      owner: tokenAnswers(tokenRead(nvda).replies).owner,
      ...contextOf(nvda),
    });
    expect(auth.admin.read).toMatch(/^owner\(\) of the EIP-1967 beacon 0x/);
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
    expect(c.proxy.value).toBe(false);
    expect(c.proxy.read).toMatch(/EIP-1167 clone of 0x3be8b97fd0e713b5abe0649fa830223b6b4bc599/);
    expect(c.implementation).toBeNull();
    const w = evmAuthorities({
      owner: tokenAnswers(tokenRead(weth).replies).owner,
      ...contextOf(weth),
    });
    expect(w.owner.reason).toBe('no_owner_function');
    expect(w.admin.holder).toMatch(/^0x[0-9a-f]{40}$/);
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
