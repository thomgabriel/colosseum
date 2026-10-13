import { readFileSync } from 'node:fs';
import { checkCollectorRegistry } from './lib-registry-merge';

// `tsx scripts/risk/registry-check.ts <file>`: the check scripts/risk/collector/install.sh runs on a registry before it
// goes to ~/.colosseum/risk/registry.json (lib-registry-merge.ts checkCollectorRegistry). Prints the pools by set and
// tier; exits 1 with the first problems found. Reads the file only.
const path = process.argv[2];
if (!path) {
  console.error('usage: tsx scripts/risk/registry-check.ts <registry.json>');
  process.exit(1);
}
const file = JSON.parse(readFileSync(path, 'utf8')) as {
  pools?: Array<{ set?: string; tier?: string }>;
};
const problems = checkCollectorRegistry(file);
if (problems.length) {
  console.error(problems.slice(0, 10).join('\n'));
  process.exit(1);
}
const by: Record<string, number> = {};
for (const p of file.pools ?? []) {
  const k = `${p.set ?? 'stocks'}:${p.tier}`;
  by[k] = (by[k] ?? 0) + 1;
}
console.log(`registry checked: ${file.pools?.length} pools ${JSON.stringify(by)}`);
