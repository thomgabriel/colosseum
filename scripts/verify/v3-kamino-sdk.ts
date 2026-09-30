import { createRequire } from 'node:module';
import { KAMINO_MAIN_MARKET, KAMINO_USDC_RESERVE, MINTS, nowIso, print, RPC_URL } from '../lib.js';

// V3: SDK version, its Solana client dependency, and a live market load + main USDC reserve supply APY read.
const require = createRequire(import.meta.url);
const pkg = require('@kamino-finance/klend-sdk/package.json') as {
  version: string;
  dependencies: Record<string, string>;
};
const value: Record<string, unknown> = {
  version: pkg.version,
  solanaKit: pkg.dependencies['@solana/kit'],
  web3js: pkg.dependencies['@solana/web3.js'] ?? null,
};
let status: 'pass' | 'fail' | 'partial' = 'partial';
try {
  const sdk = await import('@kamino-finance/klend-sdk');
  const { createSolanaRpc, address } = await import('@solana/kit');
  const rpc = createSolanaRpc(RPC_URL);
  const market = await sdk.KaminoMarket.load(rpc, address(KAMINO_MAIN_MARKET), 400);
  if (!market) throw new Error('market load returned null');
  const usdc = market.getReserveByAddress(address(KAMINO_USDC_RESERVE));
  if (usdc && usdc.getLiquidityMint() !== address(MINTS.USDC))
    throw new Error('reserve mint mismatch');
  value.usdcReserve = usdc?.address ?? null;
  if (usdc) {
    const instant = await sdk.getCurrentLedgerInstant(rpc);
    value.supplyApy = usdc.totalSupplyAPY(instant);
    value.totalSupplyUsd = usdc.getDepositTvl?.() ?? undefined;
    value.method = 'klend-sdk on-chain read';
  }
  value.buildDepositTxns = typeof sdk.KaminoAction.buildDepositTxns;
  status = usdc ? 'pass' : 'partial';
} catch (e) {
  value.error = String(e).slice(0, 300);
}
print({
  id: 'V3',
  item: 'Kamino SDK version and live market read',
  status,
  how: `pnpm ls @kamino-finance/klend-sdk; KaminoMarket.load via ${RPC_URL.includes('mainnet-beta.solana.com') ? 'public RPC' : 'configured RPC'}`,
  value,
  fetchedAt: nowIso(),
});
