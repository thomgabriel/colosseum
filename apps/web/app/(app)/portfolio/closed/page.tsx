import { ClosedVaultsPage } from '../../../../features/portfolio-section/ClosedVaultsPage';
import { sectionMetadata } from '../../../../features/portfolio-section/metadata';

// The vaults the person closed, each with the way to open it again (gate VAULT-CLOSE-REUSE).

export function generateMetadata() {
  return sectionMetadata('closed');
}

export default function Closed() {
  return <ClosedVaultsPage />;
}
