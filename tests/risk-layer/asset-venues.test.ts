// ASSET-3 (PLAN-ASSETS AS.12): the three venues of the shelf's liquidity no decoder read before, Raydium AMM v4,
// Meteora DAMM (v1 and v2) and PumpSwap, on real mainnet data frozen on 2026-10-13:
// - fixtures/risk/assets/venues/pools-20261013.json.gz: 15 pool accounts (the largest of each venue in the shelf's
//   DexScreener answers of that day), their vaults' token accounts and, for DAMM v1, the Meteora dynamic vaults
//   and their token accounts, read with getMultipleAccounts at slots 456,528,910 to 456,528,912, with each pool's
//   DexScreener pair;
// - fixtures/risk/txs/{raydium_amm_v4,meteora_damm_v1,meteora_damm_v2,pumpswap}-*.json: 20 transactions, read
//   with getTransaction. events.test.ts checks every one of them against the vaults' token balance changes; the
//   figures below are worked by hand from the raw bytes, logs and balances of a few.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  ANCHOR_POOL_DISC,
  alignFrames,
  decodeAmmV4Pool,
  decodeDammV1Pool,
  decodeDammV2Pool,
  decodePumpSwapEvents,
  decodePumpSwapPool,
  decoders,
  dlmmEventPayloads,
  framesWithInvocations,
  METEORA_DAMM_V1_PROGRAM,
  METEORA_DAMM_V2_PROGRAM,
  PUMPSWAP_PROGRAM,
  RAYDIUM_AMM_V4_PROGRAM,
  Reader,
  type RpcTx,
  tokenBalances,
  txAccountKeys,
} from '@colosseum/risk';
import { describe, expect, it } from 'vitest';
import { supportedVenue } from '../../scripts/risk/assets/shelf-pools';
import { ALL_VENUES, confirmPool, REGISTRY_VENUES, VENUES } from '../../scripts/risk/lib-venues';

const root = join(__dirname, '../..');
const frozen = JSON.parse(
  gunzipSync(
    readFileSync(join(root, 'fixtures/risk/assets/venues/pools-20261013.json.gz')),
  ).toString(),
) as {
  slots: number[];
  pools: string[];
  accounts: Record<string, { owner: string; data: string }>;
  dexscreener: {
    pairs: Record<string, { dexId: string; labels: string[]; base: string; quote: string }>;
  };
};
const bytes = (a: string) =>
  new Uint8Array(Buffer.from(frozen.accounts[a]?.data as string, 'base64'));
const acc = (a: string) => ({ owner: frozen.accounts[a]?.owner as string, data: bytes(a) });
/** An SPL token account (Token or Token-2022): mint @0, owner @32, amount u64 @64. */
const tokenAccount = (a: string) => {
  const r = new Reader(bytes(a));
  return { mint: r.pubkey(0), owner: r.pubkey(32), amount: r.u64(64) };
};
type Fx = {
  venue: string;
  label: string;
  tx: RpcTx;
  pools: Record<string, [string, string]>;
  mint0: Record<string, string>;
};
const fx = (name: string): Fx =>
  JSON.parse(readFileSync(join(root, 'fixtures/risk/txs', `${name}.json`), 'utf8'));
const run = (f: Fx) => {
  const [pool, vaults] = Object.entries(f.pools)[0] as [string, [string, string]];
  const d = decoders[f.venue]?.(f.tx, pool, { mint0: f.mint0[pool] });
  if (!d) throw new Error(`no decoder for ${f.venue}`);
  return { pool, vaults, d, bal: tokenBalances(f.tx, vaults) };
};
const delta = (b: { pre: (string | null)[]; post: (string | null)[] }, i: number) =>
  BigInt(b.post[i] ?? 0) - BigInt(b.pre[i] ?? 0);

describe('the venue table', () => {
  it('names the three venues by their programs and DexScreener names', () => {
    expect(VENUES.raydium_amm_v4.program).toBe(RAYDIUM_AMM_V4_PROGRAM);
    expect(VENUES.meteora_damm_v1.program).toBe(METEORA_DAMM_V1_PROGRAM);
    expect(VENUES.meteora_damm_v2.program).toBe(METEORA_DAMM_V2_PROGRAM);
    expect(VENUES.pumpswap.program).toBe(PUMPSWAP_PROGRAM);
    for (const p of frozen.pools) {
      const ds = frozen.dexscreener.pairs[p];
      const venue = supportedVenue({ dexId: ds?.dexId as string, labels: ds?.labels });
      expect(venue && VENUES[venue].program).toBe(frozen.accounts[p]?.owner);
    }
  });

  it('keeps the stock registry (build-registry.ts) to its four venues', () => {
    expect([...REGISTRY_VENUES].sort()).toEqual([
      'meteora_dlmm',
      'orca_whirlpool',
      'raydium_clmm',
      'raydium_cpmm',
    ]);
    const p = frozen.pools[0] as string; // a Raydium AMM v4 pool
    expect(confirmPool(acc(p))).toEqual({
      ok: false,
      reason: `unsupported program ${RAYDIUM_AMM_V4_PROGRAM}`,
    });
    expect(confirmPool(acc(p), { venues: ALL_VENUES }).ok).toBe(true);
  });
});

describe('pool accounts (15 live pools)', () => {
  it('each confirms: owner the venue, mints DexScreener’s pair, vaults token accounts of those mints', () => {
    expect(frozen.pools).toHaveLength(15);
    for (const p of frozen.pools) {
      const ds = frozen.dexscreener.pairs[p];
      const venue = supportedVenue({ dexId: ds?.dexId as string, labels: ds?.labels });
      const c = confirmPool(acc(p), { expected: venue ?? undefined, venues: ALL_VENUES });
      if (!c.ok) throw new Error(`${p}: ${c.reason}`);
      expect(new Set([c.mint0, c.mint1])).toEqual(new Set([ds?.base, ds?.quote]));
      if (c.vaultsHold) {
        // DAMM v1: the pool's accounts hold the dynamic vaults' LP tokens; each dynamic vault (Meteora's vault
        // program: total_amount u64 @11, token_vault @19, token_mint @83, lp_mint @115) holds the pool's token
        for (const [own, vault, mint] of [
          [c.vault0, c.vaultsHold.aVault, c.mint0],
          [c.vault1, c.vaultsHold.bVault, c.mint1],
        ] as const) {
          const v = new Reader(bytes(vault));
          expect(v.pubkey(83)).toBe(mint);
          expect(tokenAccount(own).mint).toBe(v.pubkey(115));
          expect(tokenAccount(v.pubkey(19)).mint).toBe(mint);
        }
      } else {
        expect(tokenAccount(c.vault0).mint).toBe(c.mint0);
        expect(tokenAccount(c.vault1).mint).toBe(c.mint1);
      }
    }
  });

  it('Raydium AMM v4 RAY/USDC 6UmmUi…: the plain 752-byte struct', () => {
    const p = '6UmmUiYoBjSrhakAobJw8BvkmJtDVxaeBtbt7rxWo1mg';
    const d = bytes(p);
    // no discriminator: status u64 @0 is 6 (swap only, the OpenBook side off), coin and pc decimals u64 @32/@40
    expect(d.length).toBe(752);
    expect([...d.subarray(0, 8)]).toEqual([6, 0, 0, 0, 0, 0, 0, 0]);
    const h = decodeAmmV4Pool(d);
    expect([h.status, h.decimals0, h.decimals1]).toEqual([6, 6, 6]);
    expect(h.mint0).toBe('4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R'); // RAY @400
    expect(h.mint1).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'); // USDC @432
    // need_take_pnl @192/@200: the protocol's pnl, 1,539,772 RAY and 3,146,115 USDC (raw), sits in the vaults; the
    // swappable reserves are the vault balances less it: 1,682,820,479,601 − 1,539,772 = 1,682,818,939,829 RAY and
    // 3,439,000,862,323 − 3,146,115 = 3,438,997,716,208 USDC (raw, 6 decimals each)
    expect([h.owed0, h.owed1]).toEqual([1_539_772n, 3_146_115n]);
    expect(tokenAccount(h.vault0).amount - h.owed0).toBe(1_682_818_939_829n);
    expect(tokenAccount(h.vault1).amount - h.owed1).toBe(3_438_997_716_208n);
  });

  it('Meteora DAMM v1 DBR/USDC E5H5BX…: LP tokens of two dynamic vaults', () => {
    const p = 'E5H5BXLranyJFHEzvR3R2j6kGDQ3Fnx8sPKSsgYqyya8';
    const d = bytes(p);
    // Anchor's "account:Pool" discriminator; 952 bytes (944 for a constant-product pool; this one's curve is longer)
    expect(new Reader(d).disc()).toBe(ANCHOR_POOL_DISC);
    expect(d.length).toBe(952);
    const h = decodeDammV1Pool(d);
    expect(h.mint0).toBe('DBRiDgJAMsM95moTzJs7M9LnkGErpbv9v6CUR1DXnUu5'); // token_a_mint @40
    expect(h.mint1).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'); // token_b_mint @72
    // a_vault_lp @168 holds 153,056,173,908,584 of the DBR vault's LP token; that vault's token account holds
    // 153,121,455,038,098 DBR for every pool that uses it
    expect(tokenAccount(h.aVaultLp).amount).toBe(153_056_173_908_584n);
    const a = new Reader(bytes(h.aVault));
    expect(a.pubkey(19)).toBe('627jyZshUdSn221WvLTefbhUWXQJ7vsj8BXNTBxsUpZ5');
    expect(tokenAccount(a.pubkey(19)).amount).toBe(153_121_455_038_098n);
  });

  it('Meteora DAMM v2 MET/USDC Bnztue…: 1,112 bytes, its own vaults', () => {
    const p = 'BnztueWcXv93mgW7yJe8WYpnCxpz34nujPhfjQT6SLu1';
    const h = decodeDammV2Pool(bytes(p));
    expect(bytes(p).length).toBe(1112);
    expect(h.mint0).toBe('METvsvVRapdj9cFLzq4Tr43xK4tAjQfwX76z3n6mWQL'); // token_a_mint @168
    expect(h.mint1).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'); // token_b_mint @200
    // collect_fee_mode @484 is 1 (fees in token B only): the protocol's fee owed is all USDC, 50,927,340 raw
    // (protocol_b_fee @400), held in the USDC vault of 2,191,598,789,371
    expect(h.collectFeeMode).toBe(1);
    expect([h.owed0, h.owed1]).toEqual([0n, 50_927_340n]);
    expect(tokenAccount(h.vault1).amount).toBe(2_191_598_789_371n);
  });

  it('PumpSwap TRX/USDC Comiec…: base @43, quote @75, vaults @139/@171', () => {
    const p = 'ComiecDMCEQg1xyoGzVt6B8xGNdGgvvYRuwzbtDb6FY';
    expect(bytes(p).length).toBe(300); // the RARI/RACE pool beside it is 301: the program grows the account
    const h = decodePumpSwapPool(bytes(p));
    expect(h.mint0).toBe('GbbesPbaYh5uiAZSYNXTc7w9jty1rpg3P9L4JeN4LkKc');
    expect(h.mint1).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(h.vault0).toBe('E5DL6J5ceUVGABNPiAmuNZSmHqyUs9Yaz7SV1bRC7jHs');
    expect(h.lpSupply).toBe(2_305_280_472_754n); // lp_supply u64 @203
  });

  it('refuses a pool account of the wrong shape', () => {
    expect(() => decodeAmmV4Pool(new Uint8Array(751))).toThrow(/751 bytes/);
    expect(() => decodeDammV2Pool(bytes('6UmmUiYoBjSrhakAobJw8BvkmJtDVxaeBtbt7rxWo1mg'))).toThrow();
    expect(() => decodePumpSwapPool(new Uint8Array(300))).toThrow(/discriminator/);
  });
});

describe('Raydium AMM v4: ray_log, paired with its instruction', () => {
  it('SwapBaseIn on arc/SOL J3b6dv…: pc in, coin out', () => {
    const f = fx('raydium_amm_v4-SwapBaseIn');
    // the frame's line "ray_log: A+hqmtoAAAAAAAAAAAAAAAABAAAAAAAAAPICzZ0WAAAA/22mP+kNAAB/EoSuSCwAAOJ8fkQAAAAA"
    // decodes to type 3 (SwapBaseIn), amount_in @1 = 0xda9a6ae8 = 3,667,553,000, minimum_out @9 = 0,
    // direction @17 = 1 (pc to coin), out_amount @49 = 0x447e7ce2 = 1,149,140,194
    const log = Buffer.from(
      'A+hqmtoAAAAAAAAAAAAAAAABAAAAAAAAAPICzZ0WAAAA/22mP+kNAAB/EoSuSCwAAOJ8fkQAAAAA',
      'base64',
    );
    expect([
      log[0],
      log.readBigUInt64LE(1),
      log.readBigUInt64LE(17),
      log.readBigUInt64LE(49),
    ]).toEqual([3, 3_667_553_000n, 1n, 1_149_140_194n]);
    const { d, bal } = run(f);
    // the coin (SOL) vault went 15,295,446,412,799 → 15,294,297,272,605 (−1,149,140,194), the pc (arc) vault
    // 48,690,677,158,527 → 48,694,344,711,527 (+3,667,553,000)
    expect([delta(bal, 0), delta(bal, 1)]).toEqual([-1_149_140_194n, 3_667_553_000n]);
    expect(d.events).toEqual([
      {
        kind: 'swap',
        pool: 'J3b6dvheS2Y1cbMtVz5TCWXNegSjJDbUKxdUVDPoqmS7',
        ixIndex: 3,
        amount0: '1149140194',
        amount1: '3667553000',
        zeroForOne: false,
      },
    ]);
    expect(d.ix).toEqual(['SwapBaseIn']);
  });

  it('Deposit on RAY/USDC 6UmmUi…: deduct_coin and deduct_pc into the vaults', () => {
    const { d, bal } = run(fx('raydium_amm_v4-Deposit'));
    // ray_log type 1: deduct_coin @81 = 19,818, deduct_pc @89 = 43,614, mint_lp @97 = 4,200; the vaults rose
    // 1,621,129,822,060 → 1,621,129,841,878 (+19,818) and 3,567,606,741,568 → 3,567,606,785,182 (+43,614)
    expect([delta(bal, 0), delta(bal, 1)]).toEqual([19_818n, 43_614n]);
    expect(d.events).toMatchObject([
      {
        kind: 'liquidity',
        action: 'increase',
        amount0: '19818',
        amount1: '43614',
        lpDelta: '4200',
      },
    ]);
  });

  it('two AMM v4 frames on two pools in one transaction: each pool reads its own', () => {
    // No live transaction through two AMM v4 pools turned up in 75 more read (RAY/USDC, RAY/USDT), so two real
    // ones are stitched into one, in order: the arc/SOL SwapBaseIn (4 outer instructions) then the RAY/USDC
    // Deposit, every account index of the second shifted past the first's keys. The logs then hold two AMM v4
    // frames, each with its own ray_log, and only the instruction accounts say which pool each belongs to.
    const one = fx('raydium_amm_v4-SwapBaseIn').tx;
    const two = fx('raydium_amm_v4-Deposit').tx;
    const keysOf = (t: RpcTx) => [
      ...t.transaction.message.accountKeys,
      ...(t.meta?.loadedAddresses?.writable ?? []),
      ...(t.meta?.loadedAddresses?.readonly ?? []),
    ];
    const k1 = keysOf(one);
    const shift = k1.length;
    const outer1 = one.transaction.message.instructions.length;
    const ix = (i: { programIdIndex: number; accounts: number[]; data: string }) => ({
      ...i,
      programIdIndex: i.programIdIndex + shift,
      accounts: i.accounts.map((a) => a + shift),
    });
    const bal = (rows: NonNullable<RpcTx['meta']>['preTokenBalances']) =>
      (rows ?? []).map((r) => ({ ...r, accountIndex: r.accountIndex + shift }));
    const m1 = one.meta as NonNullable<RpcTx['meta']>;
    const m2 = two.meta as NonNullable<RpcTx['meta']>;
    const tx: RpcTx = {
      slot: one.slot,
      blockTime: one.blockTime,
      transaction: {
        signatures: one.transaction.signatures,
        message: {
          accountKeys: [...k1, ...keysOf(two)],
          instructions: [
            ...one.transaction.message.instructions,
            ...two.transaction.message.instructions.map(ix),
          ],
        },
      },
      meta: {
        err: null,
        logMessages: [...(m1.logMessages ?? []), ...(m2.logMessages ?? [])],
        innerInstructions: [
          ...(m1.innerInstructions ?? []),
          ...(m2.innerInstructions ?? []).map((g) => ({
            index: g.index + outer1,
            instructions: g.instructions.map(ix),
          })),
        ],
        preTokenBalances: [...(m1.preTokenBalances ?? []), ...bal(m2.preTokenBalances)],
        postTokenBalances: [...(m1.postTokenBalances ?? []), ...bal(m2.postTokenBalances)],
      },
    };
    const { pairs, aligned } = framesWithInvocations(tx, RAYDIUM_AMM_V4_PROGRAM);
    expect(aligned).toBe(true);
    expect(pairs.map((x) => x.inv.accounts[1])).toEqual([
      'J3b6dvheS2Y1cbMtVz5TCWXNegSjJDbUKxdUVDPoqmS7',
      '6UmmUiYoBjSrhakAobJw8BvkmJtDVxaeBtbt7rxWo1mg',
    ]);
    // arc/SOL: the swap of the first transaction alone (outer instruction 3, as there)
    expect(
      decoders.raydium_amm_v4?.(tx, 'J3b6dvheS2Y1cbMtVz5TCWXNegSjJDbUKxdUVDPoqmS7').events,
    ).toEqual([
      {
        kind: 'swap',
        pool: 'J3b6dvheS2Y1cbMtVz5TCWXNegSjJDbUKxdUVDPoqmS7',
        ixIndex: 3,
        amount0: '1149140194',
        amount1: '3667553000',
        zeroForOne: false,
      },
    ]);
    // RAY/USDC: the deposit of the second alone, its outer instruction 2 now 2 + 4 = 6
    expect(
      decoders.raydium_amm_v4?.(tx, '6UmmUiYoBjSrhakAobJw8BvkmJtDVxaeBtbt7rxWo1mg').events,
    ).toMatchObject([
      { kind: 'liquidity', action: 'increase', ixIndex: 6, amount0: '19818', amount1: '43614' },
    ]);
    expect(outer1).toBe(4);
  });

  it('logs that do not pair with the instructions are flagged, not guessed', () => {
    const f = fx('raydium_amm_v4-SwapBaseIn');
    const logs = f.tx.meta?.logMessages ?? [];
    // one more AMM v4 frame in the logs than the transaction has AMM v4 instructions
    const extra = [
      `Program ${RAYDIUM_AMM_V4_PROGRAM} invoke [1]`,
      `Program ${RAYDIUM_AMM_V4_PROGRAM} success`,
    ];
    const tx = {
      ...f.tx,
      meta: { ...(f.tx.meta as NonNullable<RpcTx['meta']>), logMessages: [...logs, ...extra] },
    };
    expect(alignFrames(tx).misaligned.has(RAYDIUM_AMM_V4_PROGRAM)).toBe(true);
    const d = decoders.raydium_amm_v4?.(tx, Object.keys(f.pools)[0] as string);
    expect(d?.events).toEqual([]);
    expect(d?.truncated).toBe(true);
  });
});

describe('Meteora DAMM v1: amounts from the dynamic vaults’ own events', () => {
  it('Swap on DBR/USDC E5H5BX…: the pool’s Swap event is not what the vaults moved', () => {
    const f = fx('meteora_damm_v1-Swap');
    const data = (f.tx.meta?.logMessages ?? [])
      .filter((l) => l.startsWith('Program data: '))
      .map((l) => Buffer.from(l.slice(14), 'base64'));
    // the pool's Swap (48 bytes): in_amount 255,857,515, out_amount 4,971,489, trade_fee 614,058,
    // protocol_fee 153,514, host_fee 0
    const swap = data.find((d) => d.length === 48) as Buffer;
    expect([8, 16, 24, 32, 40].map((o) => swap.readBigUInt64LE(o))).toEqual([
      255_857_515n,
      4_971_489n,
      614_058n,
      153_514n,
      0n,
    ]);
    // the vault program's AddLiquidity (deposit) under it: lp_mint_amount 255,704,015, token_amount 255,704,015
    // (DBR); its RemoveLiquidity (withdrawal): lp_unmint_amount 4,267,533, token_amount 4,971,488 (USDC)
    const vault = data
      .filter((d) => d.length === 24)
      .map((d) => [d.readBigUInt64LE(8), d.readBigUInt64LE(16)]);
    expect(vault).toEqual([
      [255_704_015n, 255_704_015n],
      [4_267_533n, 4_971_488n],
    ]);
    const { d, bal } = run(f);
    // the DBR token vault 153,121,715,428,392 → 153,121,971,132,407 (+255,704,015 = the user's 255,857,529 less the
    // protocol's 153,514, paid to its own account), the USDC token vault 8,056,424,292,807 → 8,056,419,321,319
    // (−4,971,488, one less than Swap's out_amount)
    expect([delta(bal, 0), delta(bal, 1)]).toEqual([255_704_015n, -4_971_488n]);
    expect(d.events).toEqual([
      {
        kind: 'swap',
        pool: 'E5H5BXLranyJFHEzvR3R2j6kGDQ3Fnx8sPKSsgYqyya8',
        ixIndex: 3,
        amount0: '255704015',
        amount1: '4971488',
        zeroForOne: true,
      },
    ]);
  });

  it('AddImbalanceLiquidity on JitoSOL/SOL ERgpKa…: one side only', () => {
    const { d, bal } = run(fx('meteora_damm_v1-AddImbalanceLiquidity'));
    // 10,000,000 lamports (0.01 SOL) into the SOL vault 211,470,491,092,924 → 211,470,501,092,924, none of JitoSOL
    expect([delta(bal, 0), delta(bal, 1)]).toEqual([10_000_000n, 0n]);
    expect(d.events).toMatchObject([
      { kind: 'liquidity', action: 'increase', amount0: '10000000', amount1: '0' },
    ]);
  });

  it('a vault flow whose side the balances do not say is flagged, not netted into the other side', () => {
    const f = fx('meteora_damm_v1-Swap');
    const strip = (rows: NonNullable<RpcTx['meta']>['preTokenBalances']) =>
      (rows ?? []).map(({ mint: _m, ...r }) => r);
    const m = f.tx.meta as NonNullable<RpcTx['meta']>;
    const tx = {
      ...f.tx,
      meta: {
        ...m,
        preTokenBalances: strip(m.preTokenBalances),
        postTokenBalances: strip(m.postTokenBalances),
      },
    };
    const d = decoders.meteora_damm_v1?.(tx, Object.keys(f.pools)[0] as string, {
      mint0: 'DBRiDgJAMsM95moTzJs7M9LnkGErpbv9v6CUR1DXnUu5',
    });
    expect(d?.events).toEqual([]);
    expect(d?.truncated).toBe(true);
  });

  it('needs the pool’s token 0', () => {
    const f = fx('meteora_damm_v1-Swap');
    expect(() => decoders.meteora_damm_v1?.(f.tx, Object.keys(f.pools)[0] as string)).toThrow(
      /mint0/,
    );
  });
});

describe('Meteora DAMM v2: EvtSwap2 and EvtClaimPositionFee', () => {
  it('Swap2 on MET/USDC Bnztue…: MET in, USDC out, the fee kept in the pool', () => {
    const { d, bal } = run(fx('meteora_damm_v2-Swap2'));
    // EvtSwap2: trade_direction @48 = 0 (A to B), collect_fee_mode @49 = 1, has_referral @50 = 0,
    // included_fee_input_amount @68 = 61,000,000, output_amount @92 = 23,484,769, claiming_fee @116 = 189,780,
    // protocol_fee @124 = 47,444; reserve_a/b_amount @180/@188 = 4,445,190,898,519 / 1,607,316,274,037.
    // The MET vault 4,445,129,920,555 → 4,445,190,920,555 (+61,000,000), the USDC vault 2,192,173,457,952 →
    // 2,192,149,973,183 (−23,484,769): the fees taken from the output stay in the vault
    expect([delta(bal, 0), delta(bal, 1)]).toEqual([61_000_000n, -23_484_769n]);
    expect(d.events).toMatchObject([
      {
        kind: 'swap',
        amount0: '61000000',
        amount1: '23484769',
        zeroForOne: true,
        reserve0After: '4445190898519',
        reserve1After: '1607316274037',
      },
    ]);
  });

  it('ClaimPositionFee: fee_b_claimed 155,411 leaves the USDC vault', () => {
    const { d, bal } = run(fx('meteora_damm_v2-ClaimPositionFee'));
    // 2,191,598,861,142 → 2,191,598,705,731 = −155,411; the MET vault is unchanged (fee_a_claimed 0)
    expect([delta(bal, 0), delta(bal, 1)]).toEqual([0n, -155_411n]);
    expect(d.events).toMatchObject([{ kind: 'fees', amount0: '0', amount1: '155411' }]);
  });
});

describe('PumpSwap: BuyEvent, SellEvent and the fees the v2 instructions hold', () => {
  it('Sell (v1) on TRX/USDC Comiec…: the protocol fee is paid out with the trade', () => {
    const { d, bal } = run(fx('pumpswap-Sell'));
    // SellEvent: base_amount_in @24 = 64,606,563, quote_amount_out @72 = 21,187,514, lp_fee @88 = 52,969,
    // protocol_fee @104 = 10,594, quote_amount_out_without_lp_fee @112 = 21,134,545 (= 21,187,514 − 52,969),
    // user_quote_amount_out @120 = 21,123,951 (= 21,134,545 − 10,594); the event names a fee recipient, so nothing
    // is held. Base vault 4,063,548,509,549 → 4,063,613,116,112 (+64,606,563), quote vault 1,332,648,837,252 →
    // 1,332,627,702,707 (−21,134,545)
    expect([delta(bal, 0), delta(bal, 1)]).toEqual([64_606_563n, -21_134_545n]);
    expect(d.events).toMatchObject([
      { kind: 'swap', amount0: '64606563', amount1: '21134545', zeroForOne: true },
    ]);
  });

  it('BuyExactQuoteInV2 on RARI/RACE ioaDGk…: the creator and protocol fees stay in the quote vault', () => {
    const { d, bal } = run(fx('pumpswap-BuyExactQuoteInV2'));
    // BuyEvent: base_amount_out 3,524,216,799, quote_amount_in_with_lp_fee @112 = 5,920, protocol_fee @104 = 3,
    // coin_creator_fee @360 = 60, protocol_fee_recipient @256 the zero key, ix_name "buy_exact_quote_in_v2"
    // (21 bytes @413), buyback_fee @458 = 1. The quote vault 111,716,840 → 111,722,822 = +5,982
    // = 5,920 + 60 + 3 − 1; the base vault 69,579,902,757,331 → 69,576,378,540,532 = −3,524,216,799
    expect([delta(bal, 0), delta(bal, 1)]).toEqual([-3_524_216_799n, 5_982n]);
    expect(d.events).toMatchObject([
      { kind: 'swap', amount0: '3524216799', amount1: '5982', zeroForOne: false },
    ]);
  });

  it('an older, shorter Buy or Sell decodes when it names its fee recipient, else goes to unknown', () => {
    const sellFx = fx('pumpswap-Sell'); // a v1 SellEvent, 449 bytes, protocol_fee_recipient @256 non-zero
    const v2Fx = fx('pumpswap-SellV2'); // v2 SellEvents, protocol_fee_recipient the zero key
    const pay = (f: Fx) => dlmmEventPayloads(f.tx, txAccountKeys(f.tx), PUMPSWAP_PROGRAM);
    const sell = pay(sellFx).find(([, d]) => d.length === 449) as [number, Uint8Array];
    const pool = 'ComiecDMCEQg1xyoGzVt6B8xGNdGgvvYRuwzbtDb6FY';
    // cut to 320 or 352 bytes (a layout before coin_creator_fee @360): the recipient @256..288 is still there and
    // non-zero, so nothing is held and the amounts are the 449-byte event's: 64,606,563 in, 21,134,545 out
    for (const n of [320, 352]) {
      const und: string[] = [];
      expect(decodePumpSwapEvents([[sell[0], sell[1].subarray(0, n)]], pool, und)).toMatchObject([
        { kind: 'swap', amount0: '64606563', amount1: '21134545', zeroForOne: true },
      ]);
      expect(und).toEqual([]);
    }
    // a v2 SellEvent cut to 352: the zero recipient says fees were held, but coin_creator_fee @360 is gone, so the
    // vault flow cannot be said; the payload goes to unknown rather than vanishing
    const v2Pool = 'ioaDGkQUh6h5nNTmcv8k3NvAgSTiS3xMFNaN3j11KzV';
    const v2 = pay(v2Fx).find(([, d]) => new Reader(d).pubkey(128) === v2Pool) as [
      number,
      Uint8Array,
    ];
    const und: string[] = [];
    expect(decodePumpSwapEvents([[v2[0], v2[1].subarray(0, 352)]], v2Pool, und)).toEqual([]);
    expect(und).toHaveLength(1);
    expect(und[0]).toMatch(/^3e2f370aa503dc2a\/352:/);
    // and one too short to name its pool (under 160 bytes) too
    const und2: string[] = [];
    expect(decodePumpSwapEvents([[sell[0], sell[1].subarray(0, 150)]], pool, und2)).toEqual([]);
    expect(und2).toHaveLength(1);
  });

  it('a sweep pays the held fees out of the quote vault', () => {
    const { d, bal } = run(fx('pumpswap-SweepProtocolFee'));
    // eight SweepPoolFeeEvents for several pools; the one naming Comiec… (pool @24) has amount @184 = 168:
    // the quote vault 1,332,565,256,680 → 1,332,565,256,512
    expect(delta(bal, 1)).toBe(-168n);
    expect(d.events).toMatchObject([{ kind: 'fees', amount0: '0', amount1: '168' }]);
  });

  it('a pool created by a migration opens with what its vaults hold', () => {
    const { d, bal } = run(fx('pumpswap-CreatePool'));
    // CreatePoolEvent: base_amount_in @124 = 206,900,000,000,000, quote_amount_in @132 = 23,722,070; the boost set
    // up in the same transaction (InitBoostEvent) leaves real_quote_reserves_after @136 = 18,813,974 in the quote
    // vault, which opens at exactly that
    expect(bal.pre).toEqual([null, null]);
    expect(bal.post).toEqual(['206900000000000', '18813974']);
    expect(d.events).toMatchObject([
      { kind: 'liquidity', action: 'open', amount0: '206900000000000', amount1: '18813974' },
    ]);
  });
});

describe('the frozen transactions', () => {
  it('are twenty, none truncated', () => {
    const names = readdirSync(join(root, 'fixtures/risk/txs')).filter((n) =>
      /^(raydium_amm_v4|meteora_damm_v1|meteora_damm_v2|pumpswap)-/.test(n),
    );
    expect(names).toHaveLength(20);
    for (const n of names) expect(run(fx(n.replace(/\.json$/, ''))).d.truncated).toBe(false);
  });
});
