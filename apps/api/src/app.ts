import {
  ApiError,
  DISCLAIMER,
  PostGoalsRequest,
  PostGoalsResponse,
  PostPlansRequest,
  PostPlansResponse,
} from '@colosseum/schemas';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import scalar from '@scalar/fastify-api-reference';
import Fastify from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import { registerReadRoutes } from './routes/read';
import { registerTransactionRoutes } from './routes/transactions';

const notYet = (what: string, slot: string) => ({
  error: `${what} is implemented in slot ${slot} (docs/PLAN.md §4)`,
});

export async function buildApp() {
  const app = Fastify({
    logger: process.env.NODE_ENV !== 'test',
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(cors, { origin: true });
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Colosseum structuring API',
        version: '0.1.0',
        description: `Goal-based structuring for self-custody wallets: goals in BRL, allocations across on-chain legs, BRL cash-flow schedule with stresses, per-leg risk sheet, and unsigned transactions for the partner wallet to sign.\n\n**${DISCLAIMER.en}**\n\n${DISCLAIMER.pt}`,
      },
      servers: [{ url: process.env.PUBLIC_API_URL ?? 'http://localhost:3001' }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(scalar, { routePrefix: '/docs' });

  app.get(
    '/health',
    { schema: { response: { 200: z.object({ ok: z.boolean(), disclaimer: z.string() }) } } },
    async () => ({
      ok: true,
      disclaimer: DISCLAIMER.en,
    }),
  );

  app.post(
    '/goals',
    {
      schema: {
        summary: 'Parse a natural-language goal into a validated constraint sheet',
        body: PostGoalsRequest,
        response: { 200: PostGoalsResponse, 501: ApiError },
      },
    },
    async (_req, reply) => reply.code(501).send(notYet('POST /goals (goal parser)', 'D6-AM')),
  );

  app.post(
    '/plans',
    {
      schema: {
        summary:
          'Solve an allocation, BRL schedule with stresses, and risk sheet for a constraint sheet',
        body: PostPlansRequest,
        response: { 200: PostPlansResponse, 501: ApiError },
      },
    },
    async (_req, reply) =>
      reply.code(501).send(notYet('POST /plans (solver, schedule, risk sheet)', 'D5-AM')),
  );

  await registerTransactionRoutes(app);
  await registerReadRoutes(app);

  return app;
}
