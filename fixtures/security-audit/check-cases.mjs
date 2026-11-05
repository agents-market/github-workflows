#!/usr/bin/env node
// What the case corpus of the security audit must be, checked against the
// corpus itself.
//
//   node fixtures/security-audit/check-cases.mjs
//
// A corpus that does not hold together measures nothing, and it fails quietly:
//
// - a case with no expectation is never checked;
// - an expectation for a case that does not exist is never checked either;
// - a hunk header that does not match its body makes the model read the wrong
//   line, and the measurement then measures a mapping, not an audit;
// - a case longer than the spec's `code_diff` limit cannot be run at all —
//   the runtime refuses the input, and the case is simply absent from the
//   results.
//
// So this reads the corpus and the spec and says what is wrong. It is a shape
// check, not a behaviour check: it cannot prove the audit finds the weakness
// the case contains. `run-cases.mjs` and `summarize.py` do that.
//
// It prints the number of files it read: a silent scanner is worse than a
// scanner that found nothing.

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let YAML;
try {
  YAML = (await import('yaml')).default;
} catch (e) {
  console.error('the yaml package is not installed — npm install --no-save yaml');
  console.error(String(e.message || e));
  process.exit(1);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const CASES = join(HERE, 'cases');

let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    console.log(`ok   ${name}`);
  } else {
    failures++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

/** The hunks of a unified diff, with the new-file lines they add. */
function parseDiff(text) {
  const files = new Map();
  const lines = text.split('\n');
  let file = null;
  let newLine = 0;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith('diff --git ')) {
      file = l.split(' b/').pop();
      files.set(file, { newLines: new Map(), hunks: [] });
      i++;
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (hunk && file) {
      const [, oldStart, oldLen, newStart, newLen] = hunk;
      const body = [];
      let j = i + 1;
      while (j < lines.length) {
        const b = lines[j];
        if (b.startsWith('@@') || b.startsWith('diff --git ')) break;
        if (b === '' && j === lines.length - 1) break;
        if (b.startsWith('\\')) { j++; continue; }
        body.push(b);
        j++;
      }
      const counted = {
        old: body.filter((b) => b.startsWith(' ') || b.startsWith('-')).length,
        new: body.filter((b) => b.startsWith(' ') || b.startsWith('+')).length,
      };
      const stated = {
        old: oldLen === undefined ? 1 : Number(oldLen),
        new: newLen === undefined ? 1 : Number(newLen),
      };
      files.get(file).hunks.push({
        oldStart: Number(oldStart),
        newStart: Number(newStart),
        stated,
        counted,
        body,
      });
      // The new-file line numbers of the added and context lines.
      let n = Number(newStart);
      for (const b of body) {
        if (b.startsWith('+') || b.startsWith(' ')) {
          files.get(file).newLines.set(n, b.slice(1));
          n++;
        }
      }
      i = j;
      continue;
    }
    i++;
  }
  return files;
}

const expected = JSON.parse(readFileSync(join(CASES, 'expected.json'), 'utf8')).cases || {};
const diffFiles = readdirSync(CASES).filter((f) => f.endsWith('.diff')).sort();
console.log(`files read: ${diffFiles.length} cases, ${Object.keys(expected).length} expectations`);

check('every case has an expectation', diffFiles.every((f) => f.replace(/\.diff$/, '') in expected),
  diffFiles.filter((f) => !(f.replace(/\.diff$/, '') in expected)).join(', '));
check('every expectation has a case',
  Object.keys(expected).every((id) => diffFiles.includes(`${id}.diff`)),
  Object.keys(expected).filter((id) => !diffFiles.includes(`${id}.diff`)).join(', '));

// The spec says how long a diff may be. A case longer than that cannot be
// run, so it is not a case — it is a file in the folder.
const specPath = join(REPO, 'pipelines', 'code-review-security-audit', 'pipeline.yaml');
const spec = YAML.parse(readFileSync(specPath, 'utf8'));
const limit = spec?.inputs?.code_diff?.max_length;
check('the spec declares how long a diff may be', typeof limit === 'number', String(limit));

for (const file of diffFiles) {
  const id = file.replace(/\.diff$/, '');
  const text = readFileSync(join(CASES, file), 'utf8');
  const files = parseDiff(text);

  check(`${id}: the diff is within the spec's limit`,
    typeof limit !== 'number' || text.length <= limit,
    `${text.length} chars, limit ${limit}`);
  check(`${id}: the diff has hunks`, files.size > 0);

  for (const [name, f] of files) {
    for (const h of f.hunks) {
      check(`${id}: ${name} hunk @${h.newStart} counts its body`,
        h.stated.old === h.counted.old && h.stated.new === h.counted.new,
        `header says ${h.stated.old}/${h.stated.new}, body has ${h.counted.old}/${h.counted.new}`);
    }
  }

  const case_ = expected[id] || {};
  const want = case_.expect?.file;
  if (want) {
    check(`${id}: the expected file is in the diff`, files.has(want),
      `${want}; the diff has ${[...files.keys()].join(', ')}`);
    const f = files.get(want);
    if (f) {
      const last = Math.max(...f.newLines.keys());
      for (const [lo, hi] of case_.expect?.lines || []) {
        check(`${id}: the lines of the expected weakness are in the file`,
          lo >= 1 && hi <= last && lo <= hi, `${lo}-${hi}, the file has ${last} lines`);
      }
    }
  }

  for (const rule of case_.must_not_report || []) {
    if (!rule.file) continue;
    const f = files.get(rule.file);
    if (!f) {
      check(`${id}: the file of a must-not rule is in the diff`, false, rule.file);
      continue;
    }
    const last = Math.max(...f.newLines.keys());
    for (const [lo, hi] of rule.lines || []) {
      check(`${id}: the lines of a must-not rule are in the file`,
        lo >= 1 && hi <= last && lo <= hi, `${lo}-${hi}, the file has ${last} lines`);
    }
  }
}

console.log(failures ? `\n${failures} checks failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
