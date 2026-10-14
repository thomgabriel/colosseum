import { createDb } from '@colosseum/db';
import { type ChainId, parseFlags } from '@colosseum/schemas';
import { buildApp } from '../../apps/api/src/app';
import { DEPLOYMENTS_DIR } from '../../apps/api/src/deployments';
import { ROOMY, testIssuer } from '../../apps/api/src/testing/harness';

// The app the lookups' live eval runs against (API-AGENT-LOOKUPS-2): built as the server builds it from
// this machine's environment, the chains with the deploys' records (`deployments/`), so a chain set to
// `readonly` or `live` runs on its real catalog, signed in by a throwaway test issuer, with the asset data
// read from the local database (`LOOKUP_EVAL_DATABASE_URL`, or this machine's Postgres: never the
// environment's `DATABASE_URL`, which may name a hosted one with no asset data). A chain on the mock has
// made-up tokens with no data behind them: its questions are skipped.
//
// To run Solana's test network here, beside the env file:
//   CHAIN_MODE_SOLANA=readonly CHAIN_NETWORK_SOLANA=testnet SOLANA_RPC_URL=https://api.devnet.solana.com
// (its tokens in this database's `basket_assets` match `deployments/solana-devnet.json`; each reads its
// mainnet model's data, labelled test network).

type EvalApp = {
  app: Awaited<ReturnType<typeof buildApp>>;
  issuer: Awaited<ReturnType<typeof testIssuer>>;
  flags: ReturnType<typeof parseFlags>;
  real: (chain: ChainId) => boolean;
  close: () => Promise<void>;
};

export async function evalApp(): Promise<EvalApp> {
  const env = process.env as Record<string, string | undefined>;
  const flags = parseFlags(env);
  const { db, client } = createDb(
    process.env.LOOKUP_EVAL_DATABASE_URL ??
      'postgres://colosseum:colosseum@localhost:5433/colosseum',
  );
  const issuer = await testIssuer('lookup-eval');
  const app = await buildApp({
    env,
    deployments: DEPLOYMENTS_DIR,
    v1: { auth: issuer.issuer, db, limits: ROOMY },
  });
  /** A chain whose questions mean something here: on, and not the mock. */
  const real = (chain: ChainId) => {
    const mode = flags.chainMode[chain];
    return mode === 'live' || mode === 'readonly';
  };
  const close = async () => {
    await app.close();
    await client.end();
  };
  return { app, issuer, flags, real, close };
}
