import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export * from './executions.js';
export * from './schema.js';
export { schema };

export function createDb(
  url = process.env.DATABASE_URL ?? 'postgres://colosseum:colosseum@localhost:5433/colosseum',
) {
  const client = postgres(url);
  return { db: drizzle(client, { schema }), client };
}
export type Db = ReturnType<typeof createDb>['db'];
