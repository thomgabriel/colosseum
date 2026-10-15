import { ChainError, CREATOR_LIMITS_V1, CreatorLimits } from '@colosseum/schemas';
import {
  type Address,
  appendTransactionMessageInstruction,
  type Commitment,
  compileTransaction,
  createTransactionMessage,
  type GetLatestBlockhashApi,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getStructDecoder,
  getU8Decoder,
  getU16Decoder,
  pipe,
  type Rpc,
  type SimulateTransactionApi,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import { creatorLimitsInstruction } from './program';
import { ask } from './rpc';

// The author limits as the program says them: `creator_limits` answers them as return data, and this
// simulates it, so the app reads the numbers of the program it talks to and keeps no copy of its own
// (gate SHARED-RULES-V2). A program built before the instruction existed answers Anchor's "no such
// instruction" (101): that program holds the first rules, which are its constants.

/** Anchor's `InstructionFallbackNotFound`: the program has no instruction with that discriminator. */
const NO_SUCH_INSTRUCTION = 101;

const limitsDecoder = getStructDecoder([
  ['rules', getU8Decoder()],
  ['minAssets', getU8Decoder()],
  ['maxAssets', getU8Decoder()],
  ['minWeightBps', getU16Decoder()],
  ['maxWeightBps', getU16Decoder()],
  ['stepBps', getU16Decoder()],
  ['sumBps', getU16Decoder()],
  ['maxTurnoverBps', getU16Decoder()],
]);

/** The return data of `creator_limits`, as the schema has the limits. Throws on anything else. */
export function decodeCreatorLimits(data: Uint8Array): CreatorLimits {
  return CreatorLimits.parse(limitsDecoder.decode(data));
}

/**
 * Simulates `creator_limits` with `payer` as the fee payer, which has to be an account the node knows
 * with lamports in it (Config's admin is): a simulation charges no fee, but the node still checks the
 * payer could pay one. Nothing is signed and nothing is sent.
 */
export async function readCreatorLimits(input: {
  rpc: Rpc<SimulateTransactionApi & GetLatestBlockhashApi>;
  program: Address;
  payer: Address;
  commitment?: Commitment;
}): Promise<CreatorLimits> {
  const commitment = input.commitment ?? 'confirmed';
  const latest = await ask('getLatestBlockhash', () =>
    input.rpc.getLatestBlockhash({ commitment }).send(),
  );
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(input.payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latest.value, m),
    (m) => appendTransactionMessageInstruction(creatorLimitsInstruction(input), m),
  );
  const wire = getBase64EncodedWireTransaction(compileTransaction(message));
  const simulated = await ask('simulateTransaction', () =>
    input.rpc
      .simulateTransaction(wire, {
        encoding: 'base64',
        sigVerify: false,
        replaceRecentBlockhash: false,
        commitment,
      })
      .send(),
  );
  const { err, returnData } = simulated.value;
  if (err) {
    const custom = customError(err);
    if (custom === NO_SUCH_INSTRUCTION) return CREATOR_LIMITS_V1;
    throw new ChainError(
      'Unavailable',
      `the vault program ${input.program} did not answer its author limits: ${JSON.stringify(err, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`,
    );
  }
  if (!returnData || returnData.programId !== input.program)
    throw new ChainError(
      'Unavailable',
      `the vault program ${input.program} answered no author limits`,
    );
  return decodeCreatorLimits(new Uint8Array(getBase64Encoder().encode(returnData.data[0])));
}

/** The program's own error number in a simulation's `err`, or null when it is another kind. */
function customError(err: unknown): number | null {
  if (typeof err !== 'object' || err === null || !('InstructionError' in err)) return null;
  const [, inner] = (err as { InstructionError: [unknown, unknown] }).InstructionError;
  if (typeof inner !== 'object' || inner === null || !('Custom' in inner)) return null;
  return Number((inner as { Custom: number | bigint }).Custom);
}
