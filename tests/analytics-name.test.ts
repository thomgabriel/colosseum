import openapi from '@colosseum/sdk/openapi.json' with { type: 'json' };
import { describe, expect, it } from 'vitest';
import { buildApp } from '../apps/api/src/app';
import { LOOKUP_RULES, LOOKUP_TOOLS } from '../apps/api/src/orders/lookup-loop';
import { VAULT_AGENT_SYSTEM } from '../apps/api/src/vault-agent-model';
import { createTenonfiMcp } from '../apps/mcp/src/server';
import { listTools } from '../apps/mcp/src/test/rpc';
import { bearingEn } from '../apps/web/i18n/bearing/en';
import { bearingPt } from '../apps/web/i18n/bearing/pt';
import { en } from '../apps/web/i18n/en';
import { portfolioEn } from '../apps/web/i18n/portfolio/en';
import { portfolioPt } from '../apps/web/i18n/portfolio/pt';
import { pt } from '../apps/web/i18n/pt';

// Gate ANALYTICS-NAME (Thom, Oct 27): no "Bearing" in anything a person reads; the section is
// Analytics. "Bearing" stays a code name (features/bearing, the `bearing` part of an asset's facts),
// so a name in backticks is a code name, and "yield-bearing" is the English word, not the name.

const NAME = /(?<![-\w])bearing\b/i;
const says = (text: string) => NAME.test(text.replace(/`[^`]*`/g, ''));

/** Every string under a value, with its path; a function is called with stand-ins, as words.test.ts does. */
function strings(value: unknown, path: string, out: [string, string][] = []): [string, string][] {
  if (typeof value === 'string') out.push([path, value]);
  else if (Array.isArray(value))
    for (const [i, item] of value.entries()) strings(item, `${path}[${i}]`, out);
  else if (typeof value === 'function') {
    for (const stand of ['Name', 2, true, null]) {
      try {
        const said: unknown = (value as (...args: unknown[]) => unknown)(
          ...Array.from({ length: Math.max(value.length, 4) }, () => stand),
        );
        strings(said, `${path}()`, out);
      } catch {
        // not a value this sentence takes
      }
    }
  } else if (value && typeof value === 'object')
    for (const [key, inner] of Object.entries(value)) strings(inner, `${path}.${key}`, out);
  return out;
}

/** The prose of a JSON document a person reads: every title, summary and description in it. */
function prose(value: unknown, path: string, out: [string, string][] = []): [string, string][] {
  if (Array.isArray(value))
    for (const [i, item] of value.entries()) prose(item, `${path}[${i}]`, out);
  else if (value && typeof value === 'object')
    for (const [key, inner] of Object.entries(value)) {
      if (typeof inner === 'string' && ['title', 'summary', 'description'].includes(key))
        out.push([`${path}.${key}`, inner]);
      else prose(inner, `${path}.${key}`, out);
    }
  return out;
}

const found = (all: [string, string][]) =>
  all.filter(([, text]) => says(text)).map(([path, text]) => `${path}: ${text}`);

describe('the name a person reads is Analytics, never Bearing (gate ANALYTICS-NAME)', () => {
  it('knows the name, and leaves a code name and the English word alone', () => {
    for (const text of ['Bearing measures it', 'as bearing says', 'BEARING’s figures'])
      expect(says(text), text).toBe(true);
    for (const text of ['the `bearing` part', 'yield-bearing tokens', 'interestBearingConfig'])
      expect(says(text), text).toBe(false);
  });

  it('is not in the dictionaries, English or Portuguese', () => {
    const all = [
      ...strings(en, 'en'),
      ...strings(pt, 'pt'),
      ...strings(bearingEn, 'analytics.en'),
      ...strings(bearingPt, 'analytics.pt'),
      ...strings(portfolioEn, 'portfolio.en'),
      ...strings(portfolioPt, 'portfolio.pt'),
    ];
    expect(all.length).toBeGreaterThan(4000);
    expect(found(all)).toEqual([]);
  });

  it('is not in the API’s documents: /docs as served, and the committed /v1 document', async () => {
    const app = await buildApp({ env: {} });
    await app.ready();
    const served = app.swagger() as unknown;
    await app.close();
    const all = [...prose(served, 'docs'), ...prose(openapi, 'openapi.json')];
    expect(all.length).toBeGreaterThan(100);
    expect(found(all)).toEqual([]);
  });

  it('is not in what the conversations hand the model: the system prompt and the lookup tools', () => {
    // the lookup rules are part of the system prompt; checked alone so a move out of it stays held
    const all = [
      ...strings(VAULT_AGENT_SYSTEM, 'VAULT_AGENT_SYSTEM'),
      ...strings(LOOKUP_RULES, 'LOOKUP_RULES'),
      ...prose(LOOKUP_TOOLS, 'LOOKUP_TOOLS'),
    ];
    expect(all.length).toBeGreaterThan(4);
    expect(found(all)).toEqual([]);
  });

  it('is not in the MCP server’s tools: their titles, descriptions and inputs', async () => {
    const mcp = createTenonfiMcp({
      apiUrl: 'https://api.tenonfi.test',
      appUrl: 'https://app.tenonfi.test',
    });
    const all = prose(await listTools(mcp), 'tools');
    expect(all.length).toBeGreaterThan(16);
    expect(found(all)).toEqual([]);
  });
});
