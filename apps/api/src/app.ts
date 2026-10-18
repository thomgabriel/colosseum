import { randomUUID } from 'node:crypto';
import { DISCLAIMER, type EnvLike, parseFlags } from '@colosseum/schemas';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import scalar from '@scalar/fastify-api-reference';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import { bearingAgentAnalytics } from './agent-analytics';
import { serverAssetLookups } from './asset-lookups';
import { DEPLOYMENTS_DIR, evmDeployment, solanaDeployment } from './deployments';
import {
  API_TITLE,
  API_VERSION,
  groupOf,
  SERVED_DESCRIPTION,
  SERVED_TAGS,
  V1_SECURITY_SCHEMES,
  v1Transform,
} from './openapi';
import { bearingPlanInputs } from './plan-inputs';
import { corsAllowlist, corsByPath } from './plugins/cors';
import { hideServerErrors } from './plugins/errors';
import { registerOpenWriteLimit, requireDeclared } from './plugins/limits';
import { logForwardedHops, proxyTrust } from './plugins/proxy';
import { loggerOptions } from './redact';
import { registerPlanRoutes } from './routes/plans';
import { registerRiskRoutes } from './routes/risk';
import { registerTransactionRoutes } from './routes/transactions';
import { registerV1Routes, type V1Deps } from './routes/v1';

// Chain amounts are bigint; serialise them as strings in every response.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function toJSON(this: bigint) {
  return this.toString();
};

/**
 * `deps.v1` replaces what the /v1 routes run on, and `deps.env` the environment the flags are read
 * from. A test passes them; the server passes nothing. `deps.deployments` is the folder of the
 * deploys' records (`deployments/solana-<network>.json`, `deployments/robinhood-<network>.json`), which
 * give a real chain its addresses: the
 * repo's own for the server, none for a test that passes its own environment unless it names one.
 */
export async function buildApp(
  deps: {
    v1?: V1Deps;
    env?: EnvLike;
    deployments?: string | null;
    /** Where the log's lines go, for a test that reads them. Default: the process's own output. */
    logTo?: { write(line: string): void };
  } = {},
) {
  const deployments =
    deps.deployments === undefined ? (deps.env ? null : DEPLOYMENTS_DIR) : deps.deployments;
  // The record gives a real chain its addresses. A chain on the mock or off has none to take, and its
  // record is not read at all.
  const modes = parseFlags(deps.env ?? process.env).chainMode;
  const real = (mode: string) => ['live', 'readonly'].includes(mode);
  const solana =
    deployments && real(modes.solana)
      ? solanaDeployment(deps.env ?? process.env, undefined, deployments)
      : { env: deps.env ?? process.env, contracts: {}, record: null };
  const robinhood =
    deployments && real(modes.robinhood)
      ? evmDeployment('robinhood', solana.env, undefined, deployments)
      : { env: solana.env, contracts: {}, record: null };
  const env = robinhood.env;
  // Stops here on a flag it cannot read.
  parseFlags(env);
  const app = Fastify({
    // No node's URL in a log line (redact.ts): the configured ones, and any a library's error names.
    logger: deps.logTo
      ? { ...loggerOptions({ ...process.env, ...env }), stream: deps.logTo }
      : process.env.NODE_ENV !== 'test'
        ? loggerOptions({ ...process.env, ...env })
        : false,
    // Whose address a request is counted against, behind a host's proxy (plugins/proxy.ts).
    trustProxy: proxyTrust(env),
    // Not a counter: a request's id is in the answer to a failed request, and says nothing of how
    // many requests the server has taken.
    genReqId: () => randomUUID(),
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // Before any route: one that throws outside /v1 answers the request id, not the error's message.
  hideServerErrors(app);
  // Before any route: a path under /v1 is held to default deny wherever it is registered.
  const inScope = requireDeclared(app);
  // /v1 answers a browser only from the allowlist (CORS_ORIGINS). Every other route, the risk layer's
  // /risk/* included, reflects any origin as it always has.
  await app.register(cors, { delegator: corsByPath(corsAllowlist(env)) });
  // After CORS, so a refusal still carries its headers and a browser can read it. The structurer's
  // open writes share the anonymous budget, by address (plugins/limits.ts).
  registerOpenWriteLimit(app, { limits: deps.v1?.limits, now: deps.v1?.now });
  logForwardedHops(app);
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: API_TITLE, version: API_VERSION, description: SERVED_DESCRIPTION },
      tags: [...SERVED_TAGS],
      servers: [{ url: process.env.PUBLIC_API_URL ?? 'http://localhost:3001' }],
      // The two tokens a signed-in /v1 route takes. No other route names them.
      components: { securitySchemes: V1_SECURITY_SCHEMES },
    },
    // jsonSchemaTransform for every route; a /v1 route also shows who may call it, and a route outside
    // /v1 is put in its group by its path.
    transform: (input) => {
      const out = v1Transform(input);
      const group = groupOf(input.url);
      const schema = out.schema as { tags?: string[] } | undefined;
      return group && schema && !schema.tags
        ? { ...out, schema: { ...schema, tags: [group] } }
        : out;
    },
  });
  await app.register(scalar, { routePrefix: '/docs', configuration: { pageTitle: API_TITLE } });

  app.get(
    '/health',
    {
      schema: {
        summary: 'Whether the server is up, with the disclaimer',
        response: { 200: z.object({ ok: z.boolean(), disclaimer: z.string() }) },
      },
    },
    async () => ({
      ok: true,
      disclaimer: DISCLAIMER.en,
    }),
  );

  await registerPlanRoutes(app);
  await registerTransactionRoutes(app);
  await registerRiskRoutes(app);
  await registerV1Routes(app, env, {
    ...deps.v1,
    contracts: deps.v1?.contracts ?? { ...solana.contracts, ...robinhood.contracts },
    solanaRecord: deps.v1?.solanaRecord ?? solana.record,
    robinhoodRecord: deps.v1?.robinhoodRecord ?? robinhood.record,
    planInputs: deps.v1?.planInputs ?? bearingPlanInputs,
    agentAnalytics: deps.v1?.agentAnalytics ?? bearingAgentAnalytics,
    assetLookups: deps.v1?.assetLookups ?? serverAssetLookups,
    // And its shelf, worked out once in the background as it starts.
    warmShelf:
      deps.v1?.warmShelf ?? (deps.v1?.planInputs === undefined && process.env.NODE_ENV !== 'test'),
    inScope,
  });

  return app;
}
