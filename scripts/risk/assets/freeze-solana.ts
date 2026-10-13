// Freezes the reads one Solana run was built from (PLAN-ASSETS AS.2), for tests/risk-assets-solana.test.ts.
//   pnpm risk:freeze-assets-solana <data/assets/solana/solana-reads-<stamp>.json>
//     → fixtures/risk/assets/solana-reads-<stamp>.json.gz: the same object, gzipped. It is already cut
//       to what the list reads (Jupiter's rows to id, symbol and tags; the mint and metadata accounts as
//       base64; the lending rows to their tokens and Scope chains; pool counts per mint), so it holds no
//       price, supply or yield figure. No chain read.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { SolanaReads } from './solana-list';

const [file] = process.argv.slice(2);
const stamp = file ? basename(file).match(/^solana-reads-(\d{8}T\d{4}Z)\.json$/)?.[1] : undefined;
if (!file || !stamp) {
  console.error('usage: freeze-solana.ts <solana-reads-YYYYMMDDTHHMMZ.json>');
  process.exit(1);
}
const reads = JSON.parse(readFileSync(file, 'utf8')) as SolanaReads;
if (reads.chain !== 'solana') throw new Error(`${file} holds the reads of ${reads.chain}`);
mkdirSync('fixtures/risk/assets', { recursive: true });
const out = `fixtures/risk/assets/solana-reads-${stamp}.json.gz`;
const gz = gzipSync(JSON.stringify(reads), { level: 9 });
writeFileSync(out, gz);
console.log(
  JSON.stringify({
    out,
    bytes: gz.length,
    mints: Object.keys(reads.mints).length,
    jupiter: reads.jupiter.length,
  }),
);
