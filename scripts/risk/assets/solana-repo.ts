import { readFileSync } from 'node:fs';
import { REGISTRY } from '@colosseum/engine';
import { LEG_TYPES } from '../../../packages/engine/src/personal/leg-types';
import type { SolanaRepoInputs } from './solana-list';

// The repository's own files the Solana list reads (PLAN-ASSETS AS.2): today's shelf, the Scope table,
// the research note's addresses, the engine's leg types. Files only, no network. The live run saves
// what this returns with its reads; tests/risk-assets-solana.test.ts holds the frozen copy to what the
// files say now, so a change to any of them asks for the list to be built again.

export const FILES = {
  tracked: 'scripts/risk/universe/solana.json',
  shelf: 'packages/engine/src/personal/fixtures/shelves/solana-yield.json',
  deploy: 'deployments/solana-devnet.json',
  structurer: 'packages/engine/src/assets/registry.ts',
  scope: 'fixtures/solana-vault/scope-indexes.json',
  content: 'content/stocks/solana.json',
  seed: 'docs/vault/research/open-questions/launch-shelf.seed.json',
  note: 'docs/vault/research/yield-shelf/solana.md',
  legTypes: 'packages/engine/src/personal/leg-types.ts',
};

const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

/** The repository's own files the list reads, cut to the fields it uses. */
export function repoInputs(): SolanaRepoInputs {
  const tracked = json(FILES.tracked) as {
    assets: Array<{ id: string; symbol: string; address: string }>;
  };
  const shelf = json(FILES.shelf) as {
    rows: Array<{
      asset: { id: string; symbol: string; address: string };
      verdict: string;
      source: string;
    }>;
  };
  const deploy = json(FILES.deploy) as {
    cash: { id: string; modelOf: string };
    assets: Array<{ id: string; modelOf: string }>;
  };
  const scope = json(FILES.scope) as SolanaRepoInputs['scope'] & {
    assets: SolanaRepoInputs['scope']['rows'];
  };
  const content = json(FILES.content) as { stocks: Array<{ symbol: string }> };
  const seed = json(FILES.seed) as {
    assets: { solana: Array<{ symbol: string; address: string; pyth?: string }> };
  };
  const note = readFileSync(FILES.note, 'utf8');
  const noteAddresses = [
    ...new Set([...note.matchAll(/`([1-9A-HJ-NP-Za-km-z]{32,44})`/g)].map((m) => m[1] as string)),
  ].sort();
  return {
    tracked: {
      file: FILES.tracked,
      rows: tracked.assets.map((a) => ({ id: a.id, symbol: a.symbol, address: a.address })),
    },
    shelf: {
      file: FILES.shelf,
      rows: shelf.rows.map((r) => ({
        id: r.asset.id,
        symbol: r.asset.symbol,
        address: r.asset.address,
        verdict: r.verdict,
        source: r.source,
      })),
    },
    deploy: {
      file: FILES.deploy,
      rows: [deploy.cash, ...deploy.assets].map((a) => ({ id: a.id, modelOf: a.modelOf })),
    },
    structurer: {
      file: FILES.structurer,
      rows: REGISTRY.filter((a) => a.chain === 'solana' && a.mint).map((a) => ({
        id: a.id,
        symbol: a.symbol,
        mint: a.mint as string,
      })),
    },
    scope: {
      file: FILES.scope,
      source: scope.source,
      fetchedAt: scope.fetchedAt,
      method: scope.method,
      provenance: scope.provenance,
      priceAccount: scope.priceAccount,
      rows: scope.assets,
    },
    content: { file: FILES.content, symbols: content.stocks.map((s) => s.symbol) },
    seed: {
      file: FILES.seed,
      rows: seed.assets.solana.map((a) => ({
        symbol: a.symbol,
        address: a.address,
        pyth: a.pyth ?? null,
      })),
    },
    note: { file: FILES.note, addresses: noteAddresses },
    legTypes: {
      file: FILES.legTypes,
      rows: Object.fromEntries(
        Object.entries(LEG_TYPES).map(([k, v]) => [
          k,
          { types: [...v.types], source: v.source, readAt: v.readAt },
        ]),
      ),
    },
  };
}
