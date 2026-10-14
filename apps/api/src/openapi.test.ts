import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { DISCLAIMER } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app';
import {
  API_TITLE,
  API_VERSION,
  emitV1OpenApi,
  groupOf,
  OPENAPI_FILE,
  type OpenApiDocument,
  SERVED_TAGS,
  V1_SECURITY_SCHEMES,
  v1Transform,
} from './openapi';
import { LIMIT_CLASSES } from './plugins/limits';

// API-2: the OpenAPI document of /v1 is committed at packages/sdk/openapi.json, where the SDK takes
// its types from. This fails when the routes and the committed file differ: run `pnpm openapi:emit`
// and commit the file with the change that moved it.

const committed = JSON.parse(
  readFileSync(fileURLToPath(new URL(`../../../${OPENAPI_FILE}`, import.meta.url)), 'utf8'),
) as OpenApiDocument;

/** The paths on which two documents differ, with the methods that do. */
function differences(a: OpenApiDocument['paths'], b: OpenApiDocument['paths']): string[] {
  const out: string[] = [];
  for (const path of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const [x, y] = [a[path] ?? {}, b[path] ?? {}];
    for (const method of [...new Set([...Object.keys(x), ...Object.keys(y)])].sort())
      if (!isDeepStrictEqual(x[method], y[method])) out.push(`${method.toUpperCase()} ${path}`);
  }
  return out;
}

describe('the committed OpenAPI document (packages/sdk/openapi.json)', () => {
  it('is what the /v1 routes emit: run `pnpm openapi:emit` when this fails', async () => {
    const emitted = await emitV1OpenApi();
    expect(differences(committed.paths, emitted.paths)).toEqual([]);
    expect(committed.info).toEqual(emitted.info);
    expect(committed).toEqual(emitted);
  });

  it('is what the server serves under /v1, less the routes that exist only on the mock', async () => {
    const app = await buildApp({ env: {} });
    await app.ready();
    const whole = app.swagger() as unknown as OpenApiDocument;
    const served = whole.paths;
    await app.close();
    expect(whole.components.securitySchemes).toEqual(committed.components.securitySchemes);
    const real = Object.fromEntries(
      Object.entries(served).filter(([p]) => p.startsWith('/v1/') && !p.startsWith('/v1/mock/')),
    );
    expect(Object.keys(real).sort()).toEqual(Object.keys(committed.paths));
    expect(differences(real, committed.paths)).toEqual([]);
    // The mock routes are served while a chain runs on the mock, and are not in the document.
    expect(Object.keys(served).some((p) => p.startsWith('/v1/mock/'))).toBe(true);
  });

  it('holds /v1 and nothing else, with the disclaimer, and every route says how it refuses', () => {
    const paths = Object.keys(committed.paths);
    expect(paths.length).toBeGreaterThan(8);
    expect(paths.filter((p) => !p.startsWith('/v1/'))).toEqual([]);
    expect(paths.filter((p) => p.includes('mock'))).toEqual([]);
    expect(committed.info.description).toContain(DISCLAIMER.en);
    expect(committed.openapi).toBe('3.1.0');
    for (const [path, methods] of Object.entries(committed.paths))
      for (const [method, operation] of Object.entries(methods)) {
        const { summary, responses } = operation as {
          summary?: string;
          responses?: Record<string, unknown>;
        };
        expect(summary, `${method} ${path}`).toBeTruthy();
        expect(Object.keys(responses ?? {}), `${method} ${path}`).toContain('200');
      }
  });

  it('names each route in the product’s words: a deposit, never a buy or a mix (WORDS-VAULT-DEPOSIT)', () => {
    const off: string[] = [];
    for (const [path, methods] of Object.entries(committed.paths))
      for (const [method, operation] of Object.entries(methods)) {
        const { summary } = operation as { summary?: string };
        if (/\b(mix|mixes|buy|buys|bought|buyer)\b/i.test(summary ?? ''))
          off.push(`${method.toUpperCase()} ${path}: ${summary}`);
      }
    expect(off).toEqual([]);
  });

  it('says who may call each route and which budget it counts against, as the route declares', async () => {
    // The two headers of a sign-in, declared once: a bearer token and a header of its own.
    expect(committed.components).toEqual({ securitySchemes: V1_SECURITY_SCHEMES });
    expect(committed.components.securitySchemes).toMatchObject({
      accessToken: { type: 'http', scheme: 'bearer' },
      identityToken: { type: 'apiKey', in: 'header', name: 'privy-id-token' },
    });
    const open: string[] = [];
    const classes: Record<string, string[]> = {};
    for (const [path, methods] of Object.entries(committed.paths))
      for (const [method, operation] of Object.entries(methods)) {
        const name = `${method.toUpperCase()} ${path}`;
        const { security, responses, ...rest } = operation as {
          security?: Record<string, string[]>[];
          responses: Record<string, unknown>;
          'x-rate-limit'?: string;
        };
        // Both tokens together, or nothing: no route takes one of the two.
        if (isDeepStrictEqual(security, [])) open.push(name);
        else expect(security, name).toEqual([{ accessToken: [], identityToken: [] }]);
        const cls = rest['x-rate-limit'] ?? '';
        expect(LIMIT_CLASSES, name).toContain(cls);
        classes[cls] = [...(classes[cls] ?? []), name];
        // Every route is counted, so every route can refuse: a 429 has the one refusal shape.
        expect(Object.keys(responses), name).toContain('default');
      }
    // The routes anybody may call, by name: a route opened by mistake fails here. The shelf and a
    // shared portfolio's page are the same for everyone (DESIGN-VAULT section 10). A plan proposed from
    // a link is made and read back with no sign-in (AGT-2, section 12). The platform's counts are the
    // landing's, for every visitor.
    expect(open).toEqual([
      'POST /v1/baskets/propose',
      'GET /v1/baskets/{id}',
      'GET /v1/config',
      'GET /v1/indexes/{slug}',
      'GET /v1/indexes/{slug}/versions',
      'GET /v1/shelf',
      'GET /v1/stats',
      'GET /v1/vaults/{chain}/{address}',
    ]);
    // The routes that ask a chain for quotes (a continuation quotes its steps), the one that runs the engine on a chain's shelf, and the
    // test faucet, which plans the buy and sends on a test network, are the ones with the tighter budget.
    expect(classes.build).toEqual([
      'POST /v1/baskets/personalize',
      'POST /v1/baskets/propose',
      'POST /v1/orders',
      'POST /v1/orders/{id}/continue',
      'POST /v1/orders/{id}/legs/{legId}/build',
      'POST /v1/testnet/fund',
      'POST /v1/vaults/{chain}/{address}/rebalance',
      'POST /v1/vaults/{chain}/{address}/rebalance/quote',
      'POST /v1/vaults/{chain}/{address}/targets',
    ]);
    // Guided intake and private plan turns share the existing parse budget.
    expect(classes.parse).toEqual(['POST /v1/baskets/intake', 'POST /v1/baskets/{id}/thread']);
  });

  it('self-check: a route whose rule changed is another document', () => {
    const route = (config: object) =>
      v1Transform({
        schema: { summary: 'a route' },
        url: '/v1/x',
        route: { config },
        openapiObject: { openapi: '3.1.0' },
      } as unknown as Parameters<typeof v1Transform>[0]).schema;
    const user = route({ auth: 'user', limit: 'standard' });
    expect(user).toEqual({
      summary: 'a route',
      security: [{ accessToken: [], identityToken: [] }],
      'x-rate-limit': 'standard',
    });
    expect(route({ auth: 'public', limit: 'standard' })).toEqual({ ...user, security: [] });
    expect(route({ auth: 'user', limit: 'build' })).toEqual({ ...user, 'x-rate-limit': 'build' });
    // A route that is not under /v1 declares neither, and its document is left as it was.
    expect(route({})).toEqual({ summary: 'a route' });
  });

  it('self-check: a route that changed is a difference, named by its method and path', async () => {
    const emitted = await emitV1OpenApi();
    const moved = structuredClone(emitted);
    const order = moved.paths['/v1/orders/{id}'];
    if (!order) throw new Error('no such path');
    order.get = { ...(order.get as object), summary: 'another summary' };
    delete moved.paths['/v1/funding'];
    expect(differences(emitted.paths, moved.paths)).toEqual([
      'GET /v1/funding',
      'GET /v1/orders/{id}',
    ]);
  });
});

describe('the document the server serves at /docs', () => {
  it('names the product as the committed document does, and carries the disclaimer in both languages', async () => {
    const app = await buildApp({ env: {} });
    await app.ready();
    const { info } = app.swagger() as unknown as OpenApiDocument;
    const page = await app.inject({ method: 'GET', url: '/docs/' });
    await app.close();
    expect([info.title, info.version]).toEqual([API_TITLE, API_VERSION]);
    expect([committed.info.title, committed.info.version]).toEqual([API_TITLE, API_VERSION]);
    expect(info.description).toContain(DISCLAIMER.en);
    expect(info.description).toContain(DISCLAIMER.pt);
    // The page's own title, in the browser's tab, is the API's name and not the viewer's.
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain(`<title>${API_TITLE}</title>`);
  });

  it('puts every route in one of its groups, each group declared once', async () => {
    const app = await buildApp({ env: {} });
    await app.ready();
    const whole = app.swagger() as unknown as OpenApiDocument & { tags: { name: string }[] };
    await app.close();
    const declared = whole.tags.map((t) => t.name);
    expect(declared).toEqual(SERVED_TAGS.map((t) => t.name));
    const loose: string[] = [];
    const used = new Set<string>();
    // The routes that exist only while a chain runs on the mock carry their own group, MOCK, and are
    // not served by a deployment on real chains. Bearing's /risk/* keep the risk API's own documents.
    const served = Object.entries(whole.paths).filter(
      ([p]) => !p.startsWith('/v1/mock/') && !p.startsWith('/risk/'),
    );
    for (const [path, methods] of served)
      for (const [method, operation] of Object.entries(methods)) {
        const tags = (operation as { tags?: string[] }).tags ?? [];
        if (tags.length !== 1 || !declared.includes(tags[0] as string))
          loose.push(`${method.toUpperCase()} ${path} ${tags.join(',')}`);
        for (const tag of tags) used.add(tag);
      }
    expect(loose).toEqual([]);
    // A group with no route would be an empty heading on the page.
    expect(declared.filter((name) => !used.has(name))).toEqual([]);
  });

  it('self-check: a route outside /v1 is grouped by its path, and Bearing’s are left as they are', () => {
    expect(groupOf('/risk/assets/{id}/depth')).toBeNull();
    expect(groupOf('/goals')).toBe('structurer');
    expect(groupOf('/plans/{id}/transactions')).toBe('structurer');
    expect(groupOf('/executions/{id}/report')).toBe('structurer');
    expect(groupOf('/health')).toBe('platform');
    expect(groupOf('/plansx')).toBeNull();
    expect(groupOf('/v1/me')).toBeNull();
  });
});
