import type { Db } from '@colosseum/db';
import { parseChainConfigs, parseFlags } from '@colosseum/schemas';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { describe, expect, it, vi } from 'vitest';
import { createChainRegistry } from '../../orders/chains';
import type { AgentAnalytics } from '../../orders/vault-agent';
import { registerV1Routes } from '.';

// The conversations' analytics are read once at the server's start, for every chain that is not the mock;
// a failed read is logged, never thrown. A test's reader is never warmed unless it asks.
const db = new Proxy({}, { get: () => () => undefined }) as unknown as Db;

async function serve(warm: boolean, mockOnly = false, fails = false) {
  const registry = createChainRegistry(parseFlags({}), parseChainConfigs({}), { seed: 'warm' });
  // The registry runs every chain on the mock here; all but the mock flag is the real entry.
  const chains = mockOnly
    ? registry
    : {
        ...registry,
        active: () => registry.active().map((entry) => ({ ...entry, mock: undefined })),
      };
  const analytics = Object.assign(vi.fn(), {
    warm: vi.fn(async () => {
      if (fails) throw new Error('too many connections');
      return { read: 3, failed: 0 };
    }),
  }) as unknown as AgentAnalytics & { warm: ReturnType<typeof vi.fn> };
  const logged: Array<Record<string, unknown>> = [];
  const app = Fastify({
    logger: {
      level: 'info',
      stream: { write: (line: string) => logged.push(JSON.parse(line)) },
    },
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await registerV1Routes(
    app,
    {},
    {
      db,
      chains,
      testFunds: [],
      agentAnalytics: analytics,
      warmAgentAnalytics: warm,
    },
  );
  await app.ready();
  return { app, analytics, registry, logged };
}

describe("the conversations' analytics are warmed from the start", () => {
  it('warms each live chain once with its catalog and label', async () => {
    const { app, analytics, registry, logged } = await serve(true);
    const active = registry.active();
    await vi.waitFor(() => expect(analytics.warm).toHaveBeenCalledTimes(active.length));
    for (const entry of active) {
      const call = analytics.warm.mock.calls.find(([q]) => q.chain === entry.chain)?.[0];
      expect(call?.db).toBe(db);
      expect(call?.provenance).toBe(entry.provenance);
      expect(call?.assets.map((asset: { id: string }) => asset.id)).toEqual(
        (await entry.adapter.listAssets()).map((asset) => asset.id),
      );
    }
    expect(analytics).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(logged.filter((l) => l.code === 'analytics_warmed')).toHaveLength(active.length),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(analytics.warm).toHaveBeenCalledTimes(active.length);
    await app.close();
  });

  it('logs a warm-up that fails and goes on serving', async () => {
    const { app, analytics, registry, logged } = await serve(true, false, true);
    const active = registry.active();
    await vi.waitFor(() =>
      expect(logged.filter((l) => l.code === 'analytics_warm_failed')).toHaveLength(active.length),
    );
    expect(analytics.warm).toHaveBeenCalledTimes(active.length);
    expect((await app.inject({ url: '/v1/config' })).statusCode).toBe(200);
    await app.close();
  });

  it('warms nothing when not asked, or on the mock', async () => {
    for (const [warm, mockOnly] of [
      [false, false],
      [true, true],
    ] as const) {
      const { app, analytics } = await serve(warm, mockOnly);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(analytics.warm).not.toHaveBeenCalled();
      await app.close();
    }
  });
});
