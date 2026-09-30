import 'dotenv/config';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createKeyPairSignerFromPrivateKeyBytes, getAddressEncoder } from '@solana/kit';

// Creates the demo wallet keypair in Solana CLI format (64-byte JSON array). Never overwrites.
const path = process.env.DEMO_WALLET_KEYPAIR_PATH ?? './secrets/demo-wallet.json';
if (existsSync(path)) {
  console.error(`${path} already exists; refusing to overwrite`);
  process.exit(1);
}
const seed = crypto.getRandomValues(new Uint8Array(32));
const signer = await createKeyPairSignerFromPrivateKeyBytes(seed, true);
const pub = getAddressEncoder().encode(signer.address);
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, JSON.stringify(Array.from(new Uint8Array([...seed, ...new Uint8Array(pub)]))), {
  mode: 0o600,
});
console.log(
  JSON.stringify({
    path,
    address: signer.address,
    explorer: `https://solscan.io/account/${signer.address}`,
  }),
);
