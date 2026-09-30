import 'dotenv/config';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { createKeyPairSignerFromBytes, getBase58Encoder } from '@solana/kit';

// Imports a base58 private key exported from Phantom into the keypair file the scripts use.
// Refuses to overwrite an existing file unless WALLET_OVERWRITE=1.
const path = process.env.DEMO_WALLET_KEYPAIR_PATH ?? './secrets/demo-wallet.json';
if (existsSync(path) && process.env.WALLET_OVERWRITE !== '1') {
  console.error(`${path} exists; set WALLET_OVERWRITE=1 to replace it`);
  process.exit(1);
}
const rl = createInterface({ input: process.stdin, output: process.stdout });
const key = (await rl.question('Paste the base58 private key from Phantom: ')).trim();
rl.close();
const bytes = new Uint8Array(getBase58Encoder().encode(key));
if (bytes.length !== 64) throw new Error(`expected a 64-byte key, got ${bytes.length}`);
const signer = await createKeyPairSignerFromBytes(bytes);
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, JSON.stringify(Array.from(bytes)), { mode: 0o600 });
console.log(JSON.stringify({ path, address: signer.address }));
