import './env';
import { createDb, seedChains } from '@colosseum/db';
import { parseChainConfigs } from '@colosseum/schemas';
import { buildApp } from './app';
import { startRiskWarm } from './risk-warm';
import { warmRiskReads } from './routes/risk-dex';
import { shelfWarmed } from './routes/v1';
import { startSnapshotInApi } from './snapshot-in-api';

// The vault tables point at `chains`. Write its rows before serving, and stop if this database was
// seeded for another network than the one the environment names.
const seed = createDb();
await seedChains(seed.db, parseChainConfigs(process.env));
await seed.client.end();

const app = await buildApp();
const port = Number(process.env.API_PORT ?? 3001);
await app.listen({ port, host: '0.0.0.0' });
app.log.info(`docs at http://localhost:${port}/docs`);
// What the analytics pages read first is read once now, so the first visitor after a start does not wait.
// After the shelf, which the app has been working out since it was ready (routes/v1/index.ts).
const warmingUp = warmRiskReads(app, {
  log: (msg) => app.log.info(msg),
  after: shelfWarmed(app),
}).catch((err) => app.log.warn({ err }, 'risk reads not warmed'));
// Then once an hour, after the hourly import, the pages' reads again (gate RISK-WARM; RISK_WARM_AT_MINUTE),
// never beside the warm-up above.
startRiskWarm(app, process.env, { log: app.log, after: warmingUp });
// The snapshot worker's passes in this process, behind SNAPSHOT_IN_API=1; never ends the API.
startSnapshotInApi(process.env, { log: app.log });
