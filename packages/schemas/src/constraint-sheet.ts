import { z } from 'zod';
import { Language, Profile } from './enums.js';

const YearMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'expected YYYY-MM');

export const GoalTarget = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('monthly_cashflow'),
    amountBrl: z.number().positive(),
    startMonth: YearMonth,
    endMonth: YearMonth.optional(),
  }),
  z.object({
    kind: z.literal('balance'),
    amountBrl: z.number().positive(),
    byMonth: YearMonth,
  }),
]);
export type GoalTarget = z.infer<typeof GoalTarget>;

/**
 * Typed output of the goal parser. The solver runs only on a sheet that passed this schema.
 * Every field is user-editable in the UI.
 */
export const ConstraintSheet = z
  .object({
    language: Language,
    currency: z.literal('BRL'),
    target: GoalTarget,
    profile: Profile,
    horizonMonths: z.number().int().min(1).max(600),
    liquidityWindowDays: z.number().int().min(0).max(365),
    riskBudget: z.enum(['low', 'medium', 'high']),
    creditTolerance: z.enum(['none', 'limited', 'accept']),
    fxStance: z.enum(['hedge_near_term', 'accept_fx']),
    initialCapitalUsd: z.number().nonnegative().optional(),
    monthlyContributionBrl: z.number().nonnegative().optional(),
    notes: z.string().max(2000).optional(),
  })
  .refine((s) => !(s.target.kind === 'monthly_cashflow' && s.profile !== 'income'), {
    message: 'a monthly cash-flow target is an income goal; profile must be income',
    path: ['profile'],
  })
  .refine((s) => !(s.profile === 'high_risk' && s.riskBudget === 'low'), {
    message: 'high_risk profile requires a medium or high risk budget',
    path: ['riskBudget'],
  });
export type ConstraintSheet = z.infer<typeof ConstraintSheet>;
