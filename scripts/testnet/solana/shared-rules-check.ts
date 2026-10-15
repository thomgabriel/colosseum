// Reads the vault program on a test network and says what a shared portfolio is held to there: the
// author limits the program answers (`creator_limits`, simulated, gate SHARED-RULES-V2), and every shared
// portfolio and following vault it holds, decoded as the app decodes them. Read only: nothing is signed or
// sent. Run before and after an upgrade of the program to see the existing accounts still read.
//
//   SOLANA_RPC_URL=https://api.devnet.solana.com pnpm exec tsx scripts/testnet/solana/shared-rules-check.ts

import {
  createVaultRpc,
  decodeConfig,
  decodeRecipe,
  decodeVault,
  isAccount,
  RECIPE_DISCRIMINATOR,
  readCreatorLimits,
  VAULT_DISCRIMINATOR,
  ZERO_ADDRESS,
} from '@colosseum/chain-solana/vault';
import { type Address, getBase58Decoder, getBase64Encoder } from '@solana/kit';
import deployment from '../../../deployments/solana-devnet.json' with { type: 'json' };

const url = process.env.SOLANA_RPC_URL;
if (!url) throw new Error('SOLANA_RPC_URL is not set');
const rpc = createVaultRpc(url);
const program = deployment.programs.basket as Address;
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
if ((await rpc.getGenesisHash().send()) === MAINNET_GENESIS) throw new Error('this is mainnet');

const bytes = (data: readonly [string, string] | string[]) =>
  new Uint8Array(getBase64Encoder().encode(data[0] ?? ''));
const accountsOf = async (tag: Uint8Array) =>
  (
    await rpc
      .getProgramAccounts(program, {
        encoding: 'base64',
        filters: [
          {
            memcmp: {
              offset: 0n,
              bytes: getBase58Decoder().decode(tag) as never,
              encoding: 'base58',
            },
          },
        ],
      })
      .send()
  ).map((a) => ({
    address: a.pubkey,
    data: bytes(a.account.data as unknown as [string, string]),
  }));

const [config] = (
  await rpc
    .getProgramAccounts(program, {
      encoding: 'base64',
      filters: [{ dataSize: 396n }],
    })
    .send()
).map((a) => decodeConfig(bytes(a.account.data as unknown as [string, string])));
if (!config) throw new Error('no Config');

const limits = await readCreatorLimits({ rpc, program, payer: config.admin });
console.log('limits', JSON.stringify(limits));

const recipes = await accountsOf(RECIPE_DISCRIMINATOR);
for (const r of recipes) {
  if (!isAccount('recipe', r.data)) {
    console.log('recipe', r.address, r.data.length, 'NOT A RECIPE');
    continue;
  }
  const d = decodeRecipe(r.data);
  const lines = (v: typeof d.current) => v.components.map((c) => c.weightBps).join('/');
  console.log(
    'recipe',
    r.address,
    `${r.data.length} bytes`,
    `current v${d.current.version} ${d.current.count} lines ${lines(d.current)}`,
    d.pending.version ? `pending v${d.pending.version} ${lines(d.pending)}` : 'none pending',
  );
}

const vaults = (await accountsOf(VAULT_DISCRIMINATOR))
  .map((v) => ({ address: v.address, vault: decodeVault(v.data) }))
  .filter((v) => v.vault.recipe !== ZERO_ADDRESS);
console.log(`vaults following a shared portfolio: ${vaults.length}`);
for (const { address, vault } of vaults)
  console.log('vault', address, vault.recipe, `v${vault.acceptedVersion}`, `${vault.count} lines`);
