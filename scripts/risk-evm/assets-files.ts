// The repository's files the Robinhood Chain asset list reads (PLAN-ASSETS AS.3), and where its reads are
// frozen. File reads only: no network, no environment, so a test may import it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { defaultRegimeParams } from '@colosseum/risk';
import { UniverseVerdicts } from '@colosseum/schemas';
import { LEG_TYPES } from '../../packages/engine/src/personal/leg-types';
import type { AssetFiles, AssetReads, DiscoveryCut } from './assets-list';
import { stamp } from './registry';

export const PATHS = {
  verdicts: 'scripts/risk/assets/robinhood.verdicts.json',
  tracked: 'scripts/risk/universe/robinhood.json',
  shelf: 'packages/engine/src/personal/fixtures/shelves/robinhood-yield.json',
  deploy: 'deployments/robinhood-testnet.json',
  mainnetConfig: 'contracts/script/config/4663.json',
  content: 'content/stocks/robinhood.json',
  legTypes: 'packages/engine/src/personal/leg-types.ts',
  note: 'docs/vault/research/yield-shelf/robinhood.md',
  noteInputs: 'docs/vault/research/yield-shelf/inputs/robinhood_chain_yield_assets.csv',
  calendar: 'fixtures/risk/us-market-holidays.json',
  fixtures: 'fixtures/risk-evm/assets',
} as const;

/** Where a run's frozen reads go, by the time of the block they were read at. */
export const frozenPath = (reads: AssetReads) =>
  `${PATHS.fixtures}/robinhood-reads-${stamp(new Date(reads.onchain.blockTime * 1000))}.json.gz`;
export const codePath = (reads: AssetReads) =>
  `${PATHS.fixtures}/robinhood-code-${stamp(new Date(reads.onchain.blockTime * 1000))}.json.gz`;

const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
export const readGz = <T>(path: string): T => JSON.parse(gunzipSync(readFileSync(path)).toString());

/** The repository's files the list reads, and the discovery cut it counts pools from. */
export function loadFiles(discovery: DiscoveryCut, root = '.'): Omit<AssetFiles, 'frozenPath'> {
  const at = (p: string) => join(root, p);
  const tracked = json(at(PATHS.tracked)) as {
    inputs: { cut: string };
    assets: Array<{ id: string; address: string }>;
  };
  const deploy = json(at(PATHS.deploy)) as AssetFiles['deploy'];
  const content = json(at(PATHS.content)) as { stocks: Array<{ symbol: string }> };
  return {
    verdicts: UniverseVerdicts.parse(json(at(PATHS.verdicts))),
    verdictsPath: PATHS.verdicts,
    tracked: { path: PATHS.tracked, cut: tracked.inputs.cut, assets: tracked.assets },
    shelf: { path: PATHS.shelf, rows: (json(at(PATHS.shelf)) as AssetFiles['shelf']).rows },
    deploy: { path: PATHS.deploy, cash: deploy.cash, assets: deploy.assets },
    mainnetConfig: {
      path: PATHS.mainnetConfig,
      cashToken: (json(at(PATHS.mainnetConfig)) as { cashToken: string }).cashToken,
    },
    content: { path: PATHS.content, symbols: content.stocks.map((s) => s.symbol) },
    legTypes: { path: PATHS.legTypes, rows: LEG_TYPES },
    notes: [PATHS.note, PATHS.noteInputs, PATHS.shelf].map((p) => ({
      path: p,
      text: readFileSync(at(p), 'utf8'),
    })),
    discovery,
    regime: defaultRegimeParams(json(at(PATHS.calendar))),
    calendarPath: PATHS.calendar,
  };
}
