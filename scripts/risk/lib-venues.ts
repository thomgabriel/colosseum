import {
  decodeClmmPool,
  decodeCpmmPool,
  decodeDlmmPair,
  decodeWhirlpool,
  METEORA_DLMM_PROGRAM,
  ORCA_WHIRLPOOL_PROGRAM,
  RAYDIUM_CLMM_PROGRAM,
  RAYDIUM_CPMM_PROGRAM,
} from '@colosseum/risk';

// The pool venues whose accounts the registry confirms and whose swaps the event decoders read
// (packages/risk/src/events/tx.ts), and the on-chain confirmation of a pool: the owner program is a venue's and the
// pool decodes to its two mints and vaults. Extracted from build-registry.ts (Step 1) so the shelf's registry
// (assets/shelf-pools-solana.ts) confirms its pools with the same code; no I/O here.

export type Venue = 'raydium_clmm' | 'orca_whirlpool' | 'meteora_dlmm' | 'raydium_cpmm';
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
};
export const venueByProgram = new Map(
  Object.entries(VENUES).map(([v, c]) => [c.program, v as Venue]),
);

export type DecodedPool = { mint0: string; mint1: string; vault0: string; vault1: string };

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
  const h = decodeCpmmPool(data);
  return { mint0: h.mint0, mint1: h.mint1, vault0: h.vault0, vault1: h.vault1 };
}

export type Confirmation =
  | ({ ok: true; venue: Venue; program: string } & DecodedPool)
  | { ok: false; reason: string };

/**
 * A pool account confirmed: it exists, its owner is a supported venue's program (and `expected`'s, when given), it
 * decodes, and its mints hold `mint` (when given). The reasons are build-registry.ts's words.
 */
export function confirmPool(
  acc: { owner: string; data: Uint8Array } | null | undefined,
  opts: { expected?: Venue; mint?: string } = {},
): Confirmation {
  if (!acc) return { ok: false, reason: 'account not found' };
  const venue = venueByProgram.get(acc.owner);
  if (!venue) return { ok: false, reason: `unsupported program ${acc.owner}` };
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
