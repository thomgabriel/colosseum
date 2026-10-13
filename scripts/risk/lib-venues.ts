import {
  decodeAmmV4Pool,
  decodeClmmPool,
  decodeCpmmPool,
  decodeDammV1Pool,
  decodeDammV2Pool,
  decodeDlmmPair,
  decodePumpSwapPool,
  decodeWhirlpool,
  METEORA_DAMM_V1_PROGRAM,
  METEORA_DAMM_V2_PROGRAM,
  METEORA_DLMM_PROGRAM,
  ORCA_WHIRLPOOL_PROGRAM,
  PUMPSWAP_PROGRAM,
  RAYDIUM_AMM_V4_PROGRAM,
  RAYDIUM_CLMM_PROGRAM,
  RAYDIUM_CPMM_PROGRAM,
} from '@colosseum/risk';

// The pool venues whose accounts the registries confirm and whose swaps the event decoders read
// (packages/risk/src/events/tx.ts), and the on-chain confirmation of a pool: the owner program is a venue's and the
// pool decodes to its two mints and vaults. Extracted from build-registry.ts (Step 1) so the shelf's registry
// (assets/shelf-pools-solana.ts) confirms its pools with the same code; no I/O here.

export type Venue =
  | 'raydium_clmm'
  | 'orca_whirlpool'
  | 'meteora_dlmm'
  | 'raydium_cpmm'
  | 'raydium_amm_v4'
  | 'meteora_damm_v1'
  | 'meteora_damm_v2'
  | 'pumpswap';
/** Per venue: its program, its pool account's size (the smallest seen where the program has grown the account),
 *  the offsets of its two mints, and DexScreener's name of it (`dexId` and labels, as shelf-pools.ts `dsVenue`). */
export const VENUES: Record<
  Venue,
  { program: string; size: number; mintOffsets: [number, number]; dexscreener: string }
> = {
  raydium_clmm: {
    program: RAYDIUM_CLMM_PROGRAM,
    size: 1544,
    mintOffsets: [73, 105],
    dexscreener: 'raydium:CLMM',
  },
  orca_whirlpool: {
    program: ORCA_WHIRLPOOL_PROGRAM,
    size: 653,
    mintOffsets: [101, 181],
    dexscreener: 'orca:wp',
  },
  meteora_dlmm: {
    program: METEORA_DLMM_PROGRAM,
    size: 904,
    mintOffsets: [88, 120],
    dexscreener: 'meteora:DLMM',
  },
  raydium_cpmm: {
    program: RAYDIUM_CPMM_PROGRAM,
    size: 637,
    mintOffsets: [168, 200],
    dexscreener: 'raydium:CPMM',
  },
  // ASSET-3 (PLAN-ASSETS AS.12): the venues of the shelf's liquidity no decoder read before. DexScreener names
  // Raydium AMM v4 `raydium` with no label, DAMM v1 `meteora:DYN`, DAMM v2 `meteora:DYN2`.
  raydium_amm_v4: {
    program: RAYDIUM_AMM_V4_PROGRAM,
    size: 752,
    mintOffsets: [400, 432],
    dexscreener: 'raydium',
  },
  meteora_damm_v1: {
    program: METEORA_DAMM_V1_PROGRAM,
    size: 944,
    mintOffsets: [40, 72],
    dexscreener: 'meteora:DYN',
  },
  meteora_damm_v2: {
    program: METEORA_DAMM_V2_PROGRAM,
    size: 1112,
    mintOffsets: [168, 200],
    dexscreener: 'meteora:DYN2',
  },
  pumpswap: {
    program: PUMPSWAP_PROGRAM,
    size: 300,
    mintOffsets: [43, 75],
    dexscreener: 'pumpswap',
  },
};
/**
 * The venues of the Oct 1 stock registry (build-registry.ts, the risk_pools table the collector and the raw arrays
 * read): its on-chain search and its confirmation take these four only, as before ASSET-3, since those readers know
 * no other venue. The shelf's registry (assets/shelf-pools-solana.ts) takes every venue of VENUES.
 */
export const REGISTRY_VENUES: ReadonlySet<Venue> = new Set([
  'raydium_clmm',
  'orca_whirlpool',
  'meteora_dlmm',
  'raydium_cpmm',
]);
export const ALL_VENUES: ReadonlySet<Venue> = new Set(Object.keys(VENUES) as Venue[]);
export const venueByProgram = new Map(
  Object.entries(VENUES).map(([v, c]) => [c.program, v as Venue]),
);

export type DecodedPool = {
  mint0: string;
  mint1: string;
  vault0: string;
  vault1: string;
  /** Set when the pool's vaults hold something other than its two tokens. Meteora DAMM v1 keeps each token in a
   *  dynamic vault shared by every pool of that token and holds that vault's LP token: vault0/vault1 are the pool's
   *  own LP-token accounts (a_vault_lp, b_vault_lp), and aVault/bVault the dynamic vaults. */
  vaultsHold?: { kind: 'dynamic_vault_lp'; aVault: string; bVault: string };
};

/** A venue's pool account decoded to its two mints and vaults (throws when it does not decode). */
export function decodePoolAccount(venue: Venue, data: Uint8Array): DecodedPool {
  if (venue === 'raydium_clmm') {
    const h = decodeClmmPool(data);
    return { mint0: h.mint0, mint1: h.mint1, vault0: h.vault0, vault1: h.vault1 };
  }
  if (venue === 'orca_whirlpool') {
    const h = decodeWhirlpool(data);
    return { mint0: h.mintA, mint1: h.mintB, vault0: h.vaultA, vault1: h.vaultB };
  }
  if (venue === 'meteora_dlmm') {
    const h = decodeDlmmPair(data);
    return { mint0: h.mintX, mint1: h.mintY, vault0: h.reserveX, vault1: h.reserveY };
  }
  if (venue === 'meteora_damm_v1') {
    const h = decodeDammV1Pool(data);
    return {
      mint0: h.mint0,
      mint1: h.mint1,
      vault0: h.aVaultLp,
      vault1: h.bVaultLp,
      vaultsHold: { kind: 'dynamic_vault_lp', aVault: h.aVault, bVault: h.bVault },
    };
  }
  const h =
    venue === 'raydium_cpmm'
      ? decodeCpmmPool(data)
      : venue === 'raydium_amm_v4'
        ? decodeAmmV4Pool(data)
        : venue === 'meteora_damm_v2'
          ? decodeDammV2Pool(data)
          : decodePumpSwapPool(data);
  return { mint0: h.mint0, mint1: h.mint1, vault0: h.vault0, vault1: h.vault1 };
}

export type Confirmation =
  | ({ ok: true; venue: Venue; program: string } & DecodedPool)
  | { ok: false; reason: string };

/**
 * A pool account confirmed: it exists, its owner is the program of one of `venues` (and `expected`'s, when given),
 * it decodes, and its mints hold `mint` (when given). `venues` is the stock registry's four by default
 * (REGISTRY_VENUES); the shelf's registry passes ALL_VENUES. The reasons are build-registry.ts's words.
 */
export function confirmPool(
  acc: { owner: string; data: Uint8Array } | null | undefined,
  opts: { expected?: Venue; mint?: string; venues?: ReadonlySet<Venue> } = {},
): Confirmation {
  if (!acc) return { ok: false, reason: 'account not found' };
  const venue = venueByProgram.get(acc.owner);
  if (!venue || !(opts.venues ?? REGISTRY_VENUES).has(venue))
    return { ok: false, reason: `unsupported program ${acc.owner}` };
  if (opts.expected && venue !== opts.expected)
    return { ok: false, reason: `owner is ${venue}, not ${opts.expected}` };
  let d: DecodedPool;
  try {
    d = decodePoolAccount(venue, acc.data);
  } catch (e) {
    return { ok: false, reason: `decode failed: ${String(e).slice(0, 80)}` };
  }
  if (opts.mint && d.mint0 !== opts.mint && d.mint1 !== opts.mint)
    return { ok: false, reason: `mints ${d.mint0}/${d.mint1} do not hold ${opts.mint}` };
  return { ok: true, venue, program: acc.owner, ...d };
}

type ParsedMints = {
  value: Array<{
    data: {
      parsed: {
        info: {
          decimals: number;
          extensions?: Array<{
            extension: string;
            state: { newerTransferFee?: { transferFeeBasisPoints: number } };
          }>;
        };
      };
    };
  } | null>;
};

/** Decimals and transfer fee of each mint (getMultipleAccounts jsonParsed, 100 a call), through the caller's rpc. */
export async function mintInfos(
  rpc: <T>(method: string, params: unknown[]) => Promise<T>,
  mints: string[],
): Promise<Map<string, { decimals: number; feeBps: number }>> {
  const mintInfo = new Map<string, { decimals: number; feeBps: number }>();
  for (let i = 0; i < mints.length; i += 100) {
    const batch = mints.slice(i, i + 100);
    const r = await rpc<ParsedMints>('getMultipleAccounts', [batch, { encoding: 'jsonParsed' }]);
    for (const [k, v] of r.value.entries()) {
      const info = v?.data.parsed.info;
      if (!info) continue;
      const fee = info.extensions?.find((e) => e.extension === 'transferFeeConfig');
      mintInfo.set(batch[k] as string, {
        decimals: info.decimals,
        feeBps: fee?.state.newerTransferFee?.transferFeeBasisPoints ?? 0,
      });
    }
  }
  return mintInfo;
}
