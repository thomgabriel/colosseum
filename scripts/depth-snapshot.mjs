// V4 / depth cron: Jupiter buy-side price impact at four notionals for the DEX-routed legs.
// Standalone (no dependencies) so launchd can run a copy from ~/.colosseum: macOS blocks launchd
// agents from reading ~/Documents. Appends JSONL to $DEPTH_DIR/YYYY-MM-DD.jsonl; D4-PM imports the
// files into depth_observations. Install: scripts/launchd/install.sh. Runs every 15 min through Oct 12.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const LEGS = [
  ['spyx', 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W'],
  ['qqqx', 'Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ'],
  ['usdy', 'A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6'],
  ['syrupusdc', 'AvZZF1YaZDziPY2RCK4oJrRVrbN3mTD9NL24hPeaZeUj'],
];
const NOTIONALS_USD = [50, 500, 5_000, 50_000];
const BASE = process.env.JUPITER_API_BASE ?? 'https://api.jup.ag/swap/v1';
const OUT_DIR = process.env.DEPTH_DIR ?? 'data/depth';
const headers = {
  accept: 'application/json',
  ...(process.env.JUPITER_API_KEY ? { 'x-api-key': process.env.JUPITER_API_KEY } : {}),
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(OUT_DIR, { recursive: true });
const file = join(OUT_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
let rows = 0;
for (const [assetId, mint] of LEGS) {
  for (const usd of NOTIONALS_USD) {
    const url = `${BASE}/quote?inputMint=${USDC}&outputMint=${mint}&amount=${BigInt(usd) * 1_000_000n}&slippageBps=50`;
    let status = 0;
    let body = {};
    try {
      const res = await fetch(url, { headers });
      status = res.status;
      body = await res.json();
    } catch (e) {
      body = { error: String(e) };
    }
    const ok = status === 200;
    appendFileSync(
      file,
      `${JSON.stringify({
        assetId,
        side: 'buy',
        notionalUsd: usd,
        priceImpactPct: ok ? Number(body.priceImpactPct) : null,
        outAmount: ok ? String(body.outAmount) : null,
        routes: ok ? (body.routePlan?.length ?? null) : null,
        error: ok ? null : `${status} ${String(body.error ?? '')}`.trim(),
        source: `${BASE}/quote`,
        method: 'jupiter_quote_exact_in_usdc',
        fetchedAt: new Date().toISOString(),
        provenance: 'live',
      })}\n`,
    );
    rows++;
    await sleep(1300);
  }
}
console.log(
  JSON.stringify({
    id: 'V4',
    item: 'xStocks depth snapshot',
    status: 'pass',
    how: 'scripts/depth-snapshot.mjs',
    value: { file, rows },
    fetchedAt: new Date().toISOString(),
  }),
);
