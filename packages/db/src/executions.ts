import { eq } from 'drizzle-orm';
import type { Db } from './index.js';
import { executions } from './schema.js';

export type ExecutionInsert = typeof executions.$inferInsert;

/**
 * Every mainnet transaction gets one row: `built` before signing, then `sent`, then `confirmed` or `failed`.
 * The explorer link is stored as soon as the signature is known. Callers never retry a failed row automatically.
 */
export async function recordBuilt(
  db: Db,
  row: Omit<ExecutionInsert, 'status' | 'id' | 'createdAt' | 'confirmedAt'>,
) {
  const [r] = await db
    .insert(executions)
    .values({ ...row, status: 'built' })
    .returning({ id: executions.id });
  if (!r) throw new Error('insert executions returned no id');
  return r.id;
}

export async function markSent(db: Db, id: string, signature: string, explorerUrl: string) {
  await db
    .update(executions)
    .set({ status: 'sent', signature, explorerUrl })
    .where(eq(executions.id, id));
}

export async function markConfirmed(db: Db, id: string, amountOut?: string) {
  await db
    .update(executions)
    .set({ status: 'confirmed', confirmedAt: new Date(), ...(amountOut ? { amountOut } : {}) })
    .where(eq(executions.id, id));
}

export async function markFailed(db: Db, id: string, error: string) {
  await db
    .update(executions)
    .set({ status: 'failed', error: error.slice(0, 2000) })
    .where(eq(executions.id, id));
}
