// The Robinhood Chain builder of `pnpm risk:assets robinhood` (PLAN-ASSETS AS.3): reads the listings and
// the chain (assets-read.ts), joins them with the repository's files and the verdict table
// (assets-list.ts), and hands the list to scripts/risk/assets/build.ts, which validates and writes it.
//   pnpm risk:assets robinhood                       read everything again, at a recent block
//   pnpm risk:assets robinhood --from <reads.json.gz>  build from reads already made, with no network
//   pnpm risk:assets robinhood --freeze              also write the reads under fixtures/risk-evm/assets/
//   pnpm risk:assets robinhood --discovery <file>    another discovery file than the newest
// Every live run writes its reads and the names it saw to RISK_ASSETS_DIR (default data/assets/robinhood),
// which is never committed. Read-only: public GETs, eth_call, eth_getStorageAt, eth_getCode.
import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { tokenAnswers, tokenBasics } from '@colosseum/risk';
import { codePath, frozenPath, loadFiles, PATHS, readGz } from './assets-files';
import {
  type AssetFiles,
  type AssetReads,
  cutDiscovery,
  type FrozenReads,
  namesTable,
  noteAddresses,
  robinhoodList,
} from './assets-list';
import { type Listings, readAssets, readListings } from './assets-read';

/** A request the RPC's Cloudflare answers with a challenge is asked again this many times, this far apart. */
const CHALLENGE_TRIES = 8;
const CHALLENGE_WAIT_MS = 15_000;
/** UTC minutes, from and before, in which the hourly collector (scheduled at minute 4) reads the chain. */
const LOOP_QUIET = [1, 15] as const;

import { CHAINS, rpcFor } from './config';
import { DIRECTORY_URL } from './feeds';
import { latestFile, REGISTRY_URL, stamp } from './registry';
import { createRpc } from './rpc';

/** The raw code of a few addresses, for the decoder tests: one of each kind the reads found. */
function codeSamples(reads: AssetReads, code: Map<string, string>, dollar: string) {
  const scans = new Map(reads.onchain.code.map((c) => [c.address, c]));
  const slotsOf = new Map(reads.onchain.tokens.map((t) => [t.address, t.slots]));
  const out: Array<{ address: string; why: string; code: string }> = [];
  const add = (address: string | undefined, why: string) => {
    const a = address?.toLowerCase();
    if (a && code.has(a) && !out.some((s) => s.address === a))
      out.push({ address: a, why, code: code.get(a) as string });
  };
  const nvda = reads.registry.rows
    .find((r) => r.tokenSymbol === 'NVDA')
    ?.deployments.find((d) => d.chainId === reads.chainId)?.contractAddress;
  add(nvda ?? undefined, "a stock token of the issuer's registry: a proxy behind a beacon");
  const beaconSlot = nvda ? slotsOf.get(nvda.toLowerCase())?.beacon : undefined;
  const beacon = reads.onchain.beacons.find(
    (b) => beaconSlot && b.address === `0x${beaconSlot.slice(26)}`.toLowerCase(),
  );
  if (beacon?.implementation.success)
    add(
      `0x${beacon.implementation.data.slice(26)}`,
      "the beacon's implementation of the stock tokens",
    );
  add(dollar, 'the dollar token: an EIP-1967 proxy');
  const impl = slotsOf.get(dollar.toLowerCase())?.implementation;
  if (impl && !/^0x0+$/.test(impl)) add(`0x${impl.slice(26)}`, "the dollar token's implementation");
  const clone = [...scans.values()].find((s) => s.minimalProxyTarget);
  add(clone?.address, 'an EIP-1167 clone');
  const isToken = (a: string) => {
    const t = reads.onchain.tokens.find((x) => x.address === a);
    return t ? tokenBasics(tokenAnswers(t.replies)).ok : false;
  };
  const plain = [...scans.values()].find(
    (s) =>
      !s.delegatecall &&
      !s.minimalProxyTarget &&
      s.size > 1000 &&
      slotsOf.has(s.address) &&
      /^0x0+$/.test(slotsOf.get(s.address)?.implementation ?? '') &&
      isToken(s.address),
  );
  add(plain?.address, 'a token with no proxy and no DELEGATECALL');
  return out;
}

export async function buildList(args: string[]) {
  const option = (name: string) => {
    const i = args.indexOf(name);
    const v = i >= 0 ? args[i + 1] : undefined;
    if (i >= 0 && (v === undefined || v.startsWith('--'))) throw new Error(`${name} needs a file`);
    return v;
  };
  const freeze = args.includes('--freeze');
  const from = option('--from');
  const scratch = process.env.RISK_ASSETS_DIR ?? 'data/assets/robinhood';
  const chain = CHAINS.find((c) => c.id === 'robinhood');
  if (!chain) throw new Error('robinhood is not in config.ts');
  const lines: string[] = [];

  let frozen: FrozenReads & { samples?: Array<{ address: string; why: string; code: string }> };
  if (from) {
    frozen = readGz(from);
    lines.push(`built from ${from}, with no network`);
  } else {
    const base = loadFiles({ file: '', fetchedAt: '', groups: [] });
    const notes = noteAddresses(base.notes);
    const { url: rpcUrl, label } = rpcFor(chain);
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let challenged = 0;
    // the hourly collector reads the same endpoint at minute 4: nothing is asked of it in minutes 1 to 14
    const quiet = async () => {
      for (;;) {
        const minute = new Date().getUTCMinutes();
        if (minute < LOOP_QUIET[0] || minute >= LOOP_QUIET[1]) return;
        console.error(
          `minute ${minute}: paused until minute ${LOOP_QUIET[1]}, the collector's hour`,
        );
        await sleep(30_000);
      }
    };
    const deps = {
      // The public RPC sits behind Cloudflare, which at times answers a request with a challenge
      // (HTTP 403, cf-mitigated). Such a request is asked again, slowly, as it is: nothing is solved or
      // disguised, and the count is printed.
      rpc: createRpc(rpcUrl, {
        fetch: async (url, init) => {
          for (let attempt = 0; ; attempt++) {
            // every request, not only the first: the chain is not read in the collector's minutes
            await quiet();
            const res = await fetch(url, init);
            if (
              res.status !== 403 ||
              !res.headers.get('cf-mitigated') ||
              attempt >= CHALLENGE_TRIES
            )
              return res;
            challenged++;
            await sleep(CHALLENGE_WAIT_MS);
          }
        },
      }),
      fetchJson: async (url: string) => {
        const res = await fetch(url, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
        return res.json();
      },
      now: Date.now,
      sleep,
    };
    const input = {
      chain,
      registryUrl: REGISTRY_URL.robinhood as string,
      directoryUrl: DIRECTORY_URL.robinhood as string,
      rpcLabel: label,
      notes,
      verdictAddresses: base.verdicts.verdicts.map((v) => v.address),
      challenged: () => challenged,
      log: (l: string) => console.error(l),
    };
    const listingsFrom = option('--listings');
    const listings = listingsFrom
      ? readGz<Listings>(listingsFrom)
      : await readListings(deps, input);
    if (!listingsFrom) {
      mkdirSync(scratch, { recursive: true });
      const out = join(scratch, `listings-${stamp(new Date())}.json.gz`);
      writeFileSync(out, gzipSync(JSON.stringify(listings)));
      lines.push(`listings written to ${out}`);
    }
    const { reads, code } = await readAssets(deps, { ...input, listings, beforeChain: quiet });

    const dir = process.env.RISK_EVM_DIR ?? 'data/risk-evm';
    const discoveryFile = option('--discovery') ?? latestFile(dir, 'discovery', 'robinhood');
    if (!discoveryFile) throw new Error(`no discovery file in ${dir}: set RISK_EVM_DIR`);
    const discovery = cutDiscovery(
      basename(discoveryFile),
      JSON.parse(readFileSync(discoveryFile, 'utf8')),
      reads.onchain.tokens.map((t) => t.address),
    );
    frozen = { reads, discovery, samples: codeSamples(reads, code, chain.dollar.address) };
    mkdirSync(scratch, { recursive: true });
    const out = join(scratch, `reads-${stamp(new Date(reads.onchain.blockTime * 1000))}.json.gz`);
    writeFileSync(out, gzipSync(JSON.stringify(frozen)));
    lines.push(`reads written to ${out} (block ${reads.onchain.block})`);
  }

  const files: AssetFiles = {
    ...loadFiles(frozen.discovery),
    frozenPath: frozenPath(frozen.reads),
  };
  const namesOut = join(
    scratch,
    `names-${stamp(new Date(frozen.reads.onchain.blockTime * 1000))}.json`,
  );
  const writeNames = (list: Parameters<typeof namesTable>[2]) => {
    // the names seen, for whoever writes the verdicts, whether or not the build went through
    mkdirSync(scratch, { recursive: true });
    writeFileSync(namesOut, `${JSON.stringify(namesTable(frozen.reads, files, list), null, 1)}\n`);
  };
  let built: ReturnType<typeof robinhoodList>;
  try {
    built = robinhoodList(frozen.reads, files);
  } catch (e) {
    writeNames(null);
    console.error(`names written to ${namesOut}`);
    throw e;
  }
  writeNames(built.list);
  if (freeze) {
    if (!frozen.samples) throw new Error('--freeze needs reads that kept their code samples');
    mkdirSync(PATHS.fixtures, { recursive: true });
    const { samples, ...reads } = frozen;
    writeFileSync(frozenPath(frozen.reads), gzipSync(JSON.stringify(reads)));
    writeFileSync(
      codePath(frozen.reads),
      gzipSync(JSON.stringify({ block: frozen.reads.onchain.block, samples })),
    );
    lines.push(`froze ${frozenPath(frozen.reads)} and ${codePath(frozen.reads)}`);
  }
  return { list: built.list, lines: [...lines, ...built.lines] };
}
