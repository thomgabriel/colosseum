import { leaderboardMetadata } from '../../../components/shell/metadata';
import { LeaderboardScreen } from '../../../features/leaderboard/LeaderboardScreen';

// Every open vault on the chain, ranked by what it made, for everyone.

export function generateMetadata() {
  return leaderboardMetadata();
}

export default function LeaderboardPage() {
  return <LeaderboardScreen />;
}
