import {
  createSolanaVaultReader,
  readCreatorLimits,
  type VaultWriteRpc,
} from '@colosseum/chain-solana/vault';
import {
  ChainError,
  CREATOR_LIMITS_V1,
  CREATOR_LIMITS_V2,
  type CreatorLimits,
} from '@colosseum/schemas';
import { type Address, getAddressEncoder, lamports } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { BASKET_PROGRAM, createSvmNode, PROGRAMS_BUILT } from './svm-node';
import { assetsOf, configOf, fixtureNode, loadFixture } from './world';

// The author limits as the program says them (`creator_limits`, gate SHARED-RULES-V2): the reader asks
// the node to simulate the instruction and reads its return data, so the app keeps no copy of them.

const fixture = loadFixture();
const PROGRAM = fixture.names.program as Address;

/** The return data of `creator_limits`, laid out as the program writes it. */
function returned(limits: CreatorLimits): string {
  const b = Buffer.alloc(13);
  b.writeUInt8(limits.rules, 0);
  b.writeUInt8(limits.minAssets, 1);
  b.writeUInt8(limits.maxAssets, 2);
  b.writeUInt16LE(limits.minWeightBps, 3);
  b.writeUInt16LE(limits.maxWeightBps, 5);
  b.writeUInt16LE(limits.stepBps, 7);
  b.writeUInt16LE(limits.sumBps, 9);
  b.writeUInt16LE(limits.maxTurnoverBps, 11);
  return b.toString('base64');
}

type Answer = { err: unknown; returnData: { programId: string; data: [string, 'base64'] } | null };

/** A node that answers every simulation with `answer`, and counts them. */
function simulating(answer: Answer) {
  const seen = { simulations: 0, payers: [] as string[] };
  const rpc = {
    getLatestBlockhash: () => ({
      send: async () => ({
        context: { slot: 1n },
        value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 10n },
      }),
    }),
    simulateTransaction: (wire: string) => ({
      send: async () => {
        seen.simulations += 1;
        // The fee payer is the first account key of the message, after the signature section.
        const bytes = Buffer.from(wire, 'base64');
        seen.payers.push(
          bytes.subarray(1 + 64 + 1 + 3 + 1, 1 + 64 + 1 + 3 + 1 + 32).toString('hex'),
        );
        return { context: { slot: 1n }, value: { logs: [], ...answer } };
      },
    }),
  } as unknown as VaultWriteRpc;
  return { rpc, seen };
}

const reads = (answer: Answer) => {
  const { rpc, seen } = simulating(answer);
  return {
    seen,
    limits: () =>
      readCreatorLimits({ rpc, program: PROGRAM, payer: fixture.names.admin as Address }),
  };
};

describe('the author limits, read from the program', () => {
  it('decodes what the program answers', async () => {
    const { limits } = reads({
      err: null,
      returnData: { programId: PROGRAM, data: [returned(CREATOR_LIMITS_V2), 'base64'] },
    });
    expect(await limits()).toEqual(CREATOR_LIMITS_V2);
  });

  it('a program built before the instruction holds the first rules', async () => {
    const { limits } = reads({ err: { InstructionError: [0, { Custom: 101 }] }, returnData: null });
    expect(await limits()).toEqual(CREATOR_LIMITS_V1);
  });

  it('says so when the program does not answer, and never guesses', async () => {
    for (const answer of [
      { err: { InstructionError: [0, { Custom: 6000 }] }, returnData: null },
      { err: 'AccountNotFound', returnData: null },
      { err: null, returnData: null },
      {
        err: null,
        returnData: {
          programId: fixture.names.router,
          data: [returned(CREATOR_LIMITS_V2), 'base64'],
        },
      },
    ] as Answer[]) {
      const outcome = await reads(answer)
        .limits()
        .catch((e: unknown) => e);
      expect(outcome).toBeInstanceOf(ChainError);
      expect((outcome as ChainError).code).toBe('Unavailable');
    }
  });

  it("the reader asks with Config's admin paying, once for a few minutes, and only with a node that simulates", async () => {
    const node = fixtureNode(fixture);
    const config = configOf(fixture, 'testnet');
    const assets = assetsOf(fixture);
    const plain = createSolanaVaultReader({ config, rpc: node.rpc, assets });
    const refused = await plain.creatorLimits().catch((e: unknown) => e);
    expect((refused as ChainError).code).toBe('NotSupported');

    const { rpc, seen } = simulating({
      err: null,
      returnData: { programId: PROGRAM, data: [returned(CREATOR_LIMITS_V2), 'base64'] },
    });
    const reader = createSolanaVaultReader({ config, rpc: node.rpc, assets, simulate: rpc });
    expect(await reader.creatorLimits()).toEqual(CREATOR_LIMITS_V2);
    expect(await reader.creatorLimits()).toEqual(CREATOR_LIMITS_V2);
    expect(seen.simulations).toBe(1);
    const admin = Buffer.from(getAddressEncoder().encode(fixture.names.admin as Address)).toString(
      'hex',
    );
    expect(seen.payers).toEqual([admin]);
  });
});

if (PROGRAMS_BUILT)
  describe('the author limits, from the built program in LiteSVM', () => {
    it('are the second rules', async () => {
      const payer = fixture.names.admin as Address;
      const node = await createSvmNode(payer, 1_791_212_400n);
      node.svm.airdrop(payer, lamports(1_000_000_000n));
      expect(await readCreatorLimits({ rpc: node.rpc, program: BASKET_PROGRAM, payer })).toEqual(
        CREATOR_LIMITS_V2,
      );
    });
  });
