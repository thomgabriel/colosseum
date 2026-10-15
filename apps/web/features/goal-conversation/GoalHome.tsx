'use client';
import { PortfolioSummary } from '../portfolio/PortfolioSummary';
import { usePortfolio } from '../portfolio/use-portfolio';
import { GoalEntry } from './GoalEntry';

// The goal page reads the person's vaults once, for the conversations panel and for the vault summary
// under it; the panel also reads them as the portfolio overview does, to name them by their goals.
export function GoalHome() {
  const { state } = usePortfolio();
  return (
    <div className="group/goal flex min-w-0 flex-col gap-8 md:min-h-0 md:flex-1">
      <GoalEntry portfolio={state} />
      {/* Not drawn under the locked invest screen; /portfolio/monitor keeps the full portfolio. */}
      <div className="md:group-has-[[data-ui=goal-conversation]]/goal:hidden">
        <PortfolioSummary state={state} />
      </div>
    </div>
  );
}
