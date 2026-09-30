import { z } from 'zod';
import { ConstraintSheet } from './constraint-sheet.js';
import { Language } from './enums.js';
import { Plan } from './plan.js';
import { UnsignedTx } from './tx.js';

export const PostGoalsRequest = z.object({
  text: z.string().min(3).max(2000),
  language: Language.optional(),
  wallet: z.string().optional(),
});
export const PostGoalsResponse = z.object({
  goalId: z.string(),
  sheet: ConstraintSheet.nullable(),
  validationErrors: z.array(z.object({ path: z.string(), message: z.string() })),
  disclaimer: z.string(),
});

export const PostPlansRequest = z.object({
  goalId: z.string(),
  sheet: ConstraintSheet,
  capitalUsd: z.number().positive(),
  wallet: z.string().optional(),
});
export const PostPlansResponse = Plan;

export const PostPlanTransactionsRequest = z.object({
  wallet: z.string().min(32),
  chain: z.enum(['solana', 'evm']).default('solana'),
});
export const PostPlanTransactionsResponse = z.object({
  planId: z.string(),
  transactions: z.array(UnsignedTx),
  disclaimer: z.string(),
});

export const ApiError = z.object({ error: z.string(), details: z.unknown().optional() });
