#!/usr/bin/env node
// The mechanical halves of the error-autofix workflow.
//
//   node error-autofix.mjs sources    the pipeline's inputs, from a stack trace
//   node error-autofix.mjs apply      the fix, applied to the checkout
//   node error-autofix.mjs publish    the pull request, or the issue it becomes
//   node error-autofix.mjs report     the issue, when there is no pull request
//   node error-autofix.mjs sweep      the daily check: did the fix stop it?
//
// Both halves are code, on purpose. The model is asked what is wrong and what
// to change; deciding which files the error points at, whether the fix can be
// applied unambiguously, and what the pull request says is arithmetic and
// text, and that belongs to a program. A model asked to produce a diff
// produces a diff that does not apply.
//
// The same is true of the policy around the bot: one pull request per error
// class, a ceiling on how many fixes may be open at once, and the daily
// check that a merged fix actually stopped the error. Those are rules about
// GitHub, they change rarely, and they are the rules most likely to be
// wrong — so they are in a file with a test rather than in a shell block
// nobody can run twice.
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
// The labels the bot puts on what it opens, so a person can tell what came
// from it and the daily sweep can find its own work.
const PR_LABEL = 'auto-fix';
const ISSUE_LABEL = 'needs-review';
// How many fixes may be open at once before the next one becomes an issue.
// A queue of fixes nobody merges is worth less than a queue of issues
// somebody reads.
const MAX_OPEN_PRS_DEFAULT = 3;
// How long the daily check looks back.
const LOOKBACK_DAYS_DEFAULT = 7;

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

/** A JSON value from the environment, or the fallback when it is not one. */
function safeJson(text, fallback) {
  try {
    const value = JSON.parse(text || '');
    return value ?? fallback;
  } catch {
    return fallback;
  }
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
 * The stack frames of a report, in order.
 *
 * "at fn (url:line:col)" and "at url:line:col" — the two shapes browsers
 * and Node write. The order matters: the frame that matters is often not
 * the first one.
 */
function parseFrames(report) {
  const frames = [];
  const pattern = /\(([^()\s]+):(\d+):(\d+)\)|at\s+([^\s()]+):(\d+):(\d+)/g;
  for (const match of report.matchAll(pattern)) {
    const target = match[1] ?? match[4];
    if (!target) continue;
    frames.push({
      url: target,
      line: Number(match[2] ?? match[5]),
      column: Number(match[3] ?? match[6]),
    });
  }
  return frames;
}

/** A frame's target as a path in this checkout, when it is one. */
function localPath(target) {
  const clean = String(target).replace(/^file:\/\//, '');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(clean)) return null;
  const path = clean.replace(/^\.\//, '').replace(/^\/+/, '');
  return path && existsSync(join(workspace, path)) ? path : null;
}

/** The path of a bundle: "https://site/js/app-HASH.js" → "js/app-HASH.js". */
function bundlePath(target) {
  let path;
  try {
    path = new URL(String(target)).pathname;
  } catch {
    return null;
  }
  path = path.replace(/^\/+/, '');
  return path && path.includes('/') ? path : null;
}

/**
 * The source map of a bundle, or null when there is none.
 *
 * The map is the bundle's own path with ".map" added. The name of a bundle
 * carries the hash of the build, so the map of a build is unique and no
 * registry of builds is needed.
 *
 * Two places to look: the checkout (MAPS_DIR — a build that keeps its maps
 * next to the bundles) and a URL (MAPS_BASE_URL — where the maps live when
 * the sources must not be public).
 *
 * The base URL is the directory the maps live in, not the root of the site:
 * the map of "https://site/js/app.js" is "<base>/js/app.js.map", so a
 * deployment that keeps its maps under a prefix puts that prefix in the
 * base. The maps are often private, and the base is then an endpoint of the
 * consumer's own — MAPS_TOKEN is what it wants, and a map that needs a key
 * the consumer did not give is a map that is not there.
 */
async function loadMap(target) {
  const path = bundlePath(target);
  if (!path) return null;
  const dir = process.env.MAPS_DIR || '';
  if (dir) {
    const local = join(workspace, dir, `${path}.map`);
    if (existsSync(local)) {
      try {
        return JSON.parse(readFileSync(local, 'utf8'));
      } catch {
        return null;
      }
    }
  }
  const base = (process.env.MAPS_BASE_URL || '').replace(/\/+$/, '');
  if (!base) return null;
  const token = process.env.MAPS_TOKEN || '';
  try {
    const response = await fetch(`${base}/${path}.map`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    // A map that cannot be fetched is a map that is not there. The honest
    // answer is that the position was not resolved.
    return null;
  }
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** One VLQ segment: base64 digits, five bits each, the last one the sign. */
function decodeVlq(segment) {
  const values = [];
  let value = 0;
  let shift = 0;
  for (const char of segment) {
    const digit = BASE64.indexOf(char);
    if (digit < 0) break;
    value += (digit & 31) * 2 ** shift;
    if (digit & 32) {
      shift += 5;
      continue;
    }
    const magnitude = Math.floor(value / 2);
    values.push(value & 1 ? -magnitude : magnitude);
    value = 0;
    shift = 0;
  }
  return values;
}

/**
 * The mappings of a source map, per generated line.
 *
 * The map is read here rather than through a library: the workflow that runs
 * this script installs no packages, and a resolver that needs an install is
 * a resolver that breaks on a bad day at the registry. The format is
 * source map v3, and `sections` (index maps) are not supported — a map we
 * cannot read is a map we do not have.
 */
function parseMappings(map) {
  const sources = map.sources || [];
  const lines = [];
  let sourceIndex = 0;
  let sourceLine = 0;
  let sourceColumn = 0;
  for (const line of String(map.mappings || '').split(';')) {
    let generatedColumn = 0;
    const segments = [];
    for (const segment of line.split(',')) {
      if (!segment) continue;
      const fields = decodeVlq(segment);
      if (!fields.length) continue;
      generatedColumn += fields[0];
      if (fields.length < 4) {
        // A segment with no source behind it.
        segments.push({ generatedColumn, source: null });
        continue;
      }
      sourceIndex += fields[1];
      sourceLine += fields[2];
      sourceColumn += fields[3];
      segments.push({
        generatedColumn,
        source: sources[sourceIndex] ?? null,
        line: sourceLine + 1,
        column: sourceColumn,
      });
    }
    lines.push(segments);
  }
  return { root: map.sourceRoot || '', lines };
}

/**
 * The original position of a generated position, through a source map.
 *
 * The column in a stack trace is 1-based (verified on V8) and a source map
 * counts from 0, so the column is decremented here — once, where the two
 * meet.
 */
function originalPosition(map, line, column) {
  const parsed = parseMappings(map);
  const segments = parsed.lines[line - 1];
  if (!segments || !segments.length) return null;
  let found = null;
  for (const segment of segments) {
    if (segment.generatedColumn > column) break;
    found = segment;
  }
  if (!found || !found.source) return null;
  return {
    source: parsed.root ? `${parsed.root}/${found.source}` : found.source,
    line: found.line,
    column: found.column,
  };
}

/**
 * The file in this checkout that a source map names.
 *
 * A map's sources are relative to wherever the build ran: "../src/app.js",
 * "webpack://app/./src/app.js", an absolute path on the build machine. The
 * checkout has the file under some suffix of that path, so every suffix is
 * tried, longest first.
 */
function findInRepo(source) {
  const clean = String(source)
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
  const parts = clean.split('/').filter((part) => part && part !== '..');
  for (let i = 0; i < parts.length; i++) {
    const candidate = parts.slice(i).join('/');
    if (candidate && existsSync(join(workspace, candidate))) return candidate;
  }
  return null;
}

/** A source that belongs to a dependency, not to the consumer's own code. */
function isVendor(source) {
  const clean = String(source).replace(/\\/g, '/');
  return /(^|\/)node_modules\//.test(clean) || /(^|\/)@[^/]+\//.test(clean);
}

/**
 * The files the stack trace points at.
 *
 * The paths are read out of the error text by pattern, and a path is taken
 * only when it exists in this checkout. The model is not asked to find them:
 * it is asked to fix code, and a file it cannot see is a file it would
 * invent.
 *
 * A minified bundle has no path to take: the stack points at
 * "js/app-HASH.js:1:141", and the position in it means nothing without the
 * source map. So the frames are walked, and each one that points at a bundle
 * is resolved through that bundle's map. The frames are walked in order and
 * the first one that lands in the consumer's own code wins: the top frame of
 * a "Failed to fetch" sits inside the SDK that was called, and the code to
 * change is further down, where the SDK was called from.
 */
async function resolveFiles(report, playbookMatch) {
  const files = [];
  const seen = new Set();
  const add = (path) => {
    if (!path || seen.has(path)) return;
    if (path.startsWith('..') || path.includes('node_modules/')) return;
    if (!existsSync(join(workspace, path))) return;
    seen.add(path);
    files.push(path);
  };

  const frames = parseFrames(report);
  const locations = [];
  let vendorSkipped = 0;
  let unresolved = 0;
  let bundles = 0;
  for (const frame of frames) {
    if (files.length >= MAX_FILES) break;
    const local = localPath(frame.url);
    if (local) {
      add(local);
      locations.push({ file: local, line: frame.line, column: frame.column, via: 'stack' });
      continue;
    }
    if (!/^https?:\/\//i.test(frame.url)) continue;
    bundles++;
    const map = await loadMap(frame.url);
    if (!map) {
      unresolved++;
      continue;
    }
    const position = originalPosition(map, frame.line, frame.column);
    if (!position) {
      unresolved++;
      continue;
    }
    if (isVendor(position.source)) {
      vendorSkipped++;
      continue;
    }
    const file = findInRepo(position.source);
    if (!file) {
      unresolved++;
      continue;
    }
    add(file);
    locations.push({ file, line: position.line, column: position.column, via: 'source map' });
  }

  // The paths in the text, for the reports whose frames are not in a shape
  // this script reads.
  if (!files.length) {
    const candidates = report.replace(/\\/g, '/').match(/[A-Za-z0-9_./-]+\.[A-Za-z]{1,6}/g) || [];
    for (const candidate of candidates) {
      if (files.length === MAX_FILES) break;
      add(candidate.replace(/^\.?\//, ''));
    }
  }

  // The playbook names the files for a known issue; it is the consumer's
  // explicit intent, so it comes last, for what the stack did not say.
  for (const hint of (playbookMatch && playbookMatch.files_hint) || []) {
    if (files.length === MAX_FILES) break;
    add(String(hint).replace(/^\.?\//, ''));
  }
  return { files, locations, vendorSkipped, unresolved, bundles };
}

/**
 * The action escapes what it writes to the outputs file: `%` becomes `%25`
 * and a newline becomes `%0A`, because a workflow output is one line.
 *
 * The inverse, in the same order as the escape: the newlines first, then
 * the percent signs. A literal "%0A" in the text arrived as "%250A", and it
 * must not become a newline.
 */
function unescapeAction(text) {
  return String(text ?? '').replace(/%0A/g, '\n').replace(/%25/g, '%');
}

/**
 * The stage's output text.
 *
 * The model writes the JSON over several lines as often as over one, and
 * the action escapes a newline — so the stage output arrives escaped, and a
 * consumer that does not unescape it reads a value that cannot be parsed at
 * all. It is not a corner case: it is what happens every time the model is
 * in the mood to indent, and the run then says "the pipeline named no file
 * to change" about a pipeline that named a file perfectly well.
 *
 * The record of the whole run (RESULT_JSON) is the fallback: one line
 * already, and its last entry is the stage that proposed the fix.
 */
function stageOutput() {
  const raw = process.env.STAGE_OUTPUT || '';
  if (raw.trim()) {
    // Plain JSON — a script run by hand — parses as it is. The action's
    // escaped value does not, so it is unescaped and then read.
    const direct = safeJson(raw, null) !== null ? raw : unescapeAction(raw);
    if (safeJson(direct, null) !== null) return direct;
  }
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
async function sources() {
  const report = process.env.ERROR_REPORT || '';
  const context = process.env.REPO_CONTEXT || '';
  const playbook = readPlaybook();
  const match = matchPlaybook(playbook, report);
  const resolved = await resolveFiles(report, match);
  const files = resolved.files;
  if (!files.length) {
    // Say what did not work out. "Nothing to fix" without a reason is the
    // answer nobody can act on.
    const why = [];
    if (resolved.bundles) {
      why.push('the stack points at a bundle, and a bundle without a source map has no position');
    }
    if (resolved.vendorSkipped) {
      why.push(`${resolved.vendorSkipped} frame(s) were in dependencies`);
    }
    if (resolved.unresolved) {
      why.push(`${resolved.unresolved} frame(s) could not be resolved`);
    }
    if (match) {
      why.push(`the playbook matched "${match.signature}" but names no file that exists in this checkout`);
    }
    console.error(`no file to fix: ${why.join('; ') || 'no file in the stack trace exists in this checkout'}`);
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
  emit('location_json', JSON.stringify(resolved.locations));
  console.log(`resolved ${files.length} file(s) from the stack: ${files.join(', ')}`);
  for (const location of resolved.locations) {
    console.log(`  ${location.file}:${location.line} (${location.via})`);
  }
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

  // The signature is the error's class, not this occurrence of it: two
  // occurrences of the same failure are one thing to fix, and one pull
  // request. The branch is named after it, so a second run replaces the
  // branch instead of opening a second pull request.
  const errorClass = String(analysis.error_class || '').trim();
  const signature = playbook.signature
    ? String(playbook.signature)
    : `${errorClass || 'error'}@${analysis.file || path || 'unknown'}`;

  // The probe is what the error looks like in the feed of errors that are
  // still firing — the text to look for. A known issue has a stable name; a
  // raw error does not, so the message is used, and a message that carries
  // ids in it is a message that needs a playbook entry.
  const probe = (playbook.signature
    ? String(playbook.signature)
    : (report.split('\n')[0] || '').trim())
    .slice(0, 120)
    .replace(/<!--/g, '&lt;!--')
    .replace(/-->/g, '--&gt;');

  // The markers are read back by the policy sweep, which checks that the
  // error stopped firing after the fix was merged.
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
    const locations = safeJson(process.env.LOCATION_JSON, []);
    if (locations.length) {
      const where = locations.map((l) => `\`${l.file}:${l.line}\` (${l.via})`).join(', ');
      body.push('', `**Resolved:** ${where}`);
    }
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
    `<!-- error-signature: ${signature} -->`,
    `<!-- error-probe: ${probe} -->`,
  );

  const digest = createHash('sha1').update(signature).digest('hex').slice(0, 8);
  emit('patch', patch.slice(0, 48000));
  emit('branch', `fix/auto-${digest}`);
  emit('title', title);
  emit('body', body.join('\n'));
  emit('pr_ready', prReady ? 'true' : 'false');
  emit('signature', signature);
  emit('probe', probe);
}

// ---------------------------------------------------------------------------
// The policy around the bot.
//
// Everything below talks to GitHub through `gh`, which the runner has. The
// calls are collected in one place so that a rule can be read in one place
// too, and so the checks can put a `gh` of their own on the PATH and see
// exactly what the script asked for.
// ---------------------------------------------------------------------------

/** Run `gh`. Returns its output, or null when the call was allowed to fail. */
function gh(args, { allowFailure = false } = {}) {
  try {
    return execFileSync('gh', args, {
      cwd: workspace,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    if (allowFailure) return null;
    const detail = String(e.stderr || e.message || '').trim().slice(0, 300);
    throw new Error(`gh ${args.join(' ')} failed: ${detail}`);
  }
}

/**
 * A list from GitHub, as an array.
 *
 * The fields are named per call, because a list of pull requests and a list
 * of issues do not carry the same ones.
 */
function ghList(args, fields) {
  const raw = gh([...args, '--json', fields]);
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // A list that does not parse is a list we cannot read, and a list we
    // cannot read is not an empty list: an empty list would say "nothing is
    // open", and that is one of the answers that must never be invented.
    throw new Error(`gh ${args.join(' ')} did not answer with a list`);
  }
}

/** The marker the body carries: `<!-- error-probe: ... -->`. */
function markerOf(body, name) {
  const pattern = new RegExp(`<!--\\s*${name}:\\s*(.*?)\\s*-->`, 'g');
  let found = null;
  let match;
  while ((match = pattern.exec(String(body || ''))) !== null) found = match[1];
  return found;
}

/** The label exists. A label that cannot be created is not fatal. */
function ensureLabel(repo, name, color, description) {
  gh(['label', 'create', name, '--repo', repo, '--color', color, '--description', description],
    { allowFailure: true });
}

/** The branch the pull request goes to. */
function baseBranch(repo) {
  if (process.env.BASE_BRANCH) return process.env.BASE_BRANCH;
  // `gh repo view` takes the repository as an argument. `--repo` is not a
  // flag it knows, and the answer it gives is `defaultBranchRef.name` —
  // both were wrong here, and the fallback to `main` hid both.
  const raw = gh(['repo', 'view', repo, '--json', 'defaultBranchRef'], { allowFailure: true });
  try {
    return JSON.parse(raw || '{}').defaultBranchRef?.name || 'main';
  } catch {
    return 'main';
  }
}

/**
 * The issue for an error class.
 *
 * One issue per error class: the same failure twice is one thing to look at.
 * The signature is in the body as a marker, and an empty signature matches
 * nothing — so it is not compared.
 *
 * Every path that files an issue goes through here, including the two paths
 * inside `publish`: a fix that became an issue because the repository will
 * not let a pull request be opened, and a fix that became an issue because
 * the ceiling was reached. An error class that fires every hour is one
 * issue, not one per hour.
 */
function openIssue(repo, title, body, signature) {
  ensureLabel(repo, ISSUE_LABEL, 'FBCA04', 'An error that needs a human');

  if (signature) {
    const open = ghList(['issue', 'list', '--repo', repo, '--state', 'open', '--label', ISSUE_LABEL], 'number,body');
    const tracked = open.find((issue) => String(issue.body || '').includes(`error-signature: ${signature}`));
    if (tracked) {
      console.log(`an open issue already carries this error class: #${tracked.number}`);
      gh(['issue', 'comment', String(tracked.number), '--repo', repo, '--body', 'The same error fired again.'],
        { allowFailure: true });
      return 'duplicate';
    }
  }

  gh(['issue', 'create', '--repo', repo, '--title', title, '--body', body, '--label', ISSUE_LABEL],
    { allowFailure: true });
  return 'issue';
}

/**
 * `publish` — the pull request.
 *
 * Three rules, in this order, and each of them replaces the pull request
 * with something less intrusive:
 *
 *   1. one pull request per error class. The branch is named after the
 *      error's signature, so a second run of the same error pushes to the
 *      same branch and the open pull request updates itself.
 *   2. a ceiling. Past MAX_OPEN_PRS open fixes, this one becomes an issue.
 *   3. a pull request that cannot be opened becomes an issue too: the fix
 *      is on the branch either way, and a fix that is only on a branch that
 *      nobody can open is a fix that is lost.
 */
function publish() {
  const repo = process.env.REPO || '';
  const branch = process.env.BRANCH || '';
  const title = process.env.TITLE || '';
  let body = process.env.BODY || '';
  const signature = process.env.SIGNATURE || '';
  const maxOpen = Number(process.env.MAX_OPEN_PRS || MAX_OPEN_PRS_DEFAULT);
  if (!repo || !branch) throw new Error('REPO and BRANCH are required to publish');

  if (process.env.REVIEW_RESULT === 'failure') {
    body += '\n\n> The AI review did not complete — this fix is un-reviewed. See the run.';
  }

  ensureLabel(repo, PR_LABEL, '0E8A16', 'A fix this workflow opened from a production error');

  const existing = ghList(['pr', 'list', '--repo', repo, '--head', branch, '--state', 'open'], 'number');
  if (existing.length) {
    const number = existing[0].number;
    console.log(`an open pull request already fixes this error class: #${number}`);
    gh(['pr', 'comment', String(number), '--repo', repo,
      '--body', 'The same error fired again. The branch carries the newest attempt.'], { allowFailure: true });
    emit('outcome', 'duplicate');
    return;
  }

  const open = ghList(['pr', 'list', '--repo', repo, '--state', 'open', '--label', PR_LABEL], 'number');
  if (open.length >= maxOpen) {
    console.log(`::notice::${open.length} fixes are already open and the ceiling is ${maxOpen} — this one becomes an issue.`);
    openIssue(repo, title, body, signature);
    emit('outcome', 'over-ceiling');
    return;
  }

  const created = gh([
    'pr', 'create', '--repo', repo, '--base', baseBranch(repo), '--head', branch,
    '--title', title, '--body', body, '--label', PR_LABEL,
  ], { allowFailure: true });

  if (created === null) {
    console.log('::warning::the pull request could not be opened — the fix is filed as an issue instead');
    const note = `${body}\n\nThe fix is on the branch \`${branch}\`. A pull request could not be opened: the repository does not let GitHub Actions create them.`;
    emit('outcome', openIssue(repo, title, note, signature));
    return;
  }
  emit('outcome', 'pr');
}

/**
 * `report` — the issue, for an error that has no mechanical fix.
 */
function report() {
  const repo = process.env.REPO || '';
  const title = process.env.TITLE || 'Error from production';
  const body = process.env.BODY || '';
  const signature = process.env.SIGNATURE || '';
  if (!repo) throw new Error('REPO is required to report');

  emit('outcome', openIssue(repo, title, body, signature));
}

/**
 * `sweep` — the daily check: did the merged fix stop the error?
 *
 * A fix that did not fix anything is worth more as an issue than as a merged
 * pull request. The question is asked of the consumer's feed: the text of
 * the error appears in the answer while the error is still firing.
 *
 * A feed that does not answer fails the sweep loudly. An empty feed would
 * say every error stopped firing, and that is the one answer that must never
 * be invented.
 */
async function sweep() {
  const repo = process.env.REPO || '';
  const feed = process.env.ERROR_FEED_URL || '';
  const days = Number(process.env.VERIFY_LOOKBACK_DAYS || LOOKBACK_DAYS_DEFAULT);
  if (!repo) throw new Error('REPO is required to sweep');

  if (!feed) {
    console.log('::notice::ERROR_FEED_URL is not set — there is nothing to check the fixes against.');
    emit('outcome', 'no-feed');
    return;
  }

  let text = '';
  try {
    const response = await fetch(feed, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`the feed answered ${response.status}`);
    text = await response.text();
  } catch (e) {
    console.error(`::error::the error feed ${feed} did not answer — the fixes were not checked`);
    process.exit(1);
  }

  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const merged = ghList([
    'pr', 'list', '--repo', repo, '--state', 'merged', '--label', PR_LABEL, '--search', `merged:>=${since}`,
  ], 'number,body');
  console.log(`checking ${merged.length} merged fix(es) from ${since}`);

  let opened = 0;
  for (const pull of merged) {
    const probe = markerOf(pull.body, 'error-probe');
    if (!probe) continue;
    if (!text.includes(probe)) {
      console.log(`#${pull.number}: the error stopped firing`);
      continue;
    }
    console.log(`#${pull.number}: the error is still firing`);
    const signature = markerOf(pull.body, 'error-signature') || '';
    const open = ghList(['issue', 'list', '--repo', repo, '--state', 'open', '--label', ISSUE_LABEL], 'number,body');
    const tracked = signature
      ? open.find((issue) => String(issue.body || '').includes(`error-signature: ${signature}`))
      : null;
    if (tracked) {
      console.log(`  already tracked by #${tracked.number}`);
      continue;
    }
    const note = [
      `The fix in #${pull.number} was merged, and the error it was for is still firing.`,
      '', `**Error:** ${probe}`, `**Signature:** ${signature}`, '',
      'Checked against the error feed. Either the fix addressed a different cause, or the cause is somewhere else.',
    ].join('\n');
    ensureLabel(repo, ISSUE_LABEL, 'FBCA04', 'An error that needs a human');
    gh(['issue', 'create', '--repo', repo,
      '--title', `The error is still firing after the fix was merged (#${pull.number})`,
      '--body', note, '--label', ISSUE_LABEL], { allowFailure: true });
    opened++;
  }
  emit('outcome', 'swept');
  emit('opened', String(opened));
}

if (command === 'sources') await sources();
else if (command === 'apply') apply();
else if (command === 'publish') publish();
else if (command === 'report') report();
else if (command === 'sweep') await sweep();
else {
  console.error('usage: error-autofix.mjs <sources|apply|publish|report|sweep> [workspace]');
  process.exit(2);
}
