import 'dotenv/config';
import {
  CLMM_TICK_ARRAY_POOL_OFFSET,
  clmmState,
  decodeClmmAmmConfig,
  decodeClmmPool,
  decodeClmmTickArray,
  decodeWhirlpool,
  decodeWpTickArray,
  ORCA_WHIRLPOOL_PROGRAM,
  WP_DYNAMIC_TICK_ARRAY_POOL_OFFSET,
  WP_FIXED_TICK_ARRAY_POOL_OFFSET,
  whirlpoolState,
} from '@colosseum/risk';
import { rpc } from '../lib';

export type RawAccount = { pubkey: string; data: Uint8Array };

export async function getAccount(
  pubkey: string,
): Promise<{ owner: string; data: Uint8Array } | null> {
  const r = await rpc<{ value: { owner: string; data: [string, string] } | null }>(
    'getAccountInfo',
    [pubkey, { encoding: 'base64' }],
  );
  return r.value ? { owner: r.value.owner, data: Buffer.from(r.value.data[0], 'base64') } : null;
}

export async function getMultiple(
  pubkeys: string[],
): Promise<Array<{ owner: string; data: Uint8Array } | null>> {
  const out: Array<{ owner: string; data: Uint8Array } | null> = [];
  for (let i = 0; i < pubkeys.length; i += 100) {
    const r = await rpc<{ value: Array<{ owner: string; data: [string, string] } | null> }>(
      'getMultipleAccounts',
      [pubkeys.slice(i, i + 100), { encoding: 'base64' }],
    );
    for (const v of r.value)
      out.push(v ? { owner: v.owner, data: Buffer.from(v.data[0], 'base64') } : null);
  }
  return out;
}

export async function programAccountsByMemcmp(
  program: string,
  offset: number,
  bytes: string,
): Promise<RawAccount[]> {
  const r = await rpc<Array<{ pubkey: string; account: { data: [string, string] } }>>(
    'getProgramAccounts',
    [program, { encoding: 'base64', filters: [{ memcmp: { offset, bytes } }] }],
  );
  return r.map((a) => ({ pubkey: a.pubkey, data: Buffer.from(a.account.data[0], 'base64') }));
}

/** Full CLMM state for one pool: header, fee config, every tick array. */
export async function loadClmm(program: string, pool: string) {
  const acc = await getAccount(pool);
  if (!acc) throw new Error(`pool ${pool} not found`);
  const header = decodeClmmPool(acc.data);
  const cfg = await getAccount(header.ammConfig);
  if (!cfg) throw new Error(`amm config ${header.ammConfig} not found`);
  const { tradeFeeRate } = decodeClmmAmmConfig(cfg.data);
  const raw = await programAccountsByMemcmp(program, CLMM_TICK_ARRAY_POOL_OFFSET, pool);
  const arrays = raw
    .map((a) => decodeClmmTickArray(a.data))
    .filter((a) => a !== null && a.pool === pool);
  const state = clmmState(header, tradeFeeRate, arrays as NonNullable<(typeof arrays)[number]>[]);
  return { header, tradeFeeRate, arrays: arrays.length, state };
}

/** Full Whirlpool state: header plus fixed and dynamic tick arrays. */
export async function loadWhirlpool(pool: string) {
  const acc = await getAccount(pool);
  if (!acc) throw new Error(`pool ${pool} not found`);
  const header = decodeWhirlpool(acc.data);
  const raw = [
    ...(await programAccountsByMemcmp(
      ORCA_WHIRLPOOL_PROGRAM,
      WP_FIXED_TICK_ARRAY_POOL_OFFSET,
      pool,
    )),
    ...(await programAccountsByMemcmp(
      ORCA_WHIRLPOOL_PROGRAM,
      WP_DYNAMIC_TICK_ARRAY_POOL_OFFSET,
      pool,
    )),
  ];
  const arrays = raw
    .map((a) => decodeWpTickArray(a.data, header.tickSpacing))
    .filter((a): a is NonNullable<typeof a> => a !== null && a.pool === pool);
  const kinds: Record<string, number> = {};
  for (const a of arrays) kinds[a.kind] = (kinds[a.kind] ?? 0) + 1;
  return { header, arrays: arrays.length, kinds, state: whirlpoolState(header, arrays) };
}
