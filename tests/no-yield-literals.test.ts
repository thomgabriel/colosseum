import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// CLAUDE.md: no hard-coded APYs anywhere outside fixtures/. This test fails the build on a numeric yield literal.
// A literal zero is allowed: it states the absence of yield by construction (equity, cash, BRL leg), not a figure.
const ROOT = join(__dirname, '..');
const SCAN = ['apps', 'packages', 'scripts'];
const SKIP = new Set(['node_modules', 'dist', '.next', 'migrations', 'fixtures']);
const PATTERNS = [
  /\b(apy|apr|yield|haircutYield|quotedYield|supplyApy)\w*\s*[:=]\s*-?(?!0\b)\d+(\.\d+)?\b/i,
  /\b\d+(\.\d+)?\s*%\s*(apy|apr|yield)\b/i,
];

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx|js|mjs|json)$/.test(name) && !name.endsWith('.test.ts')) yield p;
  }
}

describe('no numeric yield literals outside fixtures/', () => {
  it('finds none', () => {
    const hits: string[] = [];
    for (const dir of SCAN) {
      for (const file of walk(join(ROOT, dir))) {
        const lines = readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, i) => {
          if (PATTERNS.some((re) => re.test(line)))
            hits.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
        });
      }
    }
    expect(hits).toEqual([]);
  });
});
