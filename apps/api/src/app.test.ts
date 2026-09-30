import { describe, expect, it } from 'vitest';
import { buildApp } from './app';

describe('api skeleton', () => {
  it('serves health with the disclaimer', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().disclaimer).toContain('not licensed');
    await app.close();
  });

  it('publishes the three endpoints in OpenAPI with the disclaimer in the description', async () => {
    const app = await buildApp();
    await app.ready();
    const doc = app.swagger() as { paths: Record<string, unknown>; info: { description: string } };
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining(['/goals', '/plans', '/plans/{id}/transactions']),
    );
    expect(doc.info.description).toContain('not licensed');
    await app.close();
  });

  it('rejects invalid bodies with 400', async () => {
    const app = await buildApp();
    const bad = await app.inject({ method: 'POST', url: '/goals', payload: { text: 'x' } });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });
});
