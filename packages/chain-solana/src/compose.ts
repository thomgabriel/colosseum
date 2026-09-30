import {
  AccountRole,
  type Address,
  address,
  appendTransactionMessageInstructions,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getSignatureFromTransaction,
  type Instruction,
  type KeyPairSigner,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { fetchAllAddressLookupTable } from '@solana-program/address-lookup-table';
import {
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from '@solana-program/compute-budget';
import type { JupiterSwapInstructions } from './jupiter.js';
import type { SolanaRpc } from './rpc.js';

type JupIx = JupiterSwapInstructions['swapInstruction'];

const role = (isSigner: boolean, isWritable: boolean): AccountRole =>
  isSigner
    ? isWritable
      ? AccountRole.WRITABLE_SIGNER
      : AccountRole.READONLY_SIGNER
    : isWritable
      ? AccountRole.WRITABLE
      : AccountRole.READONLY;

/** Converts a Jupiter JSON instruction into a kit Instruction. */
export function jupiterIxToKit(ix: JupIx): Instruction {
  return {
    programAddress: address(ix.programId),
    accounts: ix.accounts.map((a) => ({
      address: address(a.pubkey),
      role: role(a.isSigner, a.isWritable),
    })),
    data: new Uint8Array(getBase64Encoder().encode(ix.data)),
  };
}

/** All instructions of a Jupiter swap-instructions response, in execution order. */
export function jupiterInstructions(r: JupiterSwapInstructions): Instruction[] {
  return [
    ...r.computeBudgetInstructions,
    ...r.setupInstructions,
    ...(r.otherInstructions ?? []),
    r.swapInstruction,
    ...(r.cleanupInstruction ? [r.cleanupInstruction] : []),
  ].map(jupiterIxToKit);
}

/** Default priority fee for transactions we compose ourselves (Jupiter supplies its own compute-budget ixs). */
export const DEFAULT_PRIORITY = { units: 200_000, microLamportsPerUnit: 500_000n };

/** Prepends compute-unit limit + price unless the instruction list already carries ComputeBudget instructions. */
export function withPriorityFee(ixs: Instruction[], p = DEFAULT_PRIORITY): Instruction[] {
  if (ixs.some((ix) => ix.programAddress === COMPUTE_BUDGET_PROGRAM_ADDRESS)) return ixs;
  return [
    getSetComputeUnitLimitInstruction({ units: p.units }),
    getSetComputeUnitPriceInstruction({ microLamports: p.microLamportsPerUnit }),
    ...ixs,
  ];
}

export type SignedV0 = {
  wire: ReturnType<typeof getBase64EncodedWireTransaction>;
  signature: string;
  instructionCount: number;
};

/**
 * Composes a v0 transaction from instructions and lookup tables, signed by every TransactionSigner embedded in the
 * message (fee payer plus any instruction signer objects). Signers given only as addresses are NOT signed for.
 */
export async function buildSignedV0(
  rpc: SolanaRpc,
  feePayer: KeyPairSigner,
  ixs: Instruction[],
  lutAddresses: string[],
): Promise<SignedV0> {
  const luts = lutAddresses.length
    ? await fetchAllAddressLookupTable(
        rpc,
        lutAddresses.map((a) => address(a)),
      )
    : [];
  const tables = Object.fromEntries(luts.map((l) => [l.address, l.data.addresses])) as Record<
    Address,
    Address[]
  >;
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(withPriorityFee(ixs), m),
    (m) => (luts.length ? compressTransactionMessageUsingAddressLookupTables(m, tables) : m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  return {
    wire: getBase64EncodedWireTransaction(signed),
    signature: getSignatureFromTransaction(signed),
    instructionCount: ixs.length,
  };
}
