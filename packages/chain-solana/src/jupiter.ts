import { z } from 'zod';

/**
 * Jupiter Swap API v1 client. Quote + whole-transaction build (`/swap`) for single-leg execution,
 * and `/swap-instructions` for composed transactions (policy mechanism A, D2-PM).
 * Rate limits: keyless tier is ~5 requests per window; a key (`JUPITER_API_KEY`) is required for execution.
 */
const BASE = () => process.env.JUPITER_API_BASE ?? 'https://api.jup.ag/swap/v1';

const headers = (json = false): Record<string, string> => ({
  accept: 'application/json',
  ...(json ? { 'content-type': 'application/json' } : {}),
  ...(process.env.JUPITER_API_KEY ? { 'x-api-key': process.env.JUPITER_API_KEY } : {}),
});

export const JupiterQuote = z
  .object({
    inputMint: z.string(),
    inAmount: z.string(),
    outputMint: z.string(),
    outAmount: z.string(),
    otherAmountThreshold: z.string(),
    swapMode: z.string(),
    slippageBps: z.number(),
    priceImpactPct: z.string(),
    routePlan: z.array(z.unknown()),
    contextSlot: z.number().optional(),
    timeTaken: z.number().optional(),
  })
  .passthrough();
export type JupiterQuote = z.infer<typeof JupiterQuote>;

export class JupiterError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'JupiterError';
  }
}

export async function getQuote(params: {
  inputMint: string;
  outputMint: string;
  amountBase: bigint;
  slippageBps?: number;
}): Promise<JupiterQuote> {
  const url = `${BASE()}/quote?inputMint=${params.inputMint}&outputMint=${params.outputMint}&amount=${params.amountBase}&slippageBps=${params.slippageBps ?? 50}`;
  const res = await fetch(url, { headers: headers() });
  const body = await res.json();
  if (!res.ok)
    throw new JupiterError(
      `quote failed: ${res.status} ${JSON.stringify(body).slice(0, 200)}`,
      res.status,
      body,
    );
  return JupiterQuote.parse(body);
}

export const JupiterSwapResponse = z
  .object({
    swapTransaction: z.string(),
    lastValidBlockHeight: z.number(),
    prioritizationFeeLamports: z.number().optional(),
  })
  .passthrough();

/** Whole unsigned VersionedTransaction (base64) for `userPublicKey`. Output lands in `destinationTokenAccount` if given. */
export async function buildSwapTx(params: {
  quote: JupiterQuote;
  userPublicKey: string;
  destinationTokenAccount?: string;
  wrapAndUnwrapSol?: boolean;
}) {
  const res = await fetch(`${BASE()}/swap`, {
    method: 'POST',
    headers: headers(true),
    body: JSON.stringify({
      quoteResponse: params.quote,
      userPublicKey: params.userPublicKey,
      destinationTokenAccount: params.destinationTokenAccount,
      wrapAndUnwrapSol: params.wrapAndUnwrapSol ?? false,
      dynamicComputeUnitLimit: true,
      dynamicSlippage: false,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: { maxLamports: 1_000_000, priorityLevel: 'medium' },
      },
    }),
  });
  const body = await res.json();
  if (!res.ok)
    throw new JupiterError(
      `swap build failed: ${res.status} ${JSON.stringify(body).slice(0, 200)}`,
      res.status,
      body,
    );
  return JupiterSwapResponse.parse(body);
}

export const JupiterInstruction = z.object({
  programId: z.string(),
  accounts: z.array(
    z.object({ pubkey: z.string(), isSigner: z.boolean(), isWritable: z.boolean() }),
  ),
  data: z.string(),
});
export const JupiterSwapInstructions = z
  .object({
    computeBudgetInstructions: z.array(JupiterInstruction),
    setupInstructions: z.array(JupiterInstruction),
    swapInstruction: JupiterInstruction,
    cleanupInstruction: JupiterInstruction.nullable().optional(),
    otherInstructions: z.array(JupiterInstruction).optional(),
    addressLookupTableAddresses: z.array(z.string()),
  })
  .passthrough();
export type JupiterSwapInstructions = z.infer<typeof JupiterSwapInstructions>;

/** Instruction set for composing a custom transaction (used by the delegated-execution path). */
export async function getSwapInstructions(params: {
  quote: JupiterQuote;
  userPublicKey: string;
  destinationTokenAccount?: string;
}) {
  const res = await fetch(`${BASE()}/swap-instructions`, {
    method: 'POST',
    headers: headers(true),
    body: JSON.stringify({
      quoteResponse: params.quote,
      userPublicKey: params.userPublicKey,
      destinationTokenAccount: params.destinationTokenAccount,
      wrapAndUnwrapSol: false,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: { maxLamports: 1_000_000, priorityLevel: 'medium' },
      },
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new JupiterError(`swap-instructions failed: ${res.status}`, res.status, body);
  return JupiterSwapInstructions.parse(body);
}
