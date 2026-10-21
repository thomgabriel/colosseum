import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Address,
  address,
  lamports,
  type SignatureBytes,
  type TransactionPartialSigner,
} from '@solana/kit';
import type { LiteSVM } from 'litesvm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceptVersionInstruction,
  type Component,
  createVaultInstruction,
  listAssets,
  RECIPE_HEAD_SIZE,
  RECIPE_SIZE,
  readRecipe,
  readVault,
  updateRecipeInstruction,
  vaultAddress,
  withdrawInstruction,
} from './src/basket';
import { createWorld, expectOk, fundedSigner, REPO_ROOT, send, setClock } from './src/env';
import { ata, balance, createMint, TOKEN_PROGRAM } from './src/tokens';

// The upgrade of Oct 14 (gate SHARED-RULES-V2), on accounts the program wrote before it: every account
// of fixtures/solana-vault/world-first-layout.json, written by the program as it was and never
// regenerated, is loaded as it is under the program built today. Its shared portfolio is 1,022 bytes.
// The keys of that world are not kept, so the signatures of its owner, creator and admin are not
// checked here (`withSigverify(false)`); everything else the program checks is.

type FixtureAccount = {
  role: string;
  address: string;
  owner: string;
  lamports: string;
  data: string;
};
type Fixture = {
  names: {
    admin: string;
    creator: string;
    owner: string;
    mints: Record<string, string>;
    vaults: Record<string, string>;
    recipes: Record<string, string>;
  };
  clock: { unixTimestamp: string };
  accounts: FixtureAccount[];
  expected: {
    recipes: Record<
      string,
      {
        active: { version: number; components: { mint: string; weightBps: number }[] };
        pending: {
          version: number;
          effectiveAt: string;
          components: { mint: string; weightBps: number }[];
        };
      }
    >;
  };
};

const world = JSON.parse(
  readFileSync(join(REPO_ROOT, 'fixtures', 'solana-vault', 'world-first-layout.json'), 'utf8'),
) as Fixture;

/** Stands in for a key the fixture does not keep: its signature is 64 zeros. */
const unchecked = (who: string): TransactionPartialSigner => ({
  address: address(who),
  signTransactions: async (transactions) =>
    transactions.map(() => ({ [address(who)]: new Uint8Array(64) as SignatureBytes })),
});

describe('the upgrade, on accounts written before it', () => {
  let svm: LiteSVM;
  const names = world.names;
  const recipe = address(names.recipes.core ?? '');
  const following = address(names.vaults.following ?? '');
  const creator = unchecked(names.creator);
  const owner = unchecked(names.owner);
  const admin = unchecked(names.admin);
  const mint = (name: string) => address(names.mints[name] ?? '');
  const expected = world.expected.recipes.core;
  const lines = (list: { mint: string; weightBps: number }[]): Component[] =>
    list.map((c) => ({ mint: mint(c.mint), weightBps: c.weightBps }));
  const targets = (vault: Address) => {
    const state = readVault(svm, vault);
    return state.positions
      .slice(0, state.count)
      .map((p) => ({ mint: p.mint, weightBps: p.targetBps }));
  };

  beforeEach(async () => {
    ({ svm } = await createWorld());
    svm.withSigverify(false);
    for (const account of world.accounts) {
      if (account.role === 'clock') continue;
      const data = new Uint8Array(Buffer.from(account.data, 'base64'));
      svm.setAccount({
        address: address(account.address),
        programAddress: address(account.owner),
        lamports: lamports(BigInt(account.lamports)),
        data,
        executable: false,
        space: BigInt(data.length),
      });
    }
    setClock(svm, BigInt(world.clock.unixTimestamp));
    for (const who of [names.creator, names.owner, names.admin])
      svm.airdrop(address(who), lamports(10_000_000_000n));
  });

  it('reads the portfolio as it was written: 1,022 bytes, both versions', () => {
    const account = svm.getAccount(recipe);
    expect(account.exists && account.data.length).toBe(RECIPE_HEAD_SIZE);
    const state = readRecipe(svm, recipe);
    expect(state.current.components).toEqual(lines(expected?.active.components ?? []));
    expect(state.pending.components).toEqual(lines(expected?.pending.components ?? []));
  });

  it("the vault that follows it takes its next version by its owner's accept", async () => {
    setClock(svm, BigInt(expected?.pending.effectiveAt ?? 0));
    const payer = await fundedSigner(svm);
    expectOk(
      await send(svm, payer, [
        await acceptVersionInstruction({ owner, vault: following, recipe, expectedVersion: 2 }),
      ]),
    );
    expect(targets(following)).toEqual(lines(expected?.pending.components ?? []));
    expect(readVault(svm, following).acceptedVersion).toBe(2);
  });

  it('a new vault follows it', async () => {
    setClock(svm, BigInt(expected?.pending.effectiveAt ?? 0));
    const someone = await fundedSigner(svm);
    expectOk(
      await send(svm, someone, [
        await createVaultInstruction({ owner: someone, basketId: 1n, recipe, expectedVersion: 2 }),
      ]),
    );
    expect(targets(await vaultAddress(someone.address, 1n))).toEqual(
      lines(expected?.pending.components ?? []),
    );
  });

  it('its owner still withdraws from a vault written before', async () => {
    const payer = await fundedSigner(svm);
    const usdc = { address: mint('usdc'), program: TOKEN_PROGRAM, decimals: 6, issuer: payer };
    const from = await ata(following, usdc);
    const to = await ata(owner.address, usdc);
    const before = [balance(svm, from), balance(svm, to)];
    expectOk(
      await send(svm, payer, [
        await withdrawInstruction({ owner, vault: following, mint: usdc, amount: 1_000_000n }),
      ]),
    );
    expect([balance(svm, from), balance(svm, to)]).toEqual([
      (before[0] ?? 0n) - 1_000_000n,
      (before[1] ?? 0n) + 1_000_000n,
    ]);
  });

  it('its creator publishes sixteen lines to it, and pays once for the room', async () => {
    // Twelve more tokens on the list, by the admin of that world.
    const issuer = await fundedSigner(svm);
    const more: Address[] = [];
    for (let i = 0; i < 12; i += 1)
      more.push((await createMint(svm, issuer, { program: TOKEN_PROGRAM, decimals: 8 })).address);
    await listAssets(svm, admin, more);

    // Version 2 is in effect; 6% of SPYx goes to twelve new lines at 0.5% each.
    setClock(svm, BigInt(expected?.pending.effectiveAt ?? 0));
    const inEffect = lines(expected?.pending.components ?? []);
    const sixteen = [
      ...inEffect.map((c) =>
        c.mint === mint('spyx') ? { ...c, weightBps: c.weightBps - 600 } : c,
      ),
      ...more.map((m) => ({ mint: m, weightBps: 50 })),
    ];
    const payer = await fundedSigner(svm);
    const paidBefore = svm.getBalance(creator.address) ?? 0n;
    expectOk(
      await send(svm, payer, [
        await updateRecipeInstruction({ creator, recipe, components: sixteen }),
      ]),
    );
    const account = svm.getAccount(recipe);
    expect(account.exists && account.data.length).toBe(RECIPE_SIZE);
    expect(account.exists && account.lamports).toBe(
      svm.minimumBalanceForRentExemption(BigInt(RECIPE_SIZE)),
    );
    const paid = paidBefore - (svm.getBalance(creator.address) ?? 0n);
    expect(paid).toBe(
      svm.minimumBalanceForRentExemption(BigInt(RECIPE_SIZE)) -
        svm.minimumBalanceForRentExemption(BigInt(RECIPE_HEAD_SIZE)),
    );
    const state = readRecipe(svm, recipe);
    expect([state.current.version, state.current.components]).toEqual([2, inEffect]);
    expect([state.pending.version, state.pending.count, state.pending.components]).toEqual([
      3,
      16,
      sixteen,
    ]);
  });
});
