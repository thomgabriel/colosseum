import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The Bash guard that every Claude session in this repo runs (.claude/hooks/guard-bash.mjs, rules in lib.mjs).
const hooks = join(import.meta.dirname, '..', '.claude', 'hooks');
let repo: string;
let guardVerdict: (command: string, cwd: string) => string | null;

const git = (args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd: repo,
    stdio: 'ignore',
  });
const blocked = (command: string) => guardVerdict(command, repo) !== null;

beforeAll(async () => {
  ({ guardVerdict } = await import(pathToFileURL(join(hooks, 'lib.mjs')).href));
  repo = mkdtempSync(join(tmpdir(), 'guard-'));
  git(['init', '-q', '-b', 'main']);
  git(['commit', '-q', '--allow-empty', '-m', 'init']);
  git(['branch', 'staging']);
  git(['switch', '-q', '-c', 'chore/x']);
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

const BLOCKED = [
  'git push -f',
  'git push --force',
  'git push --force-with-lease',
  'git push --force-with-lease=chore/x origin chore/x',
  'git push origin HEAD:main',
  'git push upstream chore/x:staging',
  'git push origin +main',
  'git push origin +chore/x',
  'git -C . push origin main',
  'git push origin main',
  'git push origin staging',
  'git push origin refs/heads/main',
  'git push origin HEAD:refs/heads/main',
  'git push origin HEAD:refs/heads/staging',
  'git push origin main:main',
  'git push origin "main"',
  "git push origin 'HEAD:main'",
  'git push -fu origin chore/x',
  'git push -uf origin chore/x',
  'git push --force-if-includes --force-with-lease origin x',
  'git push --mirror origin',
  'git push --all origin',
  'git push origin --delete staging',
  'git push origin :staging',
  'git push origin main~1:main',
  'git push origin HEAD:main --no-verify',
  'cd apps && git push origin main',
  'echo hi; git push origin main',
  'true || git push origin main',
  'git fetch & git push origin main',
  '(git push origin main)',
  'bash -c "git push origin main"',
  'git push origin $(echo main)',
  'B=main; git push origin $B',
  'git push origin HEAD:ma""in',
  'gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc -F force=true',
  'tsx scripts/mainnet/sign-and-send.ts',
  'node ./scripts/archive/x.ts',
  'pnpm run sign-and-send',
  'pnpm sign-and-send',
  'pnpm -s sign-and-send -- --foo',
  'npm run sign-and-send',
  'yarn sign-and-send',
  'npx pnpm sign-and-send',
  'cd scripts/mainnet && tsx sign-and-send.ts',
  'cd scripts && tsx mainnet/sign-and-send.ts',
  'tsx scripts/mainnet/../mainnet/sign-and-send.ts',
  'tsx scripts//mainnet/sign-and-send.ts',
  'tsx ./scripts/./mainnet/sign-and-send.ts',
  'pnpm exec tsx scripts/mainnet/sign-and-send.ts',
  'git commit -n -m x',
  'git commit --no-verify -m x',
  'git commit -nm x',
  'git commit -anm x',
  'git push --no-verify origin chore/x',
  'git add . && git commit --no-verify -m x',
  'git -c core.hooksPath=/dev/null commit -m x',
  'pnpm wallet:export',
  'tsx scripts/wallet-export.ts',
  'CLUSTER=mainnet RPC_URL=x OWNER_KEYPAIR=y tsx spikes/solana-vault-swap/scripts/run-swap.ts --send',
  'export CLUSTER=mainnet; tsx spikes/solana-vault-swap/scripts/run-swap.ts --send',
  'gh api -X PATCH repos/o/r/git/refs/heads/staging -f sha=abc',
  'git push origin chore/*',
];

const ALLOWED = [
  'gh pr merge 12 --merge',
  'cat scripts/mainnet/sign-and-send.ts | tsx -',
  'cat scripts/mainnet/sign-and-send.ts > /tmp/x.ts && tsx /tmp/x.ts',
  'cp scripts/mainnet/sign-and-send.ts /tmp/x.ts',
  'head -c 100000 scripts/mainnet/sign-and-send.ts > x.ts',
  'pnpm execute:demo',
  'tsx scripts/execute-demo.ts',
  'git push origin feature/main-menu',
  'git push origin chore/organize',
  'git push -u origin chore/organize',
  'git push origin fix/staging-banner',
  'git push origin docs/main',
  'git push origin web/main',
  'git push origin chore/x # not main',
  'grep -r "scripts/mainnet" docs',
  'rg "scripts/mainnet/" docs CLAUDE.md',
  'git log main..HEAD',
  'git log --oneline staging..HEAD',
  'cat scripts/mainnet/README.md',
  'ls scripts/mainnet/',
  'ls -la scripts/archive/',
  'git diff upstream/staging...HEAD -- scripts/mainnet/',
  'git log --oneline -- scripts/archive/',
  'git grep -n "push" -- docs',
  'git log --grep="push to main"',
  'git commit -m "docs: explain why we do not push to main"',
  'git commit -m "chore: move sign-and-send under scripts/mainnet/"',
  'git commit -m "docs: never use --no-verify"',
  'git commit -m "fix: x" -m "second; line"',
  'git stash push -m wip',
  'git stash push -u -m "wip main"',
  'git push',
  'git push -u origin HEAD',
  'git push origin HEAD',
  'git fetch origin main',
  'git switch -c chore/x origin/staging',
  'git merge origin/staging',
  'git pull --ff-only',
  'gh pr create --base staging --title "push fix" --body "x"',
  'gh pr create --base staging --title "git: block push to main" --body x',
  'echo "git push origin main"',
  'pnpm verify',
  'pnpm test tests/risk-layer/pools.test.ts',
  'biome check scripts/mainnet/sign-and-send.ts',
  'pnpm exec biome format scripts/archive/d2pm-spike.ts',
  'pnpm exec tsc -p tsconfig.json',
  'git blame scripts/mainnet/sign-and-send.ts',
  'git ls-files scripts/archive/',
  'git rm --cached scripts/archive/x.ts',
  'git restore scripts/mainnet/sign-and-send.ts',
  'git checkout upstream/staging -- scripts/mainnet/README.md',
  'sed -n 1,20p scripts/mainnet/sign-and-send.ts',
  'wc -l scripts/archive/*.ts',
  'find . -path "./scripts/archive/*" -name "*.ts"',
  'grep -n "sign-and-send" package.json | head',
  'grep -rn "pnpm sign-and-send" docs',
  'cat package.json | grep sign-and-send',
  'git diff --stat | tail -5',
  'git push origin chore/x 2>&1 | tail -5',
  'git log --oneline -5 | cat; git push origin chore/x',
  'CLUSTER=devnet tsx spikes/solana-vault-swap/scripts/run-swap.ts',
  'gh api repos/o/r/git/refs/heads/main',
  'gh pr create --base staging --title x --body "$(cat <<EOF\nline about push to main\ngit push origin main\nEOF\n)"',
  'git commit -m "$(cat <<EOF\nvault: x\n\ntsx scripts/mainnet/sign-and-send.ts was moved\nEOF\n)"',
  'git commit --amend -m x',
  'pnpm exec vitest run tests/risk-layer/pools.test.ts',
  'node .claude/hooks/session-start.mjs',
  // Reading or copying a mainnet script is not running it. The guard stops mistakes; it is not a sandbox.
];

const ON_A_SHARED_BRANCH = [
  'git push',
  'git push origin',
  'git push origin HEAD',
  'git push -u origin HEAD',
  'git push --set-upstream origin HEAD',
  'git push origin @',
  'git push -q',
];

describe('the Bash guard', () => {
  it('blocks pushes to shared branches, force pushes, skipped checks and the money scripts', () => {
    expect(BLOCKED.filter((c) => !blocked(c))).toEqual([]);
  });
  it('allows ordinary work, including text that only mentions those commands', () => {
    expect(ALLOWED.filter(blocked)).toEqual([]);
  });
  it('blocks every bare push while on main', () => {
    git(['switch', '-q', 'main']);
    try {
      expect(ON_A_SHARED_BRANCH.filter((c) => !blocked(c))).toEqual([]);
    } finally {
      git(['switch', '-q', 'chore/x']);
    }
  });
  it('blocks a push after switching to a shared branch in the same command', () => {
    expect(blocked('git checkout main && git merge staging && git push')).toBe(true);
    expect(blocked('git switch staging; git push origin HEAD')).toBe(true);
  });
  it('allows pushing a new branch made in the same command', () => {
    expect(blocked('git switch -c chore/y && git push -u origin HEAD')).toBe(false);
  });
  it('exits with 2 as a hook when it blocks, and 0 when it does not', { timeout: 30_000 }, () => {
    const run = (command: string) =>
      spawnSync('node', [join(hooks, 'guard-bash.mjs')], {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: repo }),
        encoding: 'utf8',
      });
    expect(run('git push origin main').status).toBe(2);
    expect(run('git push origin main').stderr).toContain('would land on main');
    expect(run('git status').status).toBe(0);
  });
});

// The check before Claude's commits (.githooks/pre-commit, .claude/hooks/pre-commit.mjs), run in a
// clone of its own whose `verify:quick` is two small steps: one that only talks, one that fails on a
// file holding the word BROKEN. Nothing here runs this repo's real check.
describe('the check before Claude’s commits', () => {
  const root = join(import.meta.dirname, '..');
  const bare = (process.env.PATH ?? '')
    .split(':')
    .filter((dir) => !dir.includes('node_modules'))
    .join(':');
  let clone: string;
  const write = (file: string, text: string) => {
    mkdirSync(dirname(join(clone, file)), { recursive: true });
    writeFileSync(join(clone, file), text);
  };
  const run = (args: string[], env: Record<string, string | undefined>, input?: string) =>
    spawnSync(args[0] as string, args.slice(1), {
      cwd: clone,
      encoding: 'utf8',
      input,
      // no tools folder on the path but what the hook adds: the clone's own is found by the hook alone
      env: { ...process.env, PATH: bare, CLAUDECODE: undefined, ...env },
    });
  /** A commit of what is staged, through git's own hook, as Claude makes one or as a person does. */
  const commit = (by: 'claude' | 'person') =>
    run(
      ['git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'x'],
      by === 'claude' ? { CLAUDECODE: '1' } : {},
    );
  const stage = (file: string, text: string) => {
    write(file, text);
    run(['git', 'add', file], {});
  };

  beforeAll(() => {
    clone = mkdtempSync(join(tmpdir(), 'pre-commit-'));
    for (const file of [
      '.githooks/pre-commit',
      '.claude/hooks/pre-commit.mjs',
      '.claude/hooks/lib.mjs',
    ])
      write(file, readFileSync(join(root, file), 'utf8'));
    chmodSync(join(clone, '.githooks/pre-commit'), 0o755);
    write('talks.mjs', "for (let i = 0; i < 200; i++) console.error('a warning of no account');\n");
    write(
      'check.mjs',
      "import { readFileSync } from 'node:fs';\nif (readFileSync('a.ts', 'utf8').includes('BROKEN')) { console.log('a.ts(1,1): error: BROKEN in a.ts'); process.exit(1); }\n",
    );
    // a tool of the clone's own, found as `pnpm run` finds it (a `tsc` on the system once stood in)
    write('node_modules/.bin/own-tool', '#!/bin/sh\nexit 0\n');
    chmodSync(join(clone, 'node_modules/.bin/own-tool'), 0o755);
    write('.gitignore', 'node_modules\n');
    write(
      'package.json',
      JSON.stringify({
        scripts: { 'verify:quick': 'own-tool && node talks.mjs && node check.mjs' },
      }),
    );
    write('a.ts', 'export const a = 1;\n');
    run(['git', 'init', '-q', '-b', 'main'], {});
    run(['git', 'config', 'core.hooksPath', '.githooks'], {});
    run(['git', 'add', '.'], {});
    expect(commit('person').status).toBe(0);
  });
  afterAll(() => rmSync(clone, { recursive: true, force: true }));

  it('stops a commit of Claude’s that fails it, and says the failing step’s own words', () => {
    stage('a.ts', 'export const a = BROKEN;\n');
    const r = commit('claude');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('`node check.mjs` (of `pnpm verify:quick`) failed');
    expect(r.stderr).toContain('error: BROKEN in a.ts');
    // the other step's talk is not in it
    expect(r.stderr).not.toContain('a warning of no account');
  });

  it('leaves a person’s commit to CI', () => {
    stage('a.ts', 'export const a = BROKEN;\n');
    expect(commit('person').status).toBe(0);
  });

  it('skips a commit of documents only, whatever else the checkout holds', () => {
    write('a.ts', 'export const a = BROKEN;\n');
    stage('notes.md', 'notes\n');
    expect(commit('claude').status).toBe(0);
  });

  it('lets a commit of Claude’s that passes it through', () => {
    stage('a.ts', 'export const a = 2;\n');
    expect(commit('claude').status).toBe(0);
  });

  it('stops a commit of Claude’s in a checkout with no node_modules, and says to install there', () => {
    stage('a.ts', 'export const a = 3;\n');
    renameSync(join(clone, 'node_modules'), join(clone, 'node_modules.away'));
    try {
      const r = commit('claude');
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('this checkout has no node_modules');
      // the checkout named as git names it (/private/var for /var on macOS)
      expect(r.stderr).toMatch(new RegExp(`Run \`pnpm install\` in \\S*${basename(clone)}`));
    } finally {
      renameSync(join(clone, 'node_modules.away'), join(clone, 'node_modules'));
    }
    expect(commit('claude').status).toBe(0);
  });

  it('as the session hook, stands aside only where git’s own hook is set up and in the checkout', () => {
    write('a.ts', 'export const a = BROKEN;\n');
    const session = () =>
      run(
        ['node', '.claude/hooks/pre-commit.mjs'],
        {},
        JSON.stringify({ tool_input: { command: 'git commit -m x' }, cwd: clone }),
      );
    expect(session().status).toBe(0);
    // a branch cut before the git hook: set up in the clone, not in this checkout
    rmSync(join(clone, '.githooks/pre-commit'));
    const r = session();
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('error: BROKEN in a.ts');
  });
});

// The hook runs `verify:quick` a step at a time, split on `&&`, each step on its own in the
// checkout's root: a step that leans on another (`cd x && …`, a `;` or a pipe) would be split
// apart and checked in the wrong place. The script's shape is held here; a change to it is a
// change to .claude/hooks/pre-commit.mjs too.
describe('the check’s script, as the hook splits it', () => {
  const scripts = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'))
    .scripts as Record<string, string>;
  const steps = (scripts['verify:quick'] ?? '').split('&&').map((step) => step.trim());

  it('is the steps the hook knows: lint, the packages’ typechecks, the root tsc', () => {
    expect(steps).toEqual(['pnpm lint', 'pnpm typecheck', 'tsc -p tsconfig.json']);
  });

  it('has each step stand alone: no change of folder, no `;`, `||` or pipe', () => {
    for (const step of steps) {
      expect(step, step).not.toMatch(/^cd\b|[;|]|\$\(|`/);
      expect(step, step).not.toBe('');
    }
  });
});

// `pnpm install`'s `prepare` (scripts/git-hooks.mjs): sets the hooks to .githooks, and leaves a clone's
// own hooks as they are, saying so.
describe('setting up the git hook', () => {
  const script = join(import.meta.dirname, '..', 'scripts', 'git-hooks.mjs');
  const fresh = () => {
    const at = mkdtempSync(join(tmpdir(), 'hooks-setup-'));
    spawnSync('git', ['init', '-q'], { cwd: at });
    return at;
  };
  const setUp = (at: string) => spawnSync('node', [script], { cwd: at, encoding: 'utf8' });
  const hooksPath = (at: string) =>
    spawnSync('git', ['config', '--get', 'core.hooksPath'], {
      cwd: at,
      encoding: 'utf8',
    }).stdout.trim();

  it('sets them in a clone with none of its own', () => {
    const at = fresh();
    setUp(at);
    expect(hooksPath(at)).toBe('.githooks');
    rmSync(at, { recursive: true, force: true });
  });

  it('leaves a hooks path the clone has, and says so', () => {
    const at = fresh();
    spawnSync('git', ['config', 'core.hooksPath', 'my-hooks'], { cwd: at });
    expect(setUp(at).stdout).toContain('already my-hooks, left as it is');
    expect(hooksPath(at)).toBe('my-hooks');
    rmSync(at, { recursive: true, force: true });
  });

  it('leaves any hook the clone keeps in .git/hooks, a pre-push as much as a pre-commit, and names it', () => {
    for (const hook of ['pre-commit', 'pre-push']) {
      const at = fresh();
      writeFileSync(join(at, '.git', 'hooks', hook), '#!/bin/sh\nexit 0\n');
      const said = setUp(at).stdout;
      expect(said).toContain(`(${hook}), left as they are`);
      expect(hooksPath(at)).toBe('');
      rmSync(at, { recursive: true, force: true });
    }
  });

  it('counts git’s samples as none of the clone’s own', () => {
    const at = fresh();
    writeFileSync(join(at, '.git', 'hooks', 'pre-push.sample'), '#!/bin/sh\n');
    setUp(at);
    expect(hooksPath(at)).toBe('.githooks');
    rmSync(at, { recursive: true, force: true });
  });
});
