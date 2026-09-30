import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { getBase58Decoder } from '@solana/kit';

// Prints the demo wallet's private key in base58 (Phantom "Import Private Key" format). Run it yourself:
//   pnpm wallet:export
// The key is printed once to your terminal and nowhere else. Never paste it into chat, docs or commits.
const path = process.env.DEMO_WALLET_KEYPAIR_PATH ?? './secrets/demo-wallet.json';
const bytes = new Uint8Array(JSON.parse(readFileSync(path, 'utf8')) as number[]);
if (bytes.length !== 64) throw new Error(`expected 64 bytes in ${path}`);
console.error(
  'WARNING: the next line is the private key for the demo wallet. Paste it into Phantom only.',
);
console.log(getBase58Decoder().decode(bytes));
