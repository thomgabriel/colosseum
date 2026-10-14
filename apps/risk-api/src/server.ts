import './env';
import { warmRiskReads } from '../../api/src/routes/risk-dex';
import { buildRiskApp } from './app';

const app = await buildRiskApp();
const port = Number(process.env.RISK_API_PORT ?? 3002);
await app.listen({ port, host: '0.0.0.0' });
app.log.info(`risk API docs at http://localhost:${port}/docs`);
// What the analytics pages read first is read once now, so the first visitor after a start does not wait.
warmRiskReads(app, (msg) => app.log.info(msg)).catch((err) =>
  app.log.warn({ err }, 'risk reads not warmed'),
);
