import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { NotImplementedUntil, parser, schedule, solver } from '@colosseum/engine';

// Runs the three demo goals end to end without executing anything on chain.
const goals = JSON.parse(
  readFileSync(new URL('../fixtures/goals.json', import.meta.url), 'utf8'),
) as Array<{ id: string; text: string }>;
let blocked = false;
for (const g of goals) {
  try {
    const sheet = parser.parseGoal(g.text);
    const plan = solver.solve(sheet);
    schedule.buildSchedule(plan);
    console.log(`${g.id}: ok`);
  } catch (e) {
    if (e instanceof NotImplementedUntil) {
      console.log(`${g.id}: blocked — ${e.message}`);
      blocked = true;
      break;
    }
    throw e;
  }
}
process.exit(blocked ? 2 : 0);
