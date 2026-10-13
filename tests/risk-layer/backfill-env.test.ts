// The backfill's own endpoints (scripts/risk/assets/backfill-env.ts): set before any module reads the RPC, used by
// the backfill only, and the live loop's quiet minutes kept only on the shared public endpoint.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
  vi.resetModules();
});

describe("the backfill's own endpoints", () => {
  it('carry the Solana and Robinhood Chain calls when set, and leave the quiet minutes off', async () => {
    process.env.SOLANA_RPC_URL = 'https://collector.example';
    process.env.SOLANA_BACKFILL_RPC_URL = 'https://backfill.example';
    process.env.ROBINHOOD_BACKFILL_RPC_URL = 'https://rh-backfill.example';
    const env = await import('../../scripts/risk/assets/backfill-env');
    const { RPC_URL } = await import('../../scripts/lib');
    const { rpcFor, CHAINS } = await import('../../scripts/risk-evm/config');
    expect(RPC_URL).toBe('https://backfill.example');
    expect(rpcFor(CHAINS.find((c) => c.id === 'robinhood') as (typeof CHAINS)[number]).url).toBe(
      'https://rh-backfill.example',
    );
    expect(env.BACKFILL_ENDPOINTS).toEqual({
      solana: 'SOLANA_BACKFILL_RPC_URL',
      robinhood: 'ROBINHOOD_BACKFILL_RPC_URL',
    });
    expect(env.KEEP_QUIET_MINUTES).toBe(false);
  });

  it('change nothing when unset, and keep the quiet minutes on the public endpoint', async () => {
    process.env.SOLANA_RPC_URL = 'https://collector.example';
    delete process.env.SOLANA_BACKFILL_RPC_URL;
    delete process.env.ROBINHOOD_BACKFILL_RPC_URL;
    const env = await import('../../scripts/risk/assets/backfill-env');
    const { RPC_URL } = await import('../../scripts/lib');
    expect(RPC_URL).toBe('https://collector.example');
    expect(env.KEEP_QUIET_MINUTES).toBe(true);
  });

  it('is the backfill’s first import after dotenv, so no module reads the RPC before it', () => {
    const src = readFileSync(join(ROOT, 'scripts/risk/assets/backfill.ts'), 'utf8');
    const imports = [...src.matchAll(/^import .*$/gm)].map((m) => m[0]);
    expect(imports.slice(0, 2)).toEqual(["import 'dotenv/config';", "import './backfill-env';"]);
  });
});
