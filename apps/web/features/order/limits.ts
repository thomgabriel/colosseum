import { ORDER_LIMITS } from '@colosseum/schemas';

// The least and the most a person can put in at once, in dollars: the API's own (gate DEPOSIT-FLOOR).
// In a file of its own so a screen that only checks an amount (features/mix/DepositStep.tsx) is not
// built with the invest card, which draws the order screen and so reaches the signing port.
export const MIN_USD = ORDER_LIMITS.minAmountUsd;
export const MAX_USD = ORDER_LIMITS.maxAmountUsd;
