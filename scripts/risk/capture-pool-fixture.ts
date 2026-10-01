import { mkdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import {
  CLMM_TICK_ARRAY_POOL_OFFSET,
  DLMM_BIN_ARRAY_PAIR_OFFSET,
  decodeClmmPool,
  METEORA_DLMM_PROGRAM,
  ORCA_WHIRLPOOL_PROGRAM,
  RAYDIUM_CLMM_PROGRAM,
  WP_DYNAMIC_TICK_ARRAY_POOL_OFFSET,
  WP_FIXED_TICK_ARRAY_POOL_OFFSET,
} from '@colosseum/risk';
import { jupHeaders, nowIso } from '../lib';
import { getAccount, programAccountsByMemcmp } from './lib-pools';

// Freezes one pool's raw accounts plus Jupiter direct quotes taken right after, as a test fixture
// (fixtures/risk/pools/<venue>-<pool>.json.gz). Usage: tsx capture-pool-fixture.ts <venue> <pool> <inMint> <outMint> <amountRaw,...>
const [venue, pool, inMint, outMint, amounts] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
  string,
];
const label = { raydium: 'Raydium CLMM', orca: 'Whirlpool', dlmm: 'Meteora DLMM' }[venue];
if (!label) throw new Error('venue must be raydium | orca | dlmm');
const program = {
  raydium: RAYDIUM_CLMM_PROGRAM,
  orca: ORCA_WHIRLPOOL_PROGRAM,
  dlmm: METEORA_DLMM_PROGRAM,
}[venue] as string;
const fetchedAt = nowIso();
const head = await getAccount(pool);
if (!head) throw new Error('pool not found');
const accounts: Record<string, string> = { [pool]: Buffer.from(head.data).toString('base64') };
let children: Array<{ pubkey: string; data: Uint8Array }> = [];
if (venue === 'raydium') {
  const cfg = decodeClmmPool(head.data).ammConfig;
  accounts[cfg] = Buffer.from((await getAccount(cfg))?.data ?? []).toString('base64');
  children = await programAccountsByMemcmp(program, CLMM_TICK_ARRAY_POOL_OFFSET, pool);
} else if (venue === 'orca') {
  children = [
    ...(await programAccountsByMemcmp(program, WP_FIXED_TICK_ARRAY_POOL_OFFSET, pool)),
    ...(await programAccountsByMemcmp(program, WP_DYNAMIC_TICK_ARRAY_POOL_OFFSET, pool)),
  ];
} else {
  children = await programAccountsByMemcmp(program, DLMM_BIN_ARRAY_PAIR_OFFSET, pool);
}
const childData = Object.fromEntries(
  children.map((c) => [c.pubkey, Buffer.from(c.data).toString('base64')]),
);
const quotes = [];
for (const a of amounts.split(',')) {
  const url = `https://api.jup.ag/swap/v1/quote?inputMint=${inMint}&outputMint=${outMint}&amount=${a}&slippageBps=50&onlyDirectRoutes=true&dexes=${encodeURIComponent(label)}`;
  const b = (await (await fetch(url, { headers: jupHeaders() })).json()) as {
    outAmount?: string;
    routePlan?: Array<{ swapInfo: { ammKey: string } }>;
  };
  quotes.push({
    amountIn: a,
    outAmount: b.outAmount ?? null,
    samePool: b.routePlan?.[0]?.swapInfo.ammKey === pool,
    fetchedAt: nowIso(),
  });
  await new Promise((r) => setTimeout(r, 1300));
}
mkdirSync('fixtures/risk/pools', { recursive: true });
const file = `fixtures/risk/pools/${venue}-${pool}.json.gz`;
writeFileSync(
  file,
  gzipSync(
    JSON.stringify({
      venue,
      pool,
      inMint,
      outMint,
      source:
        'Solana mainnet RPC getAccountInfo/getProgramAccounts; Jupiter /swap/v1/quote (direct, same dex)',
      method: 'raw_account_snapshot',
      fetchedAt,
      provenance: 'fixture',
      accounts,
      children: childData,
      quotes,
    }),
  ),
);
console.log(JSON.stringify({ file, children: children.length, quotes }));
