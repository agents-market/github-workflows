#!/usr/bin/env node
// The two mechanical halves of the error-autofix workflow.
//
//   node error-autofix.mjs sources   the pipeline's inputs, from a stack trace
//   node error-autofix.mjs apply     the fix, applied to the checkout
//
// Both halves are code, on purpose. The model is asked what is wrong and what
// to change; deciding which files the error points at, whether the fix can be
// applied unambiguously, and what the pull request says is arithmetic and
// text, and that belongs to a program. A model asked to produce a diff
// produces a diff that does not apply.
//
// The script writes its results to $GITHUB_OUTPUT, the way a workflow step
// writes what the next step reads. Without that variable it prints them, so
// the same script can be run by hand.
//
// The check that keeps this honest is scripts/check-error-autofix.mjs.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';

// Three files is what a stack trace usually names, and it is what the model
// can hold in its head. One file is the common case and the best one.
const MAX_FILES = 3;
// A file this size is code a human reads. Bigger is a bundle or a lockfile,
// and the error did not come from there.
const MAX_FILE_CHARS = 12000;
// The consumer's own record of known issues, when they keep one.
const PLAYBOOK_DEFAULT = '.error-playbook.json';

const command = process.argv[2];
const workspace = resolve(process.argv[3] || process.cwd());

/** Write a step output. A value with a newline needs the delimiter form. */
function emit(name, value) {
  const text = String(value);
  const file = process.env.GITHUB_OUTPUT;
  if (!file) {
    console.log(`${name}=${text}`);
    return;
  }
  if (!text.includes('\n')) {
    appendFileSync(file, `${name}=${text}\n`);
    return;
  }
  // The delimiter has to be a line of its own and must not appear in the
  // value, or the output ends where the value happens to mention it.
  let delimiter = 'AM_AUTOFIX_EOF';
  while (text.includes(delimiter)) delimiter += '_';
  appendFileSync(file, `${name}<<${delimiter}\n${text}\n${delimiter}\n`);
}

/** A path that stays inside the repository. `../` and absolute paths do not. */
function inside(candidate) {
  const root = resolve(workspace);
  const full = resolve(root, candidate);
  return full === root || full.startsWith(root + sep);
}

/**
 * The consumer's playbook: the errors they know about and the fix each of
 * them gets.
 *
 * It is configuration, not code. The same script runs in every consumer's
 * repository, and the specifics — which errors, which files, which fix —
 * live in the consumer's own file. JSON, because the workflow that runs this
 * script installs no packages.
 *
 * Returns null when there is no playbook: a repository without one is
 * normal. A playbook that exists and does not parse is an error — a fix
 * built on the wrong playbook is worse than no fix.
 */
function readPlaybook() {
  const name = process.env.PLAYBOOK_FILE || PLAYBOOK_DEFAULT;
  const file = resolve(workspace, name);
  if (!existsSync(file)) return null;
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`the playbook ${name} is not valid JSON: ${e.message}`);
  }
  const issues = Array.isArray(data) ? data : (data && data.issues) || [];
  const usable = issues.filter((i) => i && typeof i.signature === 'string' && i.signature.trim());
  return { name, issues: usable };
}

/**
 * The first playbook entry that matches the error.
 *
 * `contains` and `exact` look at the message — the first line of the report.
 * `regex` looks at the whole report, because a stack can carry the text.
 * The first entry that matches wins, so the order in the file is the order
 * of precedence.
 */
function matchPlaybook(playbook, report) {
  if (!playbook) return null;
  const message = (report.split('\n')[0] || '').trim();
  for (const issue of playbook.issues) {
    const signature = issue.signature.trim();
    const mode = issue.match || 'contains';
    if (mode === 'exact') {
      if (message.toLowerCase() === signature.toLowerCase()) return issue;
    } else if (mode === 'regex') {
      let re = null;
      try { re = new RegExp(signature); } catch { re = null; }
      if (re && re.test(report)) return issue;
    } else if (message.toLowerCase().includes(signature.toLowerCase())) {
      return issue;
    }
  }
  return null;
}

/**
 * The files the stack trace points at.
 *
 * The paths are read out of the error text by pattern, and a path is taken
 * only when it exists in this checkout. The model is not asked to find them:
 * it is asked to fix code, and a file it cannot see is a file it would
 * invent.
 *
 * The playbook comes first: when the consumer has written down a known
 * issue, the files they name for it are the ones the fix belongs in.
 */
function resolveFiles(report, playbookMatch) {
  const files = [];
  const seen = new Set();
  const add = (path) => {
    if (!path || seen.has(path)) return;
    if (path.startsWith('..') || path.includes('node_modules/')) return;
    if (!existsSync(join(workspace, path))) return;
    seen.add(path);
    files.push(path);
  };
  for (const hint of (playbookMatch && playbookMatch.files_hint) || []) {
    if (files.length === MAX_FILES) break;
    add(String(hint).replace(/^\.?\//, ''));
  }
  const candidates = report.replace(/\\/g, '/').match(/[A-Za-z0-9_./-]+\.[A-Za-z]{1,6}/g) || [];
  for (const candidate of candidates) {
    if (files.length === MAX_FILES) break;
    add(candidate.replace(/^\.?\//, ''));
  }
  return files;
}

/**
 * The stage's output text.
 *
 * The action publishes it per stage (`stage_<id>_output`) and also the whole
 * run as a record of stage id → output text. The first is exact; the second
 * is the fallback, and its last entry is the last stage that ran.
 */
function stageOutput() {
  const direct = process.env.STAGE_OUTPUT || '';
  if (direct.trim()) return direct;
  const record = process.env.RESULT_JSON || '';
  if (!record.trim()) return '';
  try {
    const outputs = JSON.parse(record);
    const values = Object.values(outputs).filter((v) => typeof v === 'string' && v.trim());
    return values.length ? values[values.length - 1] : '';
  } catch {
    return '';
  }
}

/** `sources` — the pipeline's inputs, from a stack trace and a checkout. */
function sources() {
  const report = process.env.ERROR_REPORT || '';
  const context = process.env.REPO_CONTEXT || '';
  const playbook = readPlaybook();
  const match = matchPlaybook(playbook, report);
  const files = resolveFiles(report, match);
  if (!files.length) {
    if (match) {
      console.error(`the playbook matched "${match.signature}" but names no file that exists in this checkout, and the stack points at nothing here — nothing to fix`);
    } else {
      console.error('no file in the stack trace exists in this checkout — nothing to fix');
    }
    process.exit(1);
  }
  const sourceFiles = {};
  for (const file of files) {
    sourceFiles[file] = readFileSync(join(workspace, file), 'utf8').slice(0, MAX_FILE_CHARS);
  }
  // Only the matched entry goes to the pipeline: the whole playbook is the
  // consumer's configuration, and the model is told about the one issue
  // this error is.
  const entry = match ? {
    signature: match.signature,
    approach: String(match.approach || ''),
    files_hint: (match.files_hint || []).map(String),
    needs_location: match.needs_location !== false,
  } : {};
  emit('inputs_json', JSON.stringify({
    error_report: report.slice(0, 20000),
    source_files: sourceFiles,
    repo_context: context.slice(0, 4000),
    playbook: entry,
  }));
  emit('playbook_json', JSON.stringify(entry));
  console.log(`resolved ${files.length} file(s) from the stack: ${files.join(', ')}`);
  if (match) console.log(`playbook matched: ${match.signature}`);
}

/** `apply` — the fix, applied to the checkout, and the pull request's text. */
function apply() {
  const report = process.env.ERROR_REPORT || '';
  let analysis = {};
  let fix = {};
  let playbook = {};
  try {
    playbook = JSON.parse(process.env.PLAYBOOK_JSON || '{}') || {};
  } catch {
    // A playbook that does not parse is the `sources` step's failure, not
    // this one's: by the time a fix is applied, the playbook has already
    // been read once.
    playbook = {};
  }
  try {
    const parsed = JSON.parse(stageOutput());
    analysis = parsed.analysis || {};
    fix = parsed.fix || {};
  } catch {
    // An empty or unreadable stage output is not a crash: it is a fix that
    // did not arrive, and it becomes an issue below.
  }

  const path = String(fix.file || '');
  const oldSnippet = typeof fix.old_snippet === 'string' ? fix.old_snippet : '';
  const newSnippet = typeof fix.new_snippet === 'string' ? fix.new_snippet : '';
  const testPath = String(fix.test_path || '');
  const testContent = typeof fix.test_content === 'string' ? fix.test_content : '';

  let reason = '';
  let content = '';
  if (!path || !oldSnippet) {
    reason = 'the pipeline named no file to change';
  } else if (!inside(path)) {
    reason = `the pipeline named a file outside this repository: \`${path}\``;
  } else if (!existsSync(join(workspace, path))) {
    reason = `the file the pipeline named is not in this checkout: \`${path}\``;
  } else {
    content = readFileSync(join(workspace, path), 'utf8');
    const hits = content.split(oldSnippet).length - 1;
    if (hits !== 1) {
      reason = `the text to replace occurs ${hits} times in \`${path}\` — a fix has to be unambiguous`;
    } else if (testPath && existsSync(join(workspace, testPath))) {
      reason = `the test the pipeline wrote would overwrite an existing file: \`${testPath}\``;
    }
  }

  const changed = [];
  if (!reason) {
    writeFileSync(join(workspace, path), content.replace(oldSnippet, newSnippet));
    changed.push(path);
    if (testPath && testContent && inside(testPath)) {
      const full = join(workspace, testPath);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, testContent.endsWith('\n') ? testContent : `${testContent}\n`);
      changed.push(testPath);
    }
  }

  let patch = '';
  if (changed.length) {
    // Only the files the fix touches. The installed pipeline sits in the
    // workspace too, and `git add -A` would put it in the commit.
    execFileSync('git', ['add', '--', ...changed], { cwd: workspace });
    patch = execFileSync('git', ['diff', '--cached', '--no-color'], { cwd: workspace, encoding: 'utf8' });
  }

  // A pull request is opened only for a mechanical fix: one source file
  // changed, a patch that is not empty, and a test that reproduces the
  // error. Anything else is an issue with the analysis attached, because a
  // pull request nobody can review is worse than an issue.
  const sourceFiles = changed.filter((c) => c !== testPath);
  const prReady = sourceFiles.length === 1
    && patch.trim() !== ''
    && Boolean(testPath)
    && Boolean(testContent);
  if (!prReady && !reason) reason = 'the fix did not change exactly one file with a test';

  const rootCause = String(analysis.root_cause || '').trim();
  const title = (rootCause ? `fix(${path}): ${rootCause}` : `fix: ${path}`).slice(0, 120);

  const body = ['## What broke', '', '~~~', report.trim().slice(0, 2000), '~~~', ''];
  if (playbook.signature) {
    body.push('## Known issue', '', `**Signature:** \`${playbook.signature}\``, '');
    if (playbook.approach) body.push(String(playbook.approach), '');
  }
  if (analysis && Object.keys(analysis).length) {
    body.push('## What the pipeline thinks', '');
    if (analysis.error_class) body.push(`**Error class:** \`${analysis.error_class}\``);
    if (rootCause) body.push('', `**Root cause:** ${rootCause}`);
    if (analysis.file) {
      let where = `\`${analysis.file}\``;
      if (analysis.line) where += `:${analysis.line}`;
      body.push('', `**At:** ${where}`);
    }
    if (analysis.explanation) body.push('', String(analysis.explanation));
    body.push('');
  }
  if (prReady) {
    body.push('## The fix', '');
    if (fix.explanation) body.push(String(fix.explanation), '');
    body.push(`**Test:** \`${testPath}\``, '');
  } else {
    body.push('## Why there is no pull request', '', reason, '');
  }
  body.push(
    '## How this was made', '',
    'Produced by the `error-autofix` pipeline and reviewed by the',
    'canonical AI review (security audit + style review) — see the run',
    'of this workflow. A bot opened this; a human approves it.', '',
  );

  const digest = createHash('sha1').update(report + path).digest('hex').slice(0, 8);
  emit('patch', patch.slice(0, 48000));
  emit('branch', `fix/auto-${digest}`);
  emit('title', title);
  emit('body', body.join('\n'));
  emit('pr_ready', prReady ? 'true' : 'false');
}

if (command === 'sources') sources();
else if (command === 'apply') apply();
else {
  console.error('usage: error-autofix.mjs <sources|apply> [workspace]');
  process.exit(2);
}
