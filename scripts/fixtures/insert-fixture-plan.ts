import 'dotenv/config';
import { constraintSheets, createDb, goals, planLegs, plans } from '@colosseum/db';
import { ConstraintSheet, DISCLAIMER } from '@colosseum/schemas';

// Inserts a 3-leg fixture plan (USDY, syrupUSDC, Kamino USDC; 5 USD each) so D3-AM can exercise
// POST /plans/{id}/transactions before the solver exists (D5-AM). The sheet/plan are `fixture`; the transactions are live.
const wallet = process.argv[2];
if (!wallet) throw new Error('usage: insert-fixture-plan.ts <wallet>');
const { db, client } = createDb();
const [goal] = await db
  .insert(goals)
  .values({
    rawText: 'R$3.000 por mês a partir de 2028, resgate em até 7 dias',
    language: 'pt',
    wallet,
  })
  .returning();
if (!goal) throw new Error('goal');
const sheet = ConstraintSheet.parse({
  language: 'pt',
  currency: 'BRL',
  profile: 'income',
  target: { kind: 'monthly_cashflow', amountBrl: 3000, startMonth: '2028-01' },
  horizonMonths: 120,
  liquidityWindowDays: 7,
  riskBudget: 'low',
  creditTolerance: 'limited',
  fxStance: 'hedge_near_term',
});
const [cs] = await db
  .insert(constraintSheets)
  .values({ goalId: goal.id, sheet, valid: true, origin: 'fixture' })
  .returning();
if (!cs) throw new Error('sheet');
const [plan] = await db
  .insert(plans)
  .values({
    goalId: goal.id,
    constraintSheetId: cs.id,
    profile: 'income',
    capitalUsd: '15',
    wallet,
    solverVersion: 'fixture-d3am',
    bindingConstraints: ['fixture: equal weights'],
    disclaimer: DISCLAIMER.en,
  })
  .returning();
if (!plan) throw new Error('plan');
const legs = [
  { assetId: 'usdy', weight: '0.3333', amountUsd: '5', reasoning: 'fixture leg' },
  { assetId: 'syrupusdc', weight: '0.3333', amountUsd: '5', reasoning: 'fixture leg' },
  { assetId: 'kamino-usdc', weight: '0.3334', amountUsd: '5', reasoning: 'fixture leg' },
];
await db.insert(planLegs).values(legs.map((l) => ({ ...l, planId: plan.id })));
console.log(JSON.stringify({ planId: plan.id, wallet, legs: legs.length }));
await client.end();
