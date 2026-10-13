import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Manifest } from '@colosseum/risk';

// `pnpm risk:assets-backfill-status [--days 30] [--registry <file>]` (PLAN-ASSETS AS.8): what the backfill holds and
// what it lacks, read from its own records under ASSETS_DATA_DIR (default data/assets), so a run stopped for any
// reason (an endpoint's trial ending, the budget, a restart) is resumed on exactly what is missing. Reads files
// only; asks no endpoint. Writes <out>/backfill-status-<stamp>.json and prints a summary.
//   Solana swaps and mints: per subject, the UTC days of the window its manifest's covered windows hold, and
//     the days missing; a registry pool (--registry) with no folder is missing every day.
//   Robinhood Chain logs: per filter and scope, the block ranges `fetched.json` records.
//   External daily: per subject, its manifest's day; Chainlink rounds: per feed, its covered rounds.

const DAY = 86_400;

/** The UTC days of [from, to] (seconds) that `covered` holds whole, and those it does not. */
export function daysCovered(
  covered: Array<{ from: number; to: number }>,
  from: number,
  to: number,
): { have: string[]; missing: string[] } {
  const have: string[] = [];
  const missing: string[] = [];
  for (let d = Math.floor(from / DAY) * DAY; d <= to; d += DAY) {
    const a = Math.max(d, from);
    const b = Math.min(d + DAY - 1, to);
    const whole = covered.some((w) => w.from <= a && w.to >= b);
    (whole ? have : missing).push(new Date(d * 1000).toISOString().slice(0, 10));
  }
  return { have, missing };
}

const readJson = <T>(f: string): T | null =>
  existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as T) : null;
const folders = (dir: string) =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    : [];

function main() {
  const args = process.argv.slice(2);
  const opt = (k: string) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const out = process.env.ASSETS_DATA_DIR ?? 'data/assets';
  const days = Number(opt('--days') ?? 30);
  const now = Math.floor(Date.now() / 1000);
  const from = now - days * DAY;

  const solana = (kind: 'swaps' | 'mints', wanted: string[]) => {
    const dir = join(out, 'solana', kind);
    const subjects = [...new Set([...folders(dir), ...wanted])].sort();
    const rows = subjects.map((s) => {
      const m = readJson<Manifest>(join(dir, s, 'manifest.json'));
      const d = daysCovered(m?.covered ?? [], from, now);
      return {
        subject: s,
        rows: m?.rows ?? 0,
        bytes: m?.bytes ?? 0,
        have: d.have.length,
        missing: d.missing,
      };
    });
    return {
      subjects: rows.length,
      complete: rows.filter((r) => r.missing.length === 0).length,
      daysMissing: rows.reduce((a, r) => a + r.missing.length, 0),
      bytes: rows.reduce((a, r) => a + r.bytes, 0),
      rows,
    };
  };
  const registry = opt('--registry');
  const pools = registry
    ? (JSON.parse(readFileSync(registry, 'utf8')) as
        | Array<{ address: string }>
        | { pools: Array<{ address: string }> })
    : [];
  const poolList = Array.isArray(pools) ? pools : pools.pools;

  const fetched = readJson<{ covered: Record<string, Array<{ from: number; to: number }>> }>(
    join(out, 'robinhood', 'fetched.json'),
  );
  const robinhood = Object.fromEntries(
    Object.entries(fetched?.covered ?? {}).map(([k, ranges]) => [
      k,
      {
        ranges: ranges.length,
        blocks: ranges.reduce((a, r) => a + (r.to - r.from + 1), 0),
        newest: ranges.reduce((a, r) => Math.max(a, r.to), 0),
      },
    ]),
  );
  const external = folders(join(out, 'external')).map((s) => {
    const m = readJson<Manifest>(join(out, 'external', s, 'manifest.json'));
    return { subject: s, rows: m?.rows ?? 0, updatedAt: m?.updatedAt ?? null };
  });
  const chainlinkDir = join(out, 'robinhood', 'chainlink');
  const chainlink = folders(chainlinkDir).map((s) => {
    const m = readJson<Manifest>(join(chainlinkDir, s, 'manifest.json'));
    return { feed: s, rows: m?.rows ?? 0, covered: m?.covered ?? [] };
  });

  const report = {
    at: new Date().toISOString(),
    window: {
      days,
      from: new Date(from * 1000).toISOString(),
      to: new Date(now * 1000).toISOString(),
    },
    out,
    registry: registry ?? null,
    solanaSwaps: solana(
      'swaps',
      poolList.map((p) => p.address),
    ),
    solanaMints: solana('mints', []),
    robinhoodLogs: robinhood,
    chainlinkRounds: {
      feeds: chainlink.length,
      rounds: chainlink.reduce((a, c) => a + c.rows, 0),
      feedsList: chainlink,
    },
    externalDaily: {
      subjects: external.length,
      today: external.filter(
        (e) => e.updatedAt?.slice(0, 10) === new Date().toISOString().slice(0, 10),
      ).length,
      list: external,
    },
  };
  const file = join(out, `backfill-status-${report.at.slice(0, 16).replace(/[-:]/g, '')}.json`);
  writeFileSync(file, `${JSON.stringify(report, null, 1)}\n`);
  const s = report.solanaSwaps;
  const m = report.solanaMints;
  console.log(
    JSON.stringify(
      {
        file,
        window: report.window,
        solanaSwaps: {
          subjects: s.subjects,
          complete: s.complete,
          daysMissing: s.daysMissing,
          gb: +(s.bytes / 1e9).toFixed(2),
        },
        solanaMints: {
          subjects: m.subjects,
          complete: m.complete,
          daysMissing: m.daysMissing,
          gb: +(m.bytes / 1e9).toFixed(2),
        },
        robinhoodLogs: robinhood,
        chainlinkRounds: {
          feeds: report.chainlinkRounds.feeds,
          rounds: report.chainlinkRounds.rounds,
        },
        externalDaily: {
          subjects: report.externalDaily.subjects,
          writtenToday: report.externalDaily.today,
        },
      },
      null,
      1,
    ),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
