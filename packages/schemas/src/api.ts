import { z } from 'zod';
import { ConstraintSheet } from './constraint-sheet';
import { Language } from './enums';
import { Plan } from './plan';
import { UnsignedTx } from './tx';

export const PostGoalsRequest = z.object({
  text: z.string().min(3).max(2000),
  language: Language.optional(),
  wallet: z.string().optional(),
});
export const PostGoalsResponse = z.object({
  goalId: z.string(),
  sheet: ConstraintSheet.nullable(),
  /** The parser's raw proposal, for the editor to prefill even when validation failed. */
  candidate: z.record(z.string(), z.unknown()),
  validationErrors: z.array(z.object({ path: z.string(), message: z.string() })),
  parser: z.object({ method: z.enum(['rules', 'llm']), model: z.string().optional() }),
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
