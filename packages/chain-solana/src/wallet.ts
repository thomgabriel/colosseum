import { readFileSync } from 'node:fs';
import { createKeyPairSignerFromBytes, type KeyPairSigner } from '@solana/kit';

/** Loads a Solana-CLI-format keypair file (JSON array of 64 bytes). Path from DEMO_WALLET_KEYPAIR_PATH by default. */
export async function loadKeypair(
  path = process.env.DEMO_WALLET_KEYPAIR_PATH ?? './secrets/demo-wallet.json',
): Promise<KeyPairSigner> {
  const bytes = new Uint8Array(JSON.parse(readFileSync(path, 'utf8')) as number[]);
  if (bytes.length !== 64)
    throw new Error(`keypair file ${path}: expected 64 bytes, got ${bytes.length}`);
  return createKeyPairSignerFromBytes(bytes);
}
