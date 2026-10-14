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
 * Whether a registered pool lends the token at `address`: a Jupiter Lend vault lends its debt token and takes
 * its own token as collateral; any other pool lends its own token unless its role is `collateral`. A pool
 * found only by the DEX asset its stock maps to takes that asset as collateral.
 */
export function lendsToken(
  pool: { role: string | null; mint: string; debtMint: string | null },
  address: string,
): boolean {
  if (pool.debtMint) return pool.debtMint === address;
  return pool.mint === address && pool.role !== 'collateral' && pool.role !== 'vault';
}

/**
 * The lending markets of one token in the newest report: the pools that lend it (a reserve of it, a curated
 * vault of it, a Jupiter Lend vault whose debt token it is) and those that take it as collateral (its own
 * collateral reserve, a vault whose collateral it is), each with the sheet the report stored and whether it
 * lends the token (`lends`: the sheet's rates are then the token's own). A sheet that does not read as one is
 * left out, never served in part.
 */
export async function lendingMarketsOf(
  db: Db,
  chain: string,
  address: string,
): Promise<LendingMarketRow[]> {
  const pools = await db
    .select({
      account: riskLendingPools.account,
      role: riskLendingPools.role,
      symbol: riskLendingPools.symbol,
      mint: riskLendingPools.mint,
      debtMint: riskLendingPools.debtMint,
      debtSymbol: riskLendingPools.debtSymbol,
    })
    .from(riskLendingPools)
    .where(
      and(
        eq(riskLendingPools.chain, chain),
        or(
          eq(riskLendingPools.mint, address),
          eq(riskLendingPools.dexAssetMint, address),
          // the vaults that lend it against another token
          eq(riskLendingPools.debtMint, address),
        ),
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
  const byAccount = new Map(pools.map((pool) => [pool.account, pool]));
  return rows.flatMap((row) => {
    const sheet = LendingPoolFacts.safeParse(row.sheet);
    const pool = byAccount.get(row.account);
    return sheet.success && pool
      ? [
          {
            account: row.account,
            venue: row.venue,
            market: row.market,
            role: pool.role,
            // the token whose rates the sheet holds: a vault's debt token, or the reserve's own
            lent: pool.debtSymbol ?? pool.symbol,
            lends: lendsToken(pool, address),
            sheet: sheet.data,
          },
        ]
      : [];
  });
}
