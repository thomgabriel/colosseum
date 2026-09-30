import {
  DEFAULT_PRIORITY,
  jupiterInstructions,
  jupiterIxToKit,
  withPriorityFee,
} from '@colosseum/chain-solana';
import { AccountRole, address, type Instruction } from '@solana/kit';
import {
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from '@solana-program/compute-budget';
import { describe, expect, it } from 'vitest';

const noop: Instruction = {
  programAddress: address('11111111111111111111111111111111'),
  accounts: [],
  data: new Uint8Array([0]),
};
const isCb = (ix: Instruction, disc: number) =>
  ix.programAddress === COMPUTE_BUDGET_PROGRAM_ADDRESS && ix.data?.[0] === disc;

describe('withPriorityFee', () => {
  it('adds a unit limit and a unit price when neither is present', () => {
    const out = withPriorityFee([noop]);
    expect(out.filter((ix) => isCb(ix, 2))).toHaveLength(1);
    expect(out.filter((ix) => isCb(ix, 3))).toHaveLength(1);
    expect(out.at(-1)).toBe(noop);
  });
  it('adds only the missing price when a limit is already there (the D2-PM dropped-tx bug)', () => {
    const out = withPriorityFee([getSetComputeUnitLimitInstruction({ units: 1000 }), noop]);
    expect(out.filter((ix) => isCb(ix, 2))).toHaveLength(1);
    expect(out.filter((ix) => isCb(ix, 3))).toHaveLength(1);
  });
  it('adds nothing when both are present', () => {
    const ixs = [
      getSetComputeUnitLimitInstruction({ units: 1000 }),
      getSetComputeUnitPriceInstruction({ microLamports: DEFAULT_PRIORITY.microLamportsPerUnit }),
      noop,
    ];
    expect(withPriorityFee(ixs)).toHaveLength(3);
  });
});

describe('jupiterIxToKit', () => {
  const jup = {
    programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
    accounts: [
      { pubkey: '11111111111111111111111111111111', isSigner: true, isWritable: true },
      { pubkey: 'ComputeBudget111111111111111111111111111111', isSigner: false, isWritable: false },
    ],
    data: 'AQID',
  };
  it('maps signer/writable flags to kit roles and decodes base64 data', () => {
    const ix = jupiterIxToKit(jup);
    expect(ix.accounts?.[0]?.role).toBe(AccountRole.WRITABLE_SIGNER);
    expect(ix.accounts?.[1]?.role).toBe(AccountRole.READONLY);
    expect(Array.from(ix.data ?? [])).toEqual([1, 2, 3]);
  });
  it('orders compute budget, setup, other, swap, cleanup', () => {
    const r = {
      computeBudgetInstructions: [jup],
      setupInstructions: [jup, jup],
      swapInstruction: jup,
      cleanupInstruction: jup,
      otherInstructions: [],
      addressLookupTableAddresses: [],
    };
    expect(jupiterInstructions(r)).toHaveLength(5);
  });
});
