import {
  JUPITER_API_BASE,
  jupHeaders,
  jupQuote,
  MINTS,
  nowIso,
  print,
  rpc,
  sleep,
} from '../lib.js';

// V5: can an agent key compose "delegate transfer -> Jupiter swap -> output to the user's ATA" atomically?
// (a) token program per mint (SPL approve works on Token and Token-2022; transfer hooks would block delegates)
// (b) swap-instructions accepts destinationTokenAccount (control: a bogus param must be rejected or ignored consistently)
// (c) Squads v4 spending limits are transfer-only (docs.squads.so, read 2026-09-30) -> cannot CPI into Jupiter/Kamino
// (d) Kamino deposit requires the obligation owner's signature -> Kamino leg stays user-signed under mechanism A
const programs: Record<string, string> = {};
for (const [sym, mint] of Object.entries(MINTS)) {
  const info = await rpc<{
    value: {
      owner: string;
      data: { parsed: { info: { extensions?: Array<{ extension: string }> } } };
    } | null;
  }>('getAccountInfo', [mint, { encoding: 'jsonParsed' }]);
  const ext = info.value?.data.parsed.info.extensions?.map((e) => e.extension) ?? [];
  programs[sym] =
    `${info.value?.owner === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' ? 'token-2022' : 'token'}${ext.length ? ` [${ext.join(',')}]` : ''}`;
  await sleep(300);
}
const q = await jupQuote(MINTS.USDC, MINTS.USDY, 5_000_000n);
await sleep(1000);
const post = async (extra: Record<string, unknown>) => {
  const res = await fetch(`${JUPITER_API_BASE}/swap-instructions`, {
    method: 'POST',
    headers: { ...jupHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: q.body,
      userPublicKey: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
      ...extra,
    }),
  });
  const j = (await res.json()) as Record<string, unknown>;
  return { status: res.status, keys: Object.keys(j), error: j.error };
};
const withDest = await post({
  destinationTokenAccount: '3uetDDizgTtadDHZzyy9BqxrjQcozMEkxzbKhfZF4tG3',
});
await sleep(1000);
const withBogus = await post({ notARealParam: true });
print({
  id: 'V5',
  item: 'Delegated execution building blocks',
  status: withDest.status === 200 ? 'partial' : 'fail',
  how: 'getAccountInfo per mint; POST swap-instructions with destinationTokenAccount vs bogus param; Squads docs',
  value: {
    tokenPrograms: programs,
    swapInstructionsWithDestination: withDest,
    swapInstructionsWithBogusParam: withBogus,
    squadsSpendingLimits: 'transfer-only (docs)',
    kaminoDeposit: 'owner signature required',
  },
  fetchedAt: nowIso(),
  note: 'Decision slot D2-PM: mechanism A is viable only if the D2-PM spike lands a delegated swap on mainnet; otherwise fallback C.',
});
