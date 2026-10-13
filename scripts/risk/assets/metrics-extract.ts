import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { discoveryFor, robinhoodDiscoveryDir } from '../../risk-evm/assets-metrics';

// PLAN-ASSETS AS.6: the Robinhood Chain job reads its pools' TVL from an extract of the newest discovery file, made
// by its installer, because a launchd agent cannot read ~/Documents (where RISK_EVM_DIR is). The extract holds, for
// each row of scripts/risk/assets/robinhood.json, the pools that hold it, measured ones in full, with the file's
// name and time. The discovery file is read only.
//   RISK_EVM_DIR=<dir> tsx scripts/risk/assets/metrics-extract.ts --out <file>

const out = process.argv[process.argv.indexOf('--out') + 1];
if (!out || !process.argv.includes('--out'))
  throw new Error('usage: metrics-extract.ts --out <file>');
const list = JSON.parse(readFileSync('scripts/risk/assets/robinhood.json', 'utf8')) as {
  assets: Array<{ address: string }>;
};
const x = discoveryFor(
  robinhoodDiscoveryDir(),
  list.assets.map((a) => a.address),
);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(x));
console.log(
  `${x.file} (${x.fetchedAt}): ${Object.keys(x.byToken).length} tokens with a pool -> ${out}`,
);
