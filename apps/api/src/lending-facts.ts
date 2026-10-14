import { type Db, riskLendingFacts, riskLendingPools } from '@colosseum/db';
import type { LendingMarketRow } from '@colosseum/risk';
import { LendingPoolFacts } from '@colosseum/schemas';
import { and, desc, eq, inArray, or } from 'drizzle-orm';

// The lending report's sheets, as the API reads them: the newest report run, and the sheets it stored.
// `/risk/facts/lending` lists that run's pools; the asset lookups read the sheets of an asset's markets in
// that same run (asset-lookups.ts), so both serve one report and not two.

/** When the newest lending report ran, or null when none has. */
export async function latestLendingReportAt(db: Db): Promise<Date | null> {
  const [r] = await db
    .select({ t: riskLendingFacts.reportAt })
    .from(riskLendingFacts)
    .orderBy(desc(riskLendingFacts.reportAt))
    .limit(1);
  return r?.t ?? null;
}

/**
 * The lending markets of one token in the newest report: the pools whose token is it (a reserve that lends
 * it) or whose stock is it (a market that takes it as collateral), each with the sheet the report stored. A
 * sheet that does not read as one is left out, never served in part.
 */
export async function lendingMarketsOf(
  db: Db,
  chain: string,
  address: string,
): Promise<LendingMarketRow[]> {
  const pools = await db
    .select({ account: riskLendingPools.account, role: riskLendingPools.role })
    .from(riskLendingPools)
    .where(
      and(
        eq(riskLendingPools.chain, chain),
        or(eq(riskLendingPools.mint, address), eq(riskLendingPools.dexAssetMint, address)),
      ),
    )
    .limit(50);
  if (!pools.length) return [];
  const at = await latestLendingReportAt(db);
  if (!at) return [];
  const rows = await db
    .select({
      account: riskLendingFacts.account,
      venue: riskLendingFacts.venue,
      market: riskLendingFacts.market,
      sheet: riskLendingFacts.sheet,
    })
    .from(riskLendingFacts)
    .where(
      and(
        eq(riskLendingFacts.reportAt, at),
        inArray(
          riskLendingFacts.account,
          pools.map((pool) => pool.account),
        ),
      ),
    );
  const roles = new Map(pools.map((pool) => [pool.account, pool.role]));
  return rows.flatMap((row) => {
    const sheet = LendingPoolFacts.safeParse(row.sheet);
    return sheet.success
      ? [
          {
            account: row.account,
            venue: row.venue,
            market: row.market,
            role: roles.get(row.account) ?? null,
            sheet: sheet.data,
          },
        ]
      : [];
  });
}
