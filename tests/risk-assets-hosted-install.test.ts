import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// The hosted installers on Thom's Mac (gate ASSET-METRICS, amended 2026-10-22), run under a made-up HOME with a
// stand-in for launchctl first on the PATH: nothing here reaches this machine's ~/.colosseum, its LaunchAgents or
// launchd, and no job is run. What is held: the Robinhood Chain bars job takes the hosted loop's stock list, whose cut
// is the one in the loop's folder, and refuses when no list's cut is there; every hosted plist sets the connect
// timeout Neon needs; the hosted metrics bundle reads the served rows inside its window.
const BARS = resolve('scripts/ops/install-hosted-bars.sh');
const METRICS = resolve('scripts/risk/assets/install-job-solana.sh');
const REPO_LIST = resolve('scripts/risk/universe/robinhood.json');
const hasZsh = spawnSync('zsh', ['-c', 'exit 0']).status === 0;

const root = mkdtempSync(join(tmpdir(), 'hosted-install-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const stub = join(root, 'bin');
const calls = join(root, 'launchctl.log');
mkdirSync(stub);
writeFileSync(join(stub, 'launchctl'), `#!/bin/sh\necho "launchctl $*" >> "${calls}"\n`);
chmodSync(join(stub, 'launchctl'), 0o755);

const repoCut = (JSON.parse(readFileSync(REPO_LIST, 'utf8')) as { inputs: { cut: string } }).inputs
  .cut;
const HOSTED_CUT = 'cut-robinhood-20261006T1933.json';

/** A made-up HOME with the hosted loop's folder: its env file, its evm folder with the cuts given, its own list. */
const fakeHome = (name: string, o: { cuts: string[]; hostedList?: boolean }) => {
  const home = join(root, name);
  const hosted = join(home, '.colosseum', 'hosted-risk');
  const evm = join(hosted, 'evm');
  mkdirSync(evm, { recursive: true });
  mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
  writeFileSync(
    join(hosted, 'env'),
    'DATABASE_URL=postgres://made-up@127.0.0.1:9/x\nSOLANA_RPC_URL=http://127.0.0.1:9/made-up\n',
  );
  for (const c of o.cuts) writeFileSync(join(evm, c), '{"chain":"robinhood","pools":[]}');
  writeFileSync(join(evm, 'universe-robinhood-20261006T1933.json'), '{}');
  if (o.hostedList) {
    const dir = join(hosted, 'evm-work', 'scripts', 'risk', 'universe');
    mkdirSync(dir, { recursive: true });
    const list = JSON.parse(readFileSync(REPO_LIST, 'utf8'));
    list.inputs.cut = HOSTED_CUT;
    list.assets.push({ ...list.assets[0], symbol: 'IBM' });
    writeFileSync(join(dir, 'robinhood.json'), JSON.stringify(list));
  }
  return { home, hosted };
};
const run = (script: string, home: string, args: string[], env: Record<string, string> = {}) => {
  rmSync(calls, { force: true });
  const base: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(base))
    if (k.startsWith('RISK_') || k === 'COLOSSEUM_HOME' || k === 'HOSTED_HOME') delete base[k];
  const r = spawnSync('zsh', [script, ...args], {
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...base, HOME: home, PATH: `${stub}:${process.env.PATH}`, ...env },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};
const launchctlCalls = () =>
  existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean) : [];
const NODE_OPTIONS =
  '<key>NODE_OPTIONS</key><string>--network-family-autoselection-attempt-timeout=3000</string>';

describe.skipIf(!hasZsh)('the hosted bars installer, Robinhood Chain', { timeout: 180_000 }, () => {
  it("takes the hosted loop's list, whose cut is in the loop's folder; its plist sets NODE_OPTIONS", () => {
    const { home, hosted } = fakeHome('loop-list', { cuts: [HOSTED_CUT], hostedList: true });
    const r = run(BARS, home, ['robinhood']);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain(
      `the stock list: ${hosted}/evm-work/scripts/risk/universe/robinhood.json`,
    );
    const copied = JSON.parse(readFileSync(join(hosted, 'universe', 'robinhood.json'), 'utf8'));
    expect(copied.inputs.cut).toBe(HOSTED_CUT);
    expect(copied.assets.some((a: { symbol: string }) => a.symbol === 'IBM')).toBe(true);
    const plist = readFileSync(
      join(home, 'Library', 'LaunchAgents', 'com.colosseum.hosted-bars-robinhood.plist'),
      'utf8',
    );
    expect(plist.replace(/\s+/g, '')).toContain(NODE_OPTIONS.replace(/\s+/g, ''));
    expect(plist).toContain('--write-window 10-25');
    // unloaded first, loaded last: nothing the install runs overlaps a scheduled run
    expect(launchctlCalls().map((l) => l.split(' ')[1])).toEqual(['unload', 'load']);
  });

  it("refuses, naming each list and its cut, when no list's cut is in the folder", () => {
    const { home, hosted } = fakeHome('no-cut', { cuts: [], hostedList: true });
    const r = run(BARS, home, ['robinhood']);
    expect(r.status).toBe(1);
    expect(r.out).toContain('refusing: no stock list whose cut is in');
    expect(r.out).toContain(`its cut ${HOSTED_CUT} is not in`);
    expect(r.out).toContain(`its cut ${repoCut} is not in`);
    expect(existsSync(join(hosted, 'risk-hosted-bars.mjs'))).toBe(false);
    expect(launchctlCalls()).toEqual([]);
  });

  it('--list takes that list only; the repository list is taken when its cut is the one there', () => {
    const { home } = fakeHome('list-arg', { cuts: [HOSTED_CUT], hostedList: true });
    const r = run(BARS, home, ['robinhood', '--list', REPO_LIST]);
    expect(r.status).toBe(1);
    expect(r.out).toContain(`${REPO_LIST}: its cut ${repoCut} is not in`);
    const repoOnly = fakeHome('repo-cut', { cuts: [repoCut] });
    const ok = run(BARS, repoOnly.home, ['robinhood']);
    expect(ok.status, ok.out).toBe(0);
    expect(ok.out).toContain(`the stock list: ${REPO_LIST}`);
  });
});

describe.skipIf(!hasZsh)('the hosted metrics installer, Solana', { timeout: 300_000 }, () => {
  it('the bundle reads the served rows inside minutes 10 to 25; the plist sets NODE_OPTIONS', () => {
    const { home, hosted } = fakeHome('metrics', { cuts: [] });
    const r = run(METRICS, home, ['--hosted']);
    expect(r.status, r.out).toBe(0);
    const plist = readFileSync(
      join(home, 'Library', 'LaunchAgents', 'com.colosseum.hosted-assets-solana.plist'),
      'utf8',
    );
    expect(plist.replace(/\s+/g, '')).toContain(NODE_OPTIONS.replace(/\s+/g, ''));
    expect(plist).toContain('<dict><key>Minute</key><integer>21</integer></dict>');
    // the collectors' template the plist is made from is left as it is
    expect(readFileSync(resolve('scripts/risk/collector/risk-job.plist'), 'utf8')).not.toContain(
      'NODE_OPTIONS',
    );
    const bundle = join(hosted, 'risk-assets-solana.mjs');
    const plan = spawnSync(process.execPath, [bundle, '--plan'], {
      encoding: 'utf8',
      cwd: '/',
      env: { PATH: process.env.PATH },
    });
    expect(plan.status, plan.stderr).toBe(0);
    const p = JSON.parse(plan.stdout) as Record<string, unknown>;
    expect(p).toMatchObject({
      chain: 'solana',
      scope: 'served',
      rows: 100,
      window: { from: 10, to: 25 },
    });
  });
});
