#!/usr/bin/env node
// A check on the GitLab review's reader-visible parts: what one weakness
// becomes in the note, and what two names for one weakness become.
//
// The pipeline is not run here — it needs a key and it changes every day.
// What is checked is the part that silently rots: the merging of findings
// into lines, and the rendering of those lines into the note a developer
// reads.
//
//   node scripts/check-gitlab-review.mjs

import { findingsOf, noteFor } from './gitlab-review.mjs';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    console.log(`ok   ${name}`);
  } else {
    failures++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

const outputs = {
  deep_review: JSON.stringify({
    findings: [
      // The same weakness, twice, at two severities.
      { severity: 'high', file: 'src/api/orders.ts', line: 12, cwe_id: 'CWE-89', description: 'SQL injection', fix_suggestion: 'Use parameters' },
      { severity: 'low', file: 'src/api/orders.ts', line: 12, cwe_id: 'CWE-89', description: 'SQL injection', fix_suggestion: 'Use parameters' },
      // Two catalogue ids that name one weakness.
      { severity: 'medium', file: 'src/api/orders.ts', line: 40, cwe_id: 'CWE-330', description: 'Predictable randomness' },
      { severity: 'medium', file: 'src/api/orders.ts', line: 40, cwe_id: 'CWE-338', description: 'Predictable randomness' },
    ],
  }),
  gap_review: JSON.stringify({
    findings: [
      { severity: 'critical', file: 'src/api/orders.ts', line: 7, cwe_id: 'CWE-798', description: 'Hard-coded credentials' },
    ],
  }),
};

const findings = findingsOf(outputs);

// Five mentions, three weaknesses: the same weakness at two severities is one
// weakness, and two ids that name one weakness are one weakness.
check('three weaknesses out of five mentions', findings.length === 3, `got ${findings.length}`);

const note = noteFor('code-review-security-audit', 'security audit', findings, 0.0123456, 51230);

check('the note carries the marker', note.includes('<!-- am:code-review-security-audit -->'));
check('the note names the file and the line', note.includes('`src/api/orders.ts:12`'));
check('the note names the CWE', note.includes('`CWE-89`'));
check('the note carries the most serious reading of the weakness',
  note.includes('**HIGH**') && !note.includes('**LOW**'));
check('the note carries the fix', note.includes('💡 Use parameters'));
check('two ids of one weakness are one line',
  (note.match(/`src\/api\/orders\.ts:40`/g) || []).length === 1);
check('the counts are the counts of the findings',
  note.includes('| Findings | 3 (critical 1 · high 1 · medium 1 · low 0) |'),
  note.split('\n').find((l) => l.includes('| Findings |')));
check('the cost is labelled as an estimate', note.includes('nothing was charged'));

const empty = noteFor('style-review', 'style review', [], 0, 100);
check('an empty review says so', empty.includes('_No findings._'));

console.log(failures ? `\n${failures} checks failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
