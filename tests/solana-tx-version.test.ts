import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Mainnet carries version-1 transactions (seen 2026-10-13). A getTransaction or getBlock that asks with
// maxSupportedTransactionVersion 0 is refused for any of them, so a read of other parties' transactions, or of
// our own once a wallet rebuilds one, fails. Code that reads mainnet asks with 1 (MAX_TX_VERSION in
// packages/chain-solana/src/vault/rpc.ts). Local-validator and LiteSVM tests read only transactions they built,
// and live under programs/ and tests/, which this does not scan.
const ROOT = join(__dirname, '..');
const SCAN = ['apps', 'packages', 'scripts'];
const SKIP = new Set(['node_modules', 'dist', '.next', 'archive']);
const PATTERN = /maxSupportedTransactionVersion\s*:\s*0\b/;

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) yield p;
  }
}

describe('Solana transaction reads accept version 1', () => {
  it('finds no maxSupportedTransactionVersion 0 in apps, packages or scripts', () => {
    const hits: string[] = [];
    for (const dir of SCAN)
      for (const file of walk(join(ROOT, dir)))
        readFileSync(file, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            if (PATTERN.test(line)) hits.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
          });
    expect(hits).toEqual([]);
  });
});
