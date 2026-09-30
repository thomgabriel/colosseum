export * from './llm';
export * from './rules';

import { parseGoalLlm } from './llm';

/** Parse a goal: LLM when configured, rules otherwise; both validated by the same schema. */
export const parseGoal = parseGoalLlm;
