import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  AddAssetsFile,
  assetBatch,
  createEvmRpc,
  EvmDeploymentRecord,
  listedAsFiled,
  readListed,
  recordEntryOf,
  safeBatchFile,
} from '@colosseum/chain-evm/vault';
import { writeBoth } from './mainnet-records';

// More tokens on the Robinhood Chain mainnet factory, through the timelock. Read-only: it writes files and
// asks a node; it sends nothing, holds no key and proposes nothing to the Safe's service. The two owners
// sign in the Safe app.
//
//   pnpm ops:add-assets --safe-files <dir>       writes the two files the Safe app's Transaction Builder
//                                                imports: the scheduleBatch now, the executeBatch after the delay
//   pnpm ops:add-assets --status --rpc-env NAME  says whether the batch has run and which tokens the chain lists
//   pnpm ops:add-assets --promote --rpc-env NAME [--except SYM,SYM]
//                                                moves every token the chain lists with the file's settings,
//                                                but those the file holds back (`heldBack`) or the command names
//                                                from the record's `pending` to its `assets`, adds it to the
//                                                guard's file and regenerates the guard's tables
//
// `--file` names the file (default contracts/script/config/4663-assets-2.json). `--rpc-env` names the
// environment variable that holds the node's URL, which is never printed.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULTS = {
  file: join(ROOT, 'contracts', 'script', 'config', '4663-assets-2.json'),
  // The batch is the factory of 2026-10-12's, whose record is kept under its date since the redeploy
  // (gate ROBINHOOD-REDEPLOY) took the name.
  record: join(ROOT, 'deployments', 'robinhood-mainnet-2026-10-12.json'),
  guard: join(ROOT, 'packages', 'sdk', 'deployments', 'mainnet.json'),
};

// biome-ignore lint/suspicious/noExplicitAny: files as they are read, edited field by field
type Json = any;

const fail = (message: string): never => {
  throw new Error(message);
};

/** The two Transaction Builder files, by name: the one to sign now and the one to sign after the delay. */
export function safeFiles(file: AddAssetsFile, name: string) {
  const batch = assetBatch(file);
  const symbols = file.assets.map((a) => a.symbol).join(', ');
  const createdAt = Date.parse(file.measured.at(-1)?.at ?? '');
  const common = { chainId: file.chainId, safe: file.safe, to: file.timelock, createdAt };
  return {
    batch,
    schedule: safeBatchFile({
      ...common,
      data: batch.schedule,
      name: `${name} 1 of 2: schedule`,
      description: `Timelock scheduleBatch: list ${symbols} on the Tenonfi factory ${file.factory}. Runs no earlier than ${file.delay} s after it lands. Operation ${batch.operationId}.`,
    }),
    execute: safeBatchFile({
      ...common,
      data: batch.execute,
      name: `${name} 2 of 2: execute`,
      description: `Timelock executeBatch of operation ${batch.operationId}: lists ${symbols}. Fails if sent before the delay has passed.`,
    }),
  };
}

/**
 * The record's `pending` as the file makes it: every token of the file not yet in `assets`, in the
 * file's order, each with the batch's operation. Throws when the record's `pending` says anything else.
 */
export function heldToFile(record: Json, file: AddAssetsFile): void {
  const { operationId } = assetBatch(file);
  const listed = new Set(record.assets.map((a: Json) => a.address));
  const want = file.assets
    .filter((a) => !listed.has(a.token))
    .map((a) => recordEntryOf(a, operationId));
  const have = EvmDeploymentRecord.parse(record).pending ?? [];
  // Compared field by field, whatever order the schema puts the fields in.
  const canon = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canon)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v as Json)
              .sort(([x], [y]) => (x < y ? -1 : 1))
              .map(([k, x]) => [k, canon(x)]),
          )
        : v;
  if (JSON.stringify(canon(have)) !== JSON.stringify(canon(want)))
    fail("the record's pending tokens are not the file's: write them from the file again");
}

/**
 * The record and the guard's file with the tokens the chain lists moved in. Pure. A token held back by
 * symbol (`except`), or routed through v3, which no builder routes yet, stays pending.
 */
export function promote(
  record: Json,
  guard: Json,
  listed: readonly string[],
  except: readonly string[] = [],
) {
  // The guard's file is one deploy's: never another factory's tokens into it. Both name a factory.
  const ofGuard = String(guard.chains?.robinhood?.factory ?? '').toLowerCase();
  const ofRecord = String(record.contracts?.factory ?? '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(ofGuard) || !/^0x[0-9a-f]{40}$/.test(ofRecord))
    throw new Error("the guard's file or the record names no factory: nothing to promote into it");
  if (ofGuard !== ofRecord)
    throw new Error(
      "the guard's file names another factory than the record: nothing to promote into it",
    );
  const moves = (p: Json) =>
    listed.includes(p.address) && p.pool !== null && !except.includes(p.symbol.toUpperCase());
  const moving = (record.pending ?? []).filter(moves);
  const nextRecord = structuredClone(record);
  nextRecord.assets = [
    ...record.assets,
    ...moving.map(({ operation: _, ...entry }: Json) => entry),
  ];
  nextRecord.pending = (record.pending ?? []).filter((p: Json) => !moves(p));
  const nextGuard = structuredClone(guard);
  for (const p of moving)
    nextGuard.chains.robinhood.assets[p.id] = {
      address: p.address,
      decimals: p.decimals,
      pool: p.pool,
    };
  return { record: nextRecord, guard: nextGuard, moved: moving.map((p: Json) => p.symbol) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const value = (name: string) => {
    const at = args.indexOf(name);
    return at === -1 ? undefined : args[at + 1];
  };
  try {
    const path = value('--file') ?? DEFAULTS.file;
    const file = AddAssetsFile.parse(JSON.parse(readFileSync(path, 'utf8')));
    const record = JSON.parse(readFileSync(DEFAULTS.record, 'utf8'));
    const out = value('--safe-files');
    if (out) {
      const name = 'Tenonfi: more tokens';
      const { batch, schedule, execute } = safeFiles(file, name);
      const base = join(out, 'ROBINHOOD-MAINNET-WIDER-LIST');
      writeBoth([
        [`${base}.1-schedule.json`, `${JSON.stringify(schedule, null, 2)}\n`],
        [`${base}.2-execute.json`, `${JSON.stringify(execute, null, 2)}\n`],
      ]);
      console.log(`operation\t${batch.operationId}`);
      console.log(`wrote\t${base}.1-schedule.json\tdata keccak256 ${batch.scheduleHash}`);
      console.log(`wrote\t${base}.2-execute.json\tdata keccak256 ${batch.executeHash}`);
    } else {
      const env = value('--rpc-env') ?? fail('say --safe-files <dir>, or --rpc-env <NAME>');
      const url = process.env[env]?.trim() ?? fail(`${env} is not set`);
      heldToFile(record, file);
      const state = await readListed(createEvmRpc(url), file);
      const listed = listedAsFiled(file, state);
      console.log(
        `operation\t${assetBatch(file).operationId}\t${state.operationDone ? 'executed' : 'not executed'}`,
      );
      for (const a of file.assets)
        console.log(
          `${a.symbol}\t${listed.includes(a.token) ? 'listed as the file says' : 'not listed'}`,
        );
      if (args.includes('--promote')) {
        const guard = JSON.parse(readFileSync(DEFAULTS.guard, 'utf8'));
        // Held back by the file (`heldBack`, with why) or by name on the command line.
        const except = [
          ...file.assets.filter((a) => a.heldBack !== undefined).map((a) => a.symbol),
          ...(value('--except') ?? '').split(','),
        ]
          .filter(Boolean)
          .map((x) => x.toUpperCase());
        const next = promote(record, guard, listed, except);
        if (next.moved.length === 0)
          fail('nothing to promote: the chain lists none of the pending tokens');
        EvmDeploymentRecord.parse(next.record);
        writeBoth([
          [DEFAULTS.record, `${JSON.stringify(next.record, null, 2)}\n`],
          [DEFAULTS.guard, `${JSON.stringify(next.guard, null, 2)}\n`],
        ]);
        execFileSync('pnpm', ['--filter', '@colosseum/sdk', 'tables'], {
          cwd: ROOT,
          stdio: 'inherit',
        });
        execFileSync('pnpm', ['biome', 'format', '--write', DEFAULTS.record, DEFAULTS.guard], {
          cwd: ROOT,
          stdio: 'inherit',
        });
        console.log(`promoted\t${next.moved.join(', ')}`);
        console.log(
          'next: fill basket_assets from the record (scripts/robinhood/basket-assets.ts), then restart the API',
        );
      }
    }
  } catch (e) {
    console.error(
      `refused: ${(e instanceof Error ? e.message : String(e)).replace(/https?:\/\/\S+/g, '<url>')}`,
    );
    process.exit(1);
  }
}
