import {
  type Base64EncodedWireTransaction,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  type KeyPairSigner,
  type Signature,
  signTransaction,
} from '@solana/kit';
import type { SolanaRpc } from './rpc';

export type SendResult = { signature: string; slot: number | null; err: unknown };

/** Signs a base64 wire transaction (e.g. from Jupiter `/swap`) with the given keypair. Returns the signed wire form and signature. */
export async function signBase64(
  tx64: string,
  signer: KeyPairSigner,
): Promise<{ wire: Base64EncodedWireTransaction; signature: string }> {
  const bytes = getBase64Encoder().encode(tx64);
  const tx = getTransactionDecoder().decode(bytes);
  const signed = await signTransaction([signer.keyPair], tx);
  return {
    wire: getBase64EncodedWireTransaction(signed),
    signature: getSignatureFromTransaction(signed),
  };
}

/**
 * Sends once and polls for confirmation. No automatic retry (CLAUDE.md): a failed or expired transaction is
 * reported and logged; a human decides whether to build a new one.
 */
export async function sendAndConfirm(
  rpc: SolanaRpc,
  wire: Base64EncodedWireTransaction,
  opts: { timeoutMs?: number; skipPreflight?: boolean } = {},
): Promise<SendResult> {
  const signature = await rpc
    .sendTransaction(wire, {
      encoding: 'base64',
      skipPreflight: opts.skipPreflight ?? false,
      maxRetries: 0n,
      preflightCommitment: 'confirmed',
    })
    .send();
  const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
  while (Date.now() < deadline) {
    const st = await rpc.getSignatureStatuses([signature as Signature]).send();
    const s = st.value[0];
    if (s) {
      if (s.err) return { signature, slot: Number(s.slot), err: s.err };
      if (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')
        return { signature, slot: Number(s.slot), err: null };
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  // Last look with history search: the status cache can miss a just-landed signature.
  const late = await rpc
    .getSignatureStatuses([signature as Signature], { searchTransactionHistory: true })
    .send();
  const l = late.value[0];
  if (
    l &&
    !l.err &&
    (l.confirmationStatus === 'confirmed' || l.confirmationStatus === 'finalized')
  ) {
    return { signature, slot: Number(l.slot), err: null };
  }
  return {
    signature,
    slot: null,
    err: {
      timeout: `not confirmed within ${opts.timeoutMs ?? 120_000} ms; blockhash expired, rebuild before sending again`,
    },
  };
}
