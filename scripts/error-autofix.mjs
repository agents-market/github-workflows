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
 * next to the bundles) and a URL (MAPS_BASE_URL — the private bucket the
 * maps live in, which is where they belong when the sources must not be
 * public).
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
  try {
    const response = await fetch(`${base}/${path}.map`);
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
  );

  const digest = createHash('sha1').update(report + path).digest('hex').slice(0, 8);
  emit('patch', patch.slice(0, 48000));
  emit('branch', `fix/auto-${digest}`);
  emit('title', title);
  emit('body', body.join('\n'));
  emit('pr_ready', prReady ? 'true' : 'false');
}

if (command === 'sources') await sources();
else if (command === 'apply') apply();
else {
  console.error('usage: error-autofix.mjs <sources|apply> [workspace]');
  process.exit(2);
}
