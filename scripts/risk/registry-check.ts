import { readFileSync } from 'node:fs';
import { checkCollectorRegistry, stockSetDifference } from './lib-registry-merge';

// `tsx scripts/risk/registry-check.ts <file> [--stocks-of <installed registry.json>]`: the checks
// scripts/risk/collector/install.sh runs on a registry before it goes to ~/.colosseum/risk/registry.json
// (lib-registry-merge.ts): every pool readable by the collector, tier A or B, no address twice; with --stocks-of, the
// file's stock set must be the installed registry's stock set, pool for pool (the merge reads the newest
// data/risk/registry-<stamp>.json, which need not be the copy installed). Prints the pools by set and tier; exits 1
// with the first problems found. Reads the files only.
const args = process.argv.slice(2);
const path = args[0];
const at = args.indexOf('--stocks-of');
const installedPath = at >= 0 ? args[at + 1] : undefined;
if (!path || (at >= 0 && !installedPath)) {
  console.error(
    'usage: tsx scripts/risk/registry-check.ts <registry.json> [--stocks-of <installed registry.json>]',
  );
  process.exit(1);
}
type File = { pools?: Array<{ set?: string; tier?: string; address?: string }> };
const file = JSON.parse(readFileSync(path, 'utf8')) as File;
const problems = checkCollectorRegistry(file);
if (installedPath) {
  const installed = JSON.parse(readFileSync(installedPath, 'utf8')) as File;
  problems.push(...stockSetDifference(file, installed));
}
if (problems.length) {
  console.error(problems.slice(0, 10).join('\n'));
  process.exit(1);
}
const by: Record<string, number> = {};
for (const p of file.pools ?? []) {
  const k = `${p.set ?? 'stocks'}:${p.tier}`;
  by[k] = (by[k] ?? 0) + 1;
}
console.log(
  `registry checked: ${file.pools?.length} pools ${JSON.stringify(by)}${installedPath ? `; its stock set is the installed one (${installedPath})` : ''}`,
);
