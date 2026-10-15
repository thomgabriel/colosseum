#!/usr/bin/env node
// Run by `pnpm install` (the `prepare` script): sets this clone's git hooks to .githooks, so the check
// before Claude's commits runs wherever the session started (CLAUDE.md, "Verification"). A clone that
// has hooks of its own, set by `core.hooksPath` or kept in .git/hooks, is left as it is, and says so.
// Outside a git checkout (a tarball, an image build) it does nothing.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const git = (args) => {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
};

function main() {
  if (git(['rev-parse', '--git-dir']) === null) return;
  const set = git(['config', '--get', 'core.hooksPath']);
  if (set === '.githooks') return;
  if (set) {
    console.log(
      `git hooks: core.hooksPath is already ${set}, left as it is. The check before Claude's commits (.githooks/pre-commit) is not set up here.`,
    );
    return;
  }
  // the folder every worktree of the clone shares, as git names it from here (git 2.30 has no
  // --path-format=absolute)
  const common = git(['rev-parse', '--git-common-dir']);
  const own = common ? resolve(common, 'hooks', 'pre-commit') : null;
  if (own && existsSync(own)) {
    console.log(
      `git hooks: ${own} is a hook of this clone's own, left as it is. The check before Claude's commits (.githooks/pre-commit) is not set up here.`,
    );
    return;
  }
  git(['config', 'core.hooksPath', '.githooks']);
  console.log('git hooks: core.hooksPath set to .githooks (the check before Claude’s commits).');
}

main();
