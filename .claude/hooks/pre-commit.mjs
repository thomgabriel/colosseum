#!/usr/bin/env node
// `pnpm verify:quick` (lint and the typechecks) before a commit Claude makes, in two ways:
// - with `--git`, as git's own pre-commit hook (.githooks/pre-commit, installed by `pnpm install`): it
//   runs wherever the Claude session started, a parent folder or another checkout included, where
//   the session hooks of .claude/settings.json are not loaded. Exit code 1 stops the commit.
// - otherwise as the session's PreToolUse hook for `git commit`, for a checkout where the git hook
//   is not installed yet. Where it is, this one stands aside, so the check runs once.
// A commit of documents and images only skips the check: CI still runs everything.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { git, gitCall, simpleCommands } from './lib.mjs';

const DOCUMENT = /\.(md|mdx|txt|csv|png|jpe?g|avif|webp|svg|pdf)$/i;

/** Runs the check in `root`; null when it passed, else what to say. */
function check(root) {
  const r = spawnSync('pnpm', ['verify:quick'], { cwd: root, encoding: 'utf8', timeout: 280_000 });
  if (r.status === 0) return null;
  // Lint's warnings go to stderr and the typecheck's errors to stdout: the end of each, stdout last,
  // so the step that failed is what the message ends on (a type error was once pushed out of it).
  const end = (text, lines) => (text ?? '').trim().split('\n').slice(-lines).join('\n');
  const tail = `${end(r.stderr, 12)}\n${end(r.stdout, 28)}`.trim();
  return `Commit blocked: \`pnpm verify:quick\` failed in ${root}. Fix it, then commit again.\n${r.error ? `${r.error.message}\n` : ''}${tail}`;
}

// The exit code is set, never forced with process.exit(): on some Node builds process.exit() can crash on the way
// out, and a crashed hook does not block.
function asGitHook() {
  const root = git(['rev-parse', '--show-toplevel'], process.cwd()) ?? process.cwd();
  // what this commit holds: the staged files (a merge's included)
  const staged = (git(['diff', '--cached', '--name-only'], root) ?? '').split('\n').filter(Boolean);
  if (staged.length > 0 && staged.every((f) => DOCUMENT.test(f))) return 0;
  const said = check(root);
  if (!said) return 0;
  console.error(said);
  return 1;
}

function asSessionHook() {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  // The `if` filter in settings.json is best-effort and lets other commands through, so check here.
  const commit = simpleCommands(String(input.tool_input?.command ?? ''), input.cwd)
    .map(gitCall)
    .find((call) => call?.sub === 'commit');
  if (!commit) return 0;

  // The commit's own checkout: in a worktree CLAUDE_PROJECT_DIR still points at the main one.
  const root =
    git(['rev-parse', '--show-toplevel'], commit.cwd) ??
    process.env.CLAUDE_PROJECT_DIR ??
    input.cwd;
  // git's own hook will run the check for this commit
  if (git(['config', '--get', 'core.hooksPath'], root) === '.githooks') return 0;
  const changed = (git(['status', '--porcelain'], root) ?? '')
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3).split(' -> ').pop());
  if (changed.every((f) => DOCUMENT.test(f))) return 0;

  const said = check(root);
  if (!said) return 0;
  console.error(said);
  return 2;
}

process.exitCode = process.argv.includes('--git') ? asGitHook() : asSessionHook();
