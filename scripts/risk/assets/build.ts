import { execFileSync } from 'node:child_process';
import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UniverseChain, UniverseList } from '@colosseum/schemas';

// The asset universe of one chain (docs/risk/PLAN-ASSETS.md AS.2, AS.3; gate ASSET-UNIVERSE).
//   pnpm risk:assets solana      [options of the Solana builder, scripts/risk/assets/README.md]
//   pnpm risk:assets robinhood   [options of the Robinhood Chain builder, scripts/risk-evm/README.md]
// Each chain's builder reads the chain and its listings and returns the list; this command validates it,
// writes scripts/risk/assets/<chain>.json, which is committed, and prints its counts. Read-only on chain.

/** The module of each chain's builder. Each exports `buildList(args: string[]): Promise<Built>`. */
const BUILDERS: Record<UniverseChain, string> = {
  solana: './solana',
  robinhood: '../../risk-evm/assets',
};
type Built = { list: unknown; lines?: string[] };

const OUT_DIR = 'scripts/risk/assets';
const args = process.argv.slice(2);
const chain = UniverseChain.safeParse(args[0]);
if (!chain.success) {
  console.error('usage: pnpm risk:assets <solana | robinhood> [options]');
  process.exit(1);
}
const mod = (await import(BUILDERS[chain.data])) as {
  buildList: (args: string[]) => Promise<Built>;
};
const built = await mod.buildList(args.slice(1));
const parsed = UniverseList.safeParse(built.list);
if (!parsed.success) {
  console.error('the list does not validate, nothing written:');
  for (const i of parsed.error.issues.slice(0, 40))
    console.error(`  ${i.path.join('.')}: ${i.message}`);
  process.exit(1);
}
const list = parsed.data;
if (list.chain !== chain.data) {
  console.error(`the ${chain.data} builder returned a list of ${list.chain}`);
  process.exit(1);
}

const out = join(OUT_DIR, `${list.chain}.json`);
writeFileSync(`${out}.tmp`, `${JSON.stringify(list, null, 2)}\n`);
renameSync(`${out}.tmp`, out);
// the repository's formatter has the last word on a committed file
execFileSync('pnpm', ['exec', 'biome', 'format', '--write', out], { stdio: 'ignore' });

const say = (s = '') => console.log(s);
for (const line of built.lines ?? []) say(line);
say();
const c = list.counts;
say(`${c.rows} rows on ${list.chain}, read at ${list.fetchedAt}`);
const table = (title: string, m: Record<string, number>) =>
  say(
    `${title}: ${Object.entries(m)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')}`,
  );
table('by category', c.byCategory);
table('by status', c.byStatus);
table('by class', c.byClass);
say('null, by field and reason:');
for (const [field, reasons] of Object.entries(c.nulls))
  say(
    `  ${field}: ${Object.entries(reasons)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')}`,
  );
say('reads:');
for (const r of list.reads)
  say(
    `  ${r.name}: ${r.rows} rows, ${r.calls} calls, ${(r.durationMs / 1000).toFixed(1)} s, ${r.errors} errors (${r.what})`,
  );
say(JSON.stringify({ wrote: out, rows: c.rows, byStatus: c.byStatus }));
