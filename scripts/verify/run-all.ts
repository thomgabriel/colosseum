import 'dotenv/config';
import { spawnSync } from 'node:child_process';

// Runs V1..V7 in order and prints one JSON line per check. V4 = one depth snapshot (scripts/depth-snapshot.ts).
const steps = [
  'v1-yields',
  'v2-jupiter',
  'v3-kamino-sdk',
  '../depth-snapshot',
  'v5-delegation',
  'v6-mints',
  'v7-bcb',
];
for (const s of steps) {
  const r = spawnSync('pnpm', ['exec', 'tsx', new URL(`./${s}.ts`, import.meta.url).pathname], {
    stdio: 'inherit',
    env: process.env,
  });
  if (r.status !== 0)
    console.log(JSON.stringify({ id: s, status: 'fail', note: `exit ${r.status}` }));
}
