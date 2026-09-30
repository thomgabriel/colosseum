import { MINTS, nowIso, print, rpc, sleep } from '../lib.js';

// V6: every mint exists, its token program, decimals and supply (BRS supply bounds the BRL-leg cap).
const out: Record<string, unknown> = {};
for (const [sym, mint] of Object.entries(MINTS)) {
  const info = await rpc<{
    value: {
      owner: string;
      data: { parsed: { info: { decimals: number; supply: string } } };
    } | null;
  }>('getAccountInfo', [mint, { encoding: 'jsonParsed' }]);
  const v = info.value;
  out[sym] = v
    ? {
        mint,
        program: v.owner === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' ? 'token-2022' : 'token',
        decimals: v.data.parsed.info.decimals,
        supplyUi: Number(v.data.parsed.info.supply) / 10 ** v.data.parsed.info.decimals,
      }
    : { mint, error: 'not found' };
  await sleep(300);
}
print({
  id: 'V6',
  item: 'Mint addresses and token programs',
  status: Object.values(out).every((o) => !(o as { error?: string }).error) ? 'pass' : 'fail',
  how: 'getAccountInfo jsonParsed on each mint (Jupiter token search used to resolve xStocks mints)',
  value: out,
  fetchedAt: nowIso(),
});
