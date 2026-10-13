import { adapterContract, type ContractFixture } from '@colosseum/chain-mock/contract';
import { type Address, decodeFunctionData, type Hex, parseAbi } from 'viem';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  ACCOUNTS,
  buildTestnetWorld,
  DEPOSIT_RAW,
  id,
  STRANGER,
  TESTNET_RECORD,
  type TestnetWorld,
} from './testnet-world';

// The EVM adapter whole (ADE-2) on a local copy of Robinhood Chain's test network (46630): the
// adapter contract of packages/chain-mock, all seven groups, against the factory, the registry, the
// Universal Router, the Uniswap v4 pools and the test tokens TNET-1 and TNET-2 deployed. Every vault
// and portfolio of the world is built by the adapter itself. Nothing is sent to the test network.
//
//   RH_TESTNET_FORK_URL=https://rpc.testnet.chain.robinhood.com pnpm exec vitest run packages/chain-evm/test/testnet.test.ts
//
// The network's RPC keeps state for about a quarter of an hour, which is enough: the copy is made at
// its latest block. RH_TESTNET_FORK_PORT moves anvil off 28745. The keeper's cases need a weekday by
// UTC: the copy opens the session to the whole day, not the week.

const FORK_URL = process.env.RH_TESTNET_FORK_URL;
const PORT = Number(process.env.RH_TESTNET_FORK_PORT ?? 28_745);

let world: Promise<TestnetWorld> | undefined;
export const startTestnet = () => {
  world ??= buildTestnetWorld(FORK_URL ?? '', PORT);
  return world;
};

describe.skipIf(!FORK_URL)('on a copy of Robinhood Chain test network', () => {
  vi.setConfig({ hookTimeout: 600_000, testTimeout: 180_000 });
  const notBefore = new Date().toISOString();
  afterAll(async () => (await world)?.stop());

  it("states a trade's deadline as its validUntil, and none for a call that does not trade", async () => {
    const w = await startTestnet();
    const wall = Math.floor(Date.now() / 1000);
    const swap = await w.adapter.buildOwnerSwap({
      vault: w.vault,
      trades: [{ sell: id('tusdg'), buy: id('tspy'), amountInRaw: '1000000' }],
      slippageBps: 100,
    });
    expect(swap.lastValidBlockHeight).toBeGreaterThan(wall);
    // The guard passes a deadline at most 1,800 s ahead of its clock.
    expect(swap.lastValidBlockHeight).toBeLessThanOrEqual(wall + 1_800);
    const create = await w.adapter.buildCreateVault({
      owner: ACCOUNTS.owner,
      basketId: '77',
      targets: [{ asset: id('tspy'), weightBps: 5000 }],
      autoFollow: false,
      depositRaw: DEPOSIT_RAW.toString(),
      slippageBps: 100,
    });
    expect(create.lastValidBlockHeight).toBeGreaterThan(wall);
    const toggle = await w.adapter.buildSetAutoFollow({ vault: w.manualVault, on: false });
    expect(toggle.lastValidBlockHeight).toBeUndefined();
  });

  it('a first deposit opens the vault empty, approves the contract that is there, then deposits and swaps in one', async () => {
    // Gate CREATE-BEFORE-APPROVE: the order the app now plans, against the deployed factory and vault.
    const w = await startTestnet();
    const basketId = '78';
    const owner = ACCOUNTS.owner;
    const cashToken = (await w.adapter.listAssets()).find((a) => a.cls === 'cash')
      ?.address as Address;
    const ERC20_READ = parseAbi([
      'function approve(address spender, uint256 amount) returns (bool)',
      'function balanceOf(address) view returns (uint256)',
    ]);
    const spenderOf = (data: Hex) =>
      decodeFunctionData({ abi: ERC20_READ, data }).args[0] as Address;

    // What the old first step approved: an address with no code yet.
    const early = await w.adapter.buildApprove({ owner, basketId, amountRaw: '1' });
    const future = spenderOf(early.payload as Hex);
    expect(await w.client.getCode({ address: future })).toBeUndefined();

    const create = await w.adapter.buildCreateVault({
      owner,
      basketId,
      targets: [{ asset: id('tspy'), weightBps: 5000 }],
      autoFollow: false,
      slippageBps: 100,
    });
    expect(create.preview.changes.filter((c) => c.holder === 'wallet')).toEqual([]);
    await w.send(create);
    const vault = (await w.adapter.getVaults(owner)).find((v) => v.basketId === basketId);
    expect(vault?.address.toLowerCase()).toBe(future.toLowerCase());
    expect(vault?.cash.raw).toBe('0');

    // The approval is built and signed with its spender a contract: the vault just opened.
    const approve = await w.adapter.buildApprove({
      owner,
      basketId,
      amountRaw: DEPOSIT_RAW.toString(),
    });
    const spender = spenderOf(approve.payload as Hex);
    expect(spender.toLowerCase()).toBe(future.toLowerCase());
    expect((await w.client.getCode({ address: spender }))?.length).toBeGreaterThan(2);
    await w.send(approve);

    // Then the deposit, with its trade, as into any open vault: one transaction.
    const wallet = (await w.client.readContract({
      address: cashToken,
      abi: ERC20_READ,
      functionName: 'balanceOf',
      args: [owner],
    })) as bigint;
    const half = (DEPOSIT_RAW / 2n).toString();
    const deposit = await w.adapter.buildDeposit({
      vault: vault?.address ?? '',
      amountRaw: DEPOSIT_RAW.toString(),
      trades: [{ sell: id('tusdg'), buy: id('tspy'), amountInRaw: half }],
      slippageBps: 100,
    });
    await w.send(deposit);
    const after = await w.adapter.getVault(vault?.address ?? '');
    expect(after?.cash.raw).toBe(half);
    expect(
      BigInt(after?.positions.find((p) => p.asset === id('tspy'))?.raw ?? '0'),
    ).toBeGreaterThan(0n);
    const left = (await w.client.readContract({
      address: cashToken,
      abi: ERC20_READ,
      functionName: 'balanceOf',
      args: [owner],
    })) as bigint;
    expect(wallet - left).toBe(DEPOSIT_RAW);
  });

  adapterContract(
    'robinhood adapter, copy of the test network',
    async (): Promise<ContractFixture> => {
      const w = await startTestnet();
      // The test network's prices are copied in by its price writer; one it has not copied for longer
      // than the vault accepts is stale on the copy too, and the reads are held to saying so. Which
      // one is read here from the feeds and the record, not from the adapter under test.
      const now = (await w.client.getBlock()).timestamp;
      const ages = await Promise.all(
        TESTNET_RECORD.assets.map(async (a) => {
          const [, , , updatedAt] = (await w.client.readContract({
            address: a.feed as Address,
            abi: parseAbi([
              'function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)',
            ]),
            functionName: 'latestRoundData',
          })) as readonly [bigint, bigint, bigint, bigint, bigint];
          return { asset: a.id, stale: now - updatedAt > BigInt(a.maxAge) };
        }),
      );
      const stale = ages.find((a) => a.stale);
      return {
        ...(stale ? { stalePriced: stale.asset } : {}),
        adapter: w.adapter,
        provenance: 'sandbox',
        notBefore,
        owner: ACCOUNTS.owner,
        stranger: STRANGER,
        vault: w.vault,
        manualVault: w.manualVault,
        newAssetVault: w.newAssetVault,
        depositRaw: DEPOSIT_RAW.toString(),
        unknownTxId: `0x${'11'.repeat(32)}`,
        send: w.send,
        sign: w.sign,
        withPriceMoved: w.withPriceMoved,
        quoteSlippageBps: 100,
        recipeOnchainId: w.recipeA,
        adoptable: false,
        newAssetRecipeId: w.recipeB,
        freshBasketId: '77',
        ownerTrade: { sell: id('tusdg'), buy: id('tspy'), amountInRaw: '5000000' },
        keeperTrade: { sell: id('tusdg'), buy: id('tspy'), amountInRaw: '2000000' },
        bandBps: 50,
        awayTrade: { sell: id('tqqq'), buy: id('tusdg'), amountInRaw: '1000000000000000' },
        publishRecipe: {
          schemaVersion: 1,
          familyId: w.familyA,
          chain: 'robinhood',
          onchainId: w.recipeA,
          creator: ACCOUNTS.owner,
          kind: 'community',
          version: 2,
          effectiveAt: 0,
          // In the order the registry keeps them, by token address: tNVDA, tSPY, tQQQ.
          components: [
            { kind: 'asset', asset: id('tnvda'), weightBps: 3500 },
            { kind: 'asset', asset: id('tspy'), weightBps: 3500 },
            { kind: 'asset', asset: id('tqqq'), weightBps: 3000 },
          ],
          metaHash: 'ab'.repeat(32),
          maxFeeBps: 0,
          flags: 0,
        },
      };
    },
  );
});
