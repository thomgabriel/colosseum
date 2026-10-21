#!/usr/bin/env node
// `pnpm verify:quick` (lint and the typechecks) before a commit Claude makes, in two ways:
// - with `--git`, as git's own pre-commit hook (.githooks/pre-commit, installed by `pnpm install`): it
//   runs wherever the Claude session started, a parent folder or another checkout included, where
//   the session hooks of .claude/settings.json are not loaded. Exit code 1 stops the commit.
// - otherwise as the session's PreToolUse hook for `git commit`, for a checkout where the git hook
//   is not installed yet. Where it is, this one stands aside, so the check runs once.
// A commit of documents and images only skips the check: CI still runs everything.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { git, gitCall, simpleCommands } from './lib.mjs';

const DOCUMENT = /\.(md|mdx|txt|csv|png|jpe?g|avif|webp|svg|pdf)$/i;
/** The longest message, in lines: the end of the failing step's own output. */
const SHOWN = 80;

/**
 * Runs `verify:quick` in `root` a step at a time (the `&&` parts of the script in package.json); null
 * when every step passed, else what to say: the step that failed and its own output, stdout and
 * stderr, so the reason is never pushed out by another step's (a type error once was, by lint's
 * warnings). Lint is run with warnings left out, as they fail nothing.
 */
function check(root) {
  let script = '';
  try {
    script =
      JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts?.['verify:quick'] ?? '';
  } catch {
    // no package.json to read: nothing to check here
  }
  // Without its own tools the check would run a system `tsc`, another version, or none: it is not run.
  const tools = join(root, 'node_modules', '.bin');
  if (!existsSync(tools))
    return `Commit blocked: this checkout has no node_modules, so \`pnpm verify:quick\` can't run with its own tools. Run \`pnpm install\` in ${root}, then commit again.`;
  const deadline = Date.now() + 280_000;
  for (const part of script
    .split('&&')
    .map((step) => step.trim())
    .filter(Boolean)) {
    const step = part === 'pnpm lint' ? 'pnpm lint --diagnostic-level=error' : part;
    const r = spawnSync(step, {
      cwd: root,
      shell: true,
      encoding: 'utf8',
      timeout: Math.max(1_000, deadline - Date.now()),
      // the repo's own tools first, as `pnpm run` has them (a `tsc` on the system is another version)
      env: { ...process.env, PATH: `${tools}${delimiter}${process.env.PATH ?? ''}` },
    });
    if (r.status === 0) continue;
    const said = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim().split('\n').slice(-SHOWN).join('\n');
    return `Commit blocked: \`${step}\` (of \`pnpm verify:quick\`) failed in ${root}. Fix it, then commit again.\n${r.error ? `${r.error.message}\n` : ''}${said}`;
  }
  return null;
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
  // git's own hook will run the check for this commit: it is set up, and this checkout holds it (a
  // branch cut before it has none, and then this hook is the only check)
  if (
    git(['config', '--get', 'core.hooksPath'], root) === '.githooks' &&
    existsSync(join(root, '.githooks', 'pre-commit'))
  )
    return 0;
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
