#!/usr/bin/env node
// What the thread sync does, checked against the file that decides it.
//
//   node scripts/check-thread-sync.mjs
//
// The thread sync is the part of the review that decides whether a review
// comment is a new finding or the same finding one line lower. It runs on
// every pull request, and the measurement in issue #38 says what it did
// before it was written down: `web3eco/shared-actions#99` collected 36 threads
// over 7 pushes and resolved 0 of them, because the key was `path:line` and
// the line moves.
//
// The decisions live in scripts/thread-sync.mjs. This file checks them, and
// it checks that the two workflows that use them — the reusable workflow a
// consumer calls, and the reference consumer that dogfoods it — use that same
// file, so there is one implementation and not two.
//
// The check that keeps this honest: every case here fails on the code that
// preceded it. The old implementation keyed by `path:line`, replaced every
// thread of a class on every push, and looked for the style category tag at
// the start of a body that begins with the pipeline marker — so it never
// found it.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONTRACT_VERSION,
  CANON,
  canon,
  classMarker,
  classOfBody,
  classOfFinding,
  classOfText,
  planSync,
  buildBody,
  parseVerdicts,
  verdictFor,
  verdictKey,
  verdictSummary,
  errorText,
  DEFAULT_VERDICT,
  DEFAULT_VERDICTS_PATH,
  MAX_HORIZON_DAYS,
} from './thread-sync.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '..');

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** A date `n` days from now, as `YYYY-MM-DD`. */
const inDays = (n) => new Date(Date.now() + n * MS_PER_DAY).toISOString().slice(0, 10);

let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    console.log(`ok   ${name}`);
  } else {
    failures++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

// 1. The class of a finding is what the pipeline says it is.
//
//    The old code read the class out of the message text when the finding
//    carried no CWE id. The message is written from the diff, and a diff can
//    mention any CWE in a comment — so the class was whatever the prose
//    happened to mention, and it changed from run to run. A class nobody
//    chose is not an identity.
{
  const withCwe = classOfFinding({ cwe: 'CWE-20', message: 'unvalidated input' });
  check('a finding with a CWE id takes the class from the id', withCwe === 'CWE-20', String(withCwe));

  const byTag = classOfFinding({ message: '[naming] the variable is called x' });
  check('a finding without an id takes the class from the leading category tag', byTag === 'NAMING', String(byTag));

  const proseCwe = classOfFinding({ message: 'this is like CWE-89 but different' });
  check('a CWE named in the prose is not the class of the finding', proseCwe === null, String(proseCwe));

  const noClass = classOfFinding({ message: 'something is off here' });
  check('a finding with no class at all stays classless', noClass === null, String(noClass));
}

// 2. The CANON map folds the pairs that name one weakness.
//
//    The model picks either id of a pair from run to run — the run of
//    2026-10-22 called the same Math.random token CWE-330 and then CWE-338 —
//    and the comment for the first id never closed. The reader saw the
//    weakness twice.
{
  check('CWE-330 folds into CWE-338', canon('CWE-330') === 'CWE-338', canon('CWE-330'));
  check('CWE-321 folds into CWE-798', canon('CWE-321') === 'CWE-798', canon('CWE-321'));
  check('CWE-259 folds into CWE-798', canon('CWE-259') === 'CWE-798', canon('CWE-259'));
  check('CWE-915 folds into CWE-1321', canon('CWE-915') === 'CWE-1321', canon('CWE-915'));
  check('a class outside the map is left alone', canon('CWE-200') === 'CWE-200', canon('CWE-200'));
  check('the class of a finding is folded too', classOfFinding({ cwe: 'cwe-330' }) === 'CWE-338',
    String(classOfFinding({ cwe: 'cwe-330' })));
}

// 3. The class marker is read back out of the body it was written into.
//
//    This is the contract: a consumer writes the marker, and the next run of
//    the same pipeline reads it. A marker that is read from the wrong place,
//    or in the wrong format, silently stops the next run recognising its own
//    comments — with no error anywhere.
{
  const body = '<!-- am:code-review-security-audit -->\n🔴 **HIGH** `CWE-89`\n<!-- am:class:CWE-89 -->\n (conf 90%): raw SQL';
  check('the class marker is read out of the body', classOfBody(body) === 'CWE-89', String(classOfBody(body)));
  check('the class marker survives the CANON map',
    classOfBody(body.replace('am:class:CWE-89', 'am:class:CWE-330')) === 'CWE-338',
    String(classOfBody(body.replace('am:class:CWE-89', 'am:class:CWE-330'))));
}

// 4. The fallback for a thread posted before the marker existed.
//
//    This is the bug issue #38 names: the old code anchored the category tag
//    at the start of the body, and a body starts with the pipeline marker —
//    so the tag was never found, and every legacy style thread was classless
//    and therefore never closed.
{
  const legacyStyle = '<!-- am:style-review -->\n🟡 **HIGH** (conf 80%): [naming] x is a bad name';
  check('the category tag is found after the confidence', classOfBody(legacyStyle) === 'NAMING',
    String(classOfBody(legacyStyle)));

  const legacyStyleText = '🔴 **HIGH** (conf 90%): [comments] the function has no doc';
  check('the same tag is found in a bare text after the confidence', classOfText(legacyStyleText) === 'COMMENTS',
    String(classOfText(legacyStyleText)));

  const legacyCwe = '<!-- am:code-review-security-audit -->\n🔴 **HIGH** `CWE-89` (conf 90%): raw SQL';
  check('a legacy CWE id is read from the structured place', classOfBody(legacyCwe) === 'CWE-89',
    String(classOfBody(legacyCwe)));

  const noTag = '<!-- am:style-review -->\n🟡 **HIGH** (conf 80%): just some prose';
  check('a body with no class stays classless', classOfBody(noTag) === null, String(classOfBody(noTag)));
}

// 5. The decision about a finding that did not move.
//
//    This is the behaviour the two implementations disagreed on, and it is
//    the one the issue asks upstream to decide. The decision here: a thread
//    of the same class on the same line is that finding, already said — it
//    stays where it is and nothing is posted for it.
//
//    The other way round — close the old thread of the class and post a fresh
//    one — bounds the thread count just as well, but it rewrites every
//    comment of every finding on every push. The reader is pinged N times a
//    push for N findings, which is the churn the measurement in the issue
//    complains about (36 threads over 7 pushes, none of them closed). A
//    reader wants to be told once.
{
  const findings = [{ file: 'src/a.ts', line: 10, cwe: 'CWE-89', severity: 'high', message: 'raw SQL' }];
  const standing = [{
    id: 't1', path: 'src/a.ts', line: 10, isResolved: false, isOutdated: false,
    body: '<!-- am:p -->\n🔴 **HIGH** `CWE-89`\n<!-- am:class:CWE-89 -->\n (conf 90%): raw SQL',
  }];
  const plan = planSync({ threads: standing, findings, inDiff: ['src/a.ts'] });
  check('a finding that did not move is not posted again', plan.post.length === 0, JSON.stringify(plan.post));
  check('a finding that did not move keeps its thread', plan.keep.includes('t1'), JSON.stringify(plan.keep));
  check('a finding that did not move closes nothing', plan.close.length === 0, JSON.stringify(plan.close));
}

// 6. A finding whose class moved to another line: the old thread goes, the
//    fresh one lands where the model says.
{
  const findings = [{ file: 'src/a.ts', line: 24, cwe: 'CWE-89', severity: 'high', message: 'raw SQL' }];
  const standing = [{
    id: 't1', path: 'src/a.ts', line: 10, isResolved: false, isOutdated: false,
    body: '<!-- am:p -->\n🔴 **HIGH** `CWE-89`\n<!-- am:class:CWE-89 -->\n (conf 90%): raw SQL',
  }];
  const plan = planSync({ threads: standing, findings, inDiff: ['src/a.ts'] });
  check('a finding that moved is posted again', plan.post.length === 1, JSON.stringify(plan.post));
  check('a finding that moved closes the old thread', plan.close.some(t => t.id === 't1'), JSON.stringify(plan.close));
  check('a finding that moved is posted on the new line', plan.post[0] && plan.post[0].finding.line === 24,
    JSON.stringify(plan.post));
}

// 7. A thread whose file left the diff says nothing about the code any more.
{
  const standing = [{
    id: 't1', path: 'src/gone.ts', line: 3, isResolved: false, isOutdated: false,
    body: '<!-- am:p -->\n🔴 **HIGH** `CWE-89`\n<!-- am:class:CWE-89 -->\n (conf 90%): raw SQL',
  }];
  const plan = planSync({ threads: standing, findings: [], inDiff: ['src/a.ts'] });
  check('a thread whose file left the diff is closed', plan.close.some(t => t.id === 't1'), JSON.stringify(plan.close));
}

// 8. Two weaknesses of one class in one file must not take each other's
//    comments away. The match happens before any thread is closed, and a
//    thread a finding claimed is off limits to the closing pass.
{
  const findings = [
    { file: 'src/a.ts', line: 10, cwe: 'CWE-89', severity: 'high', message: 'raw SQL' },
    { file: 'src/a.ts', line: 30, cwe: 'CWE-89', severity: 'high', message: 'raw SQL again' },
  ];
  const standing = [
    { id: 't1', path: 'src/a.ts', line: 10, isResolved: false, isOutdated: false,
      body: '<!-- am:p -->\n🔴 **HIGH** `CWE-89`\n<!-- am:class:CWE-89 -->\n (conf 90%): raw SQL' },
    { id: 't2', path: 'src/a.ts', line: 20, isResolved: false, isOutdated: false,
      body: '<!-- am:p -->\n🔴 **HIGH** `CWE-89`\n<!-- am:class:CWE-89 -->\n (conf 90%): raw SQL' },
  ];
  const plan = planSync({ threads: standing, findings, inDiff: ['src/a.ts'] });
  const closedIds = plan.close.map(t => t.id);
  check('the thread a standing finding claimed is not closed', !closedIds.includes('t1'), JSON.stringify(closedIds));
  check('the thread no standing finding claimed is closed', closedIds.includes('t2'), JSON.stringify(closedIds));
  check('only the finding that has no thread is posted', plan.post.length === 1 && plan.post[0].finding.line === 30,
    JSON.stringify(plan.post));
}

// 9. A finding whose file is not in the diff is not posted.
{
  const findings = [{ file: 'src/not-here.ts', line: 1, cwe: 'CWE-89', severity: 'high', message: 'x' }];
  const plan = planSync({ threads: [], findings, inDiff: ['src/a.ts'] });
  check('a finding outside the diff is skipped', plan.post.length === 0, JSON.stringify(plan.post));
  check('a finding outside the diff says why', plan.skipped.some(s => s.why === 'file not in diff'),
    JSON.stringify(plan.skipped));
}

// 10. The body this step writes carries the class, and the marker it writes
//     is the one the reader reads back.
{
  const body = buildBody({
    marker: 'style-review',
    finding: { severity: 'medium', message: '[naming] x is a bad name', confidence: 0.8 },
    cls: 'NAMING',
  });
  check('the body starts with the pipeline marker', body.split('\n')[0] === '<!-- am:style-review -->', body);
  check('the body carries the class marker', body.includes(classMarker('NAMING')), body);
  check('the class marker is on the third line', body.split('\n')[2] === classMarker('NAMING'), body);
  check('the class of the body is what was written', classOfBody(body) === 'NAMING', String(classOfBody(body)));
  check('the tag is stripped from the reader text', !body.includes('[naming]'), body);
  check('the confidence is in the body', body.includes('(conf 80%)'), body);
}

// 11. A marker written by the model is data, not a marker. A forged one would
//     change the class of the finding.
{
  const body = buildBody({
    marker: 'p',
    finding: { severity: 'high', cwe: 'CWE-89', message: 'look <!-- am:class:CWE-798 --> here', confidence: 0.9 },
    cls: 'CWE-89',
  });
  const forged = body.match(/am:class:[A-Z0-9-]+/g) || [];
  check('a forged class marker in the message is stripped', forged.length === 1, JSON.stringify(forged));
  check('the class of the written body is the class of the finding', classOfBody(body) === 'CWE-89',
    String(classOfBody(body)));
}

// 12. The whole step, against a stand-in for the GitHub API.
//
//     This is the case the issue measures. A pull request that already
//     carries a thread of the class, and the same finding on the same line:
//     nothing is posted and nothing is closed. Then the same finding one
//     line lower: the old thread goes and a fresh one is posted where the
//     model put it.
{
  const { syncThreads } = await import('./thread-sync.mjs');

  const mkThread = (id, path, line, body) => ({
    id, path, line, isResolved: false, isOutdated: false,
    comments: { totalCount: 1, nodes: [{ id: `${id}-c`, databaseId: 1, body }] },
  });

  const makeGithub = (threads, files) => {
    const calls = { deleted: [], resolved: [], posted: [], warned: [] };
    const github = {
      graphql: async (query, vars) => {
        if (/resolveReviewThread/.test(query)) {
          calls.resolved.push(vars.id);
          return { data: { resolveReviewThread: { thread: { isResolved: true } } } };
        }
        return {
          repository: {
            pullRequest: {
              reviewThreads: { nodes: threads },
            },
          },
        };
      },
      rest: {
        pulls: {
          listFiles: async () => ({ data: files.map(f => ({ filename: f })) }),
          deleteReviewComment: async (a) => { calls.deleted.push(a.comment_id); return { data: {} }; },
          createReviewComment: async (a) => { calls.posted.push(a); return { data: {} }; },
        },
      },
    };
    return { github, calls };
  };

  const context = {
    repo: { owner: 'o', repo: 'r' },
    issue: { number: 7 },
    payload: { pull_request: { head: { sha: 'abc123' } } },
  };
  const finding = { file: 'src/a.ts', line: 10, cwe: 'CWE-89', severity: 'high', message: 'raw SQL', confidence: 0.9 };

  // Round 1: nothing is on the pull request yet.
  {
    const { github, calls } = makeGithub([], ['src/a.ts']);
    const r = await syncThreads({ github, context, findings: [finding], marker: 'p', warn: (m) => calls.warned.push(m) });
    check('a first finding is posted', r.posted === 1 && calls.posted.length === 1, JSON.stringify(r));
    check('the posted comment carries the class marker',
      calls.posted[0] && calls.posted[0].body.includes('<!-- am:class:CWE-89 -->'), JSON.stringify(calls.posted[0]));
    check('the posted comment names the file and the line',
      calls.posted[0] && calls.posted[0].path === 'src/a.ts' && calls.posted[0].line === 10,
      JSON.stringify(calls.posted[0]));
  }

  // Round 2: the same finding, on the same line. Nothing happens.
  {
    const standing = mkThread('t1', 'src/a.ts', 10,
      '<!-- am:p -->\n🔴 **HIGH** `CWE-89`\n<!-- am:class:CWE-89 -->\n (conf 90%): raw SQL');
    const { github, calls } = makeGithub([standing], ['src/a.ts']);
    const r = await syncThreads({ github, context, findings: [finding], marker: 'p', warn: (m) => calls.warned.push(m) });
    check('a second push of the same finding posts nothing', r.posted === 0 && calls.posted.length === 0,
      JSON.stringify(r));
    check('a second push of the same finding closes nothing',
      r.resolved === 0 && r.replaced === 0 && calls.deleted.length === 0, JSON.stringify(r));
  }

  // Round 3: the same finding, one line lower. The old thread goes, the
  // fresh one lands on the new line.
  {
    const standing = mkThread('t1', 'src/a.ts', 10,
      '<!-- am:p -->\n🔴 **HIGH** `CWE-89`\n<!-- am:class:CWE-89 -->\n (conf 90%): raw SQL');
    const { github, calls } = makeGithub([standing], ['src/a.ts']);
    const moved = { ...finding, line: 24 };
    const r = await syncThreads({ github, context, findings: [moved], marker: 'p', warn: (m) => calls.warned.push(m) });
    check('a finding that moved closes the old thread', r.replaced === 1 && calls.deleted.length === 1, JSON.stringify(r));
    check('a finding that moved is posted on the new line',
      r.posted === 1 && calls.posted[0] && calls.posted[0].line === 24, JSON.stringify(calls.posted[0]));
  }

  // Round 4: the file left the diff. The thread goes.
  {
    const standing = mkThread('t1', 'src/gone.ts', 10,
      '<!-- am:p -->\n🔴 **HIGH** `CWE-89`\n<!-- am:class:CWE-89 -->\n (conf 90%): raw SQL');
    const { github, calls } = makeGithub([standing], ['src/a.ts']);
    const r = await syncThreads({ github, context, findings: [], marker: 'p', warn: (m) => calls.warned.push(m) });
    check('a thread whose file left the diff is closed', r.replaced === 1 && calls.deleted.length === 1, JSON.stringify(r));
  }

  // Round 5: the class is the same but the id is not — CANON folds it, so
  // this is the same finding and nothing happens.
  {
    const standing = mkThread('t1', 'src/a.ts', 10,
      '<!-- am:p -->\n🔴 **HIGH** `CWE-330`\n<!-- am:class:CWE-330 -->\n (conf 90%): not random');
    const { github, calls } = makeGithub([standing], ['src/a.ts']);
    const other = { file: 'src/a.ts', line: 10, cwe: 'CWE-338', severity: 'high', message: 'not random', confidence: 0.9 };
    const r = await syncThreads({ github, context, findings: [other], marker: 'p', warn: (m) => calls.warned.push(m) });
    check('two ids of one weakness are one finding', r.posted === 0 && r.replaced === 0, JSON.stringify(r));
  }

  // Round 6: a thread of another pipeline is not touched.
  {
    const other = mkThread('t1', 'src/a.ts', 10,
      '<!-- am:another-pipeline -->\n🔴 **HIGH** `CWE-89`\n<!-- am:class:CWE-89 -->\n (conf 90%): raw SQL');
    const { github, calls } = makeGithub([other], ['src/a.ts']);
    const r = await syncThreads({ github, context, findings: [], marker: 'p', warn: (m) => calls.warned.push(m) });
    check('a thread of another pipeline is not touched', r.resolved === 0 && r.replaced === 0 && calls.deleted.length === 0,
      JSON.stringify(r));
  }

  // Round 8: a legacy thread — posted before the class marker existed — of
  // the style pipeline. Its class is the category tag after the
  // confidence. A finding of the same class on the same line must recognise
  // it and leave it alone: a legacy thread that reads as classless is a
  // thread that is never closed, and the pull request collects one per
  // finding per push.
  {
    const legacy = mkThread('t1', 'src/a.ts', 10,
      '<!-- am:p -->\n🟡 **HIGH** (conf 80%): [naming] x is a bad name');
    const { github, calls } = makeGithub([legacy], ['src/a.ts']);
    const style = { file: 'src/a.ts', line: 10, severity: 'medium', message: '[naming] x is a bad name', confidence: 0.8 };
    const r = await syncThreads({ github, context, findings: [style], marker: 'p', warn: (m) => calls.warned.push(m) });
    check('a legacy style thread is recognised, so nothing is posted', r.posted === 0 && calls.posted.length === 0,
      JSON.stringify(r));
    check('a legacy style thread is not closed either', r.replaced === 0 && r.resolved === 0, JSON.stringify(r));
  }

  // Round 9: the token cannot close the thread. The standing comment stays
  // and no second one is posted next to it.
  {
    const standing = mkThread('t1', 'src/a.ts', 10,
      '<!-- am:p -->\n🔴 **HIGH** `CWE-89`\n<!-- am:class:CWE-89 -->\n (conf 90%): raw SQL');
    const { github, calls } = makeGithub([standing], ['src/a.ts']);
    github.graphql = async (query) => {
      if (/resolveReviewThread/.test(query)) throw new Error('Resource not accessible by integration');
      return { repository: { pullRequest: { reviewThreads: { nodes: [standing] } } } };
    };
    github.rest.pulls.deleteReviewComment = async () => { throw new Error('Resource not accessible by integration'); };
    const moved = { ...finding, line: 24 };
    const r = await syncThreads({ github, context, findings: [moved], marker: 'p', warn: (m) => calls.warned.push(m) });
    check('a thread that cannot be closed stays', r.posted === 0 && calls.posted.length === 0, JSON.stringify(r));
    check('a thread that cannot be closed is reported', calls.warned.length > 0, JSON.stringify(calls.warned));
  }
}

// 13. One implementation. The reusable workflow and the reference consumer
//     both use scripts/thread-sync.mjs. Two implementations side by side is
//     how the fork ended up with two behaviours — issue #38.
{
  const reusable = readFileSync(join(ROOT, '.github', 'workflows', 'thread-sync.yml'), 'utf8');
  const reference = readFileSync(join(ROOT, '.github', 'workflows', 'ai-review.yml'), 'utf8');

  check('the reusable workflow exists', reusable.length > 0);
  check('the reusable workflow can be called', /workflow_call:/.test(reusable), '');
  check('the reusable workflow uses the shared module', /thread-sync\.mjs/.test(reusable), '');
  check('the reference consumer uses the shared module', /thread-sync\.mjs/.test(reference), '');
  check('the reference consumer no longer carries its own copy of the class logic',
    !/const CANON = \{/.test(reference), 'ai-review.yml still defines its own CANON map');
  check('the reference consumer no longer carries its own copy of the class reader',
    !/const classOfText = /.test(reference), 'ai-review.yml still defines its own classOfText');
  check('the reference consumer points at the contract', /thread-sync-contract\.md/.test(reference), '');

  // The module is ESM and actions/github-script runs on node20, where
  // `require()` of an ES module is not available on every runner image.
  // `import()` is.
  for (const [name, text] of [['the reusable workflow', reusable], ['the reference consumer', reference]]) {
    check(`${name} loads the module with import(), not require()`, /await import\(/.test(text), '');
    check(`${name} does not require() the module`, !/require\(SRC\)/.test(text), '');
  }

  // The reusable workflow fetches the module from this repository. It has to
  // check out THIS repository — a workflow called from another repository
  // has no such file — and it has to do it at the commit the caller called.
  //
  // `job.workflow_sha`, not `github.workflow_sha`: for a job defined in a
  // reusable workflow the `job` context carries the reusable workflow's own
  // ref and sha, while `github.*` carries the caller's. Checking out the
  // caller's repository finds no such file, and the failure reads as "the
  // step does not exist" rather than "the wrong repository was checked out".
  check('the reusable workflow checks out this repository', /repository: agents-market\/github-workflows/.test(reusable), '');
  check('the reusable workflow checks out at the sha the caller called', /ref: \$\{\{ job\.workflow_sha \}\}/.test(reusable), '');
  check('the reusable workflow does not check out the caller\'s repository',
    !/ref: \$\{\{ github\.workflow_ref/.test(reusable) && !/ref: \$\{\{ github\.workflow_sha/.test(reusable), '');
}

// 13. The contract is written down, and the things it promises are in it.
{
  const doc = readFileSync(join(ROOT, 'docs', 'thread-sync-contract.md'), 'utf8');
  check('the contract names the class marker format', doc.includes('<!-- am:class:'), '');
  check('the contract names the CANON map', doc.includes('CANON'), '');
  check('the contract names the version', doc.includes(CONTRACT_VERSION), CONTRACT_VERSION);
  check('the contract says what a consumer may rely on', /may rely on|can rely on/i.test(doc), '');
  check('the contract says what a change breaks', /breaks/i.test(doc), '');
  check('the contract lists every folded pair', Object.keys(CANON).every(k => doc.includes(k)),
    Object.keys(CANON).filter(k => !doc.includes(k)).join(', '));
  check('the module and the contract agree on the version', doc.includes(`\`${CONTRACT_VERSION}\``), CONTRACT_VERSION);
}

// 14. A consumer calls the reusable workflow in a few lines, not by copying
//     two hundred of them.
{
  const reusable = readFileSync(join(ROOT, '.github', 'workflows', 'thread-sync.yml'), 'utf8');
  check('the reusable workflow takes the findings as an input', /findings:/.test(reusable), '');
  check('the reusable workflow takes the pipeline marker as an input', /marker:/.test(reusable), '');
  check('the reusable workflow is not two hundred lines of logic', reusable.split('\n').length < 140,
    `${reusable.split('\n').length} lines`);
}

// 15. The verdict layer: what a human decided, written down in a file the
//     repository keeps.
//
//     The measurement behind it: web3eco/blockchain#83 collected 22 inline
//     threads over 4 pushes, 14 of them on one file that is a frozen
//     archival copy Dependabot never reads, and 8 of them got a "not
//     fixing, by design" reply — and the finding came back on the next
//     push. The sync knew what it had said; it did not know what a human
//     had decided.
{
  const parsed = parseVerdicts(`{"src/a.ts::CWE-89": {"verdict": "accepted", "reason": "by design", "until": "${inDays(30)}"}}`);
  check('a verdict file parses', parsed.entries.size === 1, JSON.stringify([...parsed.entries.keys()]));
  check('the key is the file and the class', parsed.entries.has('src/a.ts::CWE-89'),
    JSON.stringify([...parsed.entries.keys()]));
  check('the reason is kept', parsed.entries.get('src/a.ts::CWE-89').reason === 'by design',
    JSON.stringify(parsed.entries.get('src/a.ts::CWE-89')));
  check('the verdict keeps the date it was given',
    parsed.entries.get('src/a.ts::CWE-89').until === inDays(30),
    JSON.stringify(parsed.entries.get('src/a.ts::CWE-89')));
  check('a verdict with no verdict of its own is an accepted one',
    parsed.entries.get('src/a.ts::CWE-89').verdict === DEFAULT_VERDICT,
    parsed.entries.get('src/a.ts::CWE-89').verdict);

  const broken = parseVerdicts('{not json');
  check('a file that does not parse hides nothing', broken.entries.size === 0, JSON.stringify(broken.entries.size));
  check('a file that does not parse says so', broken.errors.length === 1, JSON.stringify(broken.errors));

  const folded = parseVerdicts(`{"src/a.ts::cwe-330": {"until": "${inDays(30)}"}}`);
  check('the class of a key is folded through the CANON map',
    folded.entries.has('src/a.ts::CWE-338'), JSON.stringify([...folded.entries.keys()]));

  // Every verdict expires. A verdict with no date is not a decision about
  // this finding — it is a decision never to be told about it again — and it
  // does not apply. A date further out than a year is capped, for the same
  // reason: a verdict that hides a finding for ever hides a defect that
  // appears tomorrow too.
  const endless = parseVerdicts('{"src/a.ts::CWE-89": {"reason": "for ever"}}');
  check('a verdict with no date does not apply',
    verdictFor(endless.entries, 'src/a.ts', 'CWE-89') === null, JSON.stringify(endless.entries.get('src/a.ts::CWE-89')));
  check('a verdict with no date says so', endless.errors.length === 1, JSON.stringify(endless.errors));

  const far = parseVerdicts(`{"src/a.ts::CWE-89": {"until": "${inDays(1000)}"}}`);
  check('a verdict longer than a year is capped',
    far.entries.get('src/a.ts::CWE-89').until === inDays(MAX_HORIZON_DAYS),
    JSON.stringify(far.entries.get('src/a.ts::CWE-89')));
  check('the cap is reported', far.errors.length === 1, JSON.stringify(far.errors));
  check('a capped verdict still applies',
    verdictFor(far.entries, 'src/a.ts', 'CWE-89') !== null, '');
}

// 16. A finding a human decided about is not reported again — and the
//     comment that is already there stays.
{
  const findings = [{ file: 'src/a.ts', line: 10, cwe: 'CWE-89', severity: 'high', message: 'raw SQL' }];
  const standing = [{
    id: 't1', path: 'src/a.ts', line: 10, isResolved: false, isOutdated: false,
    body: '<!-- am:p -->\n🔴 **HIGH** `CWE-89`\n<!-- am:class:CWE-89 -->\n (conf 90%): raw SQL',
  }];
  const verdicts = parseVerdicts(`{"src/a.ts::CWE-89": {"verdict": "accepted", "reason": "by design", "until": "${inDays(30)}"}}`).entries;
  const plan = planSync({ threads: standing, findings, inDiff: ['src/a.ts'], verdicts });
  check('a finding a verdict covers is not posted', plan.post.length === 0, JSON.stringify(plan.post));
  check('the comment that is already there stays', !plan.close.some(t => t.id === 't1'), JSON.stringify(plan.close));
  check('the run says a verdict covered it', plan.covered.length === 1
    && plan.skipped.some(s => s.why === 'verdict'), JSON.stringify(plan.skipped));

  // The line is not part of the key: over 26 findings of
  // code-review-security-audit 3.4.7 on three real diffs, not one repeated
  // with the same line. A verdict keyed by a coordinate would expire every
  // time an unrelated edit moved the code above it.
  const moved = planSync({
    threads: [], findings: [{ file: 'src/a.ts', line: 99, cwe: 'CWE-89', severity: 'high', message: 'raw SQL' }],
    inDiff: ['src/a.ts'], verdicts,
  });
  check('a verdict covers the finding wherever it moved to', moved.post.length === 0, JSON.stringify(moved.post));

  // A verdict on the file covers every class in it. That is the granularity
  // the sync already uses — one comment per (file, class) — so a verdict
  // hides no more than the comment already hid.
  const fileWide = planSync({
    threads: [],
    findings: [
      { file: 'src/a.ts', line: 1, cwe: 'CWE-89', severity: 'high', message: 'x' },
      { file: 'src/a.ts', line: 2, cwe: 'CWE-798', severity: 'high', message: 'y' },
    ],
    inDiff: ['src/a.ts'],
    verdicts: parseVerdicts(`{"src/a.ts": {"verdict": "accepted", "until": "${inDays(30)}"}}`).entries,
  });
  check('a verdict on the file covers every class in it',
    fileWide.post.length === 0 && fileWide.covered.length === 2, JSON.stringify(fileWide.covered));

  // Another file is not covered by it.
  const other = planSync({
    threads: [], findings: [{ file: 'src/b.ts', line: 1, cwe: 'CWE-89', severity: 'high', message: 'x' }],
    inDiff: ['src/b.ts'], verdicts,
  });
  check('a verdict covers only its own file', other.post.length === 1, JSON.stringify(other.post));
}

// 17. A verdict that expired covers nothing, and neither does one with no
//     date or an unreadable one. An accepted risk is not a sentence for
//     ever: the finding comes back when the date passes, and a date nobody
//     can read is treated as passed.
{
  const past = parseVerdicts('{"src/a.ts::CWE-89": {"until": "2020-01-01"}}');
  check('an expired verdict covers nothing', verdictFor(past.entries, 'src/a.ts', 'CWE-89') === null,
    JSON.stringify(past.entries.get('src/a.ts::CWE-89')));
  const future = parseVerdicts(`{"src/a.ts::CWE-89": {"until": "${inDays(30)}"}}`);
  check('a verdict that has not expired covers the finding',
    verdictFor(future.entries, 'src/a.ts', 'CWE-89') !== null, '');
  const unreadable = parseVerdicts('{"src/a.ts::CWE-89": {"until": "next tuesday"}}');
  check('a verdict with an unreadable date covers nothing',
    verdictFor(unreadable.entries, 'src/a.ts', 'CWE-89') === null, '');
  check('an unreadable date is reported', unreadable.errors.length === 1, JSON.stringify(unreadable.errors));
}

// 18. The whole step, with the verdicts: a covered finding is not posted,
//     and the run says which verdict covered it.
//
//     The module reads the verdicts itself, from the base of the pull
//     request. The caller says nothing about them at all.
{
  const { syncThreads } = await import('./thread-sync.mjs');
  const mkThread = (id, path, line, body) => ({
    id, path, line, isResolved: false, isOutdated: false,
    comments: { totalCount: 1, nodes: [{ id: `${id}-c`, databaseId: 1, body }] },
  });
  const calls = { posted: [], warned: [], read: [] };
  const standing = mkThread('t1', 'src/a.ts', 10,
    '<!-- am:p -->\n🔴 **HIGH** `CWE-89`\n<!-- am:class:CWE-89 -->\n (conf 90%): raw SQL');
  const makeGithub = (threads, verdicts = '') => ({
    graphql: async () => ({ repository: { pullRequest: { reviewThreads: { nodes: threads } } } }),
    rest: {
      repos: {
        getContent: async (a) => {
          calls.read.push(a);
          if (!verdicts) {
            const e = new Error('Not Found');
            e.status = 404;
            throw e;
          }
          return { data: { content: Buffer.from(verdicts, 'utf8').toString('base64') } };
        },
      },
      pulls: {
        listFiles: async () => ({ data: [{ filename: 'src/a.ts' }] }),
        deleteReviewComment: async () => { throw new Error('should not delete'); },
        createReviewComment: async (a) => { calls.posted.push(a); return { data: {} }; },
      },
    },
  });
  const context = {
    repo: { owner: 'o', repo: 'r' },
    issue: { number: 7 },
    payload: { pull_request: { head: { sha: 'head123' }, base: { sha: 'base123' } } },
  };
  const finding = { file: 'src/a.ts', line: 10, cwe: 'CWE-89', severity: 'high', message: 'raw SQL', confidence: 0.9 };
  const until = inDays(30);
  const verdicts = `{"src/a.ts::CWE-89": {"verdict": "accepted", "reason": "by design", "until": "${until}"}}`;
  const github = makeGithub([standing], verdicts);
  const r = await syncThreads({
    github, context, findings: [finding], marker: 'p',
    warn: (m) => calls.warned.push(m),
  });
  check('the verdicts are read from the base of the pull request',
    calls.read.length === 1 && calls.read[0].ref === 'base123', JSON.stringify(calls.read));
  check('the verdicts are read from the fixed path',
    calls.read.length === 1 && calls.read[0].path === DEFAULT_VERDICTS_PATH, JSON.stringify(calls.read));
  check('a covered finding is not posted', r.posted === 0 && calls.posted.length === 0, JSON.stringify(r));
  check('the comment that is already there is not closed either',
    r.resolved === 0 && r.replaced === 0, JSON.stringify(r));
  check('the log line counts the verdicts', /\b1 by verdict\b/.test(r.logLine), r.logLine);
  check('the summary names the verdict and its reason',
    r.summary.includes('src/a.ts::CWE-89') && r.summary.includes('by design'), r.summary);
  check('the summary offers the key of a finding no verdict covers',
    r.summary.includes(verdictKey('src/a.ts', 'CWE-89')), r.summary);

  // A verdict the caller passes in is ignored: the module reads the file
  // itself, so a caller cannot silence a review by putting the content into
  // the step.
  const injected = await syncThreads({
    github: makeGithub([], ''), context, findings: [finding], marker: 'p',
    verdicts,
    warn: (m) => calls.warned.push(m),
  });
  check('a verdict passed in by the caller is ignored',
    injected.posted === 1, JSON.stringify(injected));

  // No file at the base is the normal case: no verdicts, and nothing said
  // about it.
  const none = await syncThreads({
    github: makeGithub([]), context, findings: [finding], marker: 'p',
    warn: (m) => calls.warned.push(m),
  });
  check('no verdicts file means no verdicts', none.posted === 1, JSON.stringify(none));
  check('no verdicts file says nothing', calls.warned.length === 0, JSON.stringify(calls.warned));

  // A verdict file that does not parse: nothing is hidden, and the run says
  // what it could not read. Nothing stands on the pull request here, so the
  // finding has to be posted.
  const broken = await syncThreads({
    github: makeGithub([], '{not json'), context, findings: [finding], marker: 'p',
    warn: (m) => calls.warned.push(m),
  });
  check('a verdict file that does not parse hides nothing', broken.posted === 1, JSON.stringify(broken));
  check('a verdict file that does not parse is reported', calls.warned.length > 0, JSON.stringify(calls.warned));
}

// 19. The verdict report says what the reader needs: what was not reported,
//     and what to write down to stop the rest.
//
//     And what it says is text, not markup: the key carries a path the model
//     read out of the diff, and what the bot posts is attributed to the bot.
//     A path that closed the code span, or a reason that carried a link, is
//     a way to put something under the bot's name.
{
  const report = verdictSummary({
    covered: [{ key: 'src/a.ts::CWE-89', verdict: 'accepted', reason: 'by design' }],
    expired: ['src/b.ts::CWE-798'],
    hints: [{ file: 'src/c.ts', classes: ['NAMING'] }],
  }, { path: '.github/ai-review-verdicts.json' });
  check('the report names the covered finding', report.includes('src/a.ts::CWE-89'), report);
  check('the report says why it was not reported', report.includes('by design'), report);
  check('the report names the expired verdict', report.includes('src/b.ts::CWE-798'), report);
  check('the report gives the key to file', report.includes('src/c.ts::NAMING'), report);
  check('the report names where the verdicts live',
    report.includes('.github/ai-review-verdicts.json'), report);
  check('an empty report says nothing', verdictSummary({}) === '', verdictSummary({}));

  // The key is a path from the diff: it may not close the code span it is
  // printed in.
  const injected = verdictSummary({
    covered: [{ key: 'src/a.ts` **bold** `x', verdict: 'accepted', reason: 'ok' }],
    hints: [],
  });
  check('a key may not close the code span', !injected.includes('` **bold** `'), injected);
  check('a key may not close the code span, part two',
    (injected.match(/`/g) || []).length % 2 === 0, injected);

  // The reason is text: it may not carry a link, an image, a mention or a
  // line break into a comment the bot posts.
  const sneaky = verdictSummary({
    covered: [{ key: 'src/a.ts::CWE-89', verdict: 'accepted', reason: 'see [here](https://evil.example) @everyone <img src=x>' }],
    hints: [],
  });
  check('a reason may not carry a link', !sneaky.includes('](https://evil.example)'), sneaky);
  check('a reason may not carry a mention', !sneaky.includes('@everyone'), sneaky);
  check('a reason may not carry html', !sneaky.includes('<img'), sneaky);

  // A reason longer than a line is cut: a comment the bot posts is not a
  // place for a paragraph.
  const long = verdictSummary({
    covered: [{ key: 'src/a.ts::CWE-89', verdict: 'accepted', reason: 'x'.repeat(5000) }],
    hints: [],
  });
  check('a reason is cut to a line', long.length < 500, String(long.length));

  // The text of a failure is text too: it can carry a path from the diff.
  const failed = errorText(new Error('could not comment on src/a.ts: see [here](https://evil.example) @everyone'));
  check('a failure message may not carry a link', !failed.includes('](https://evil.example)'), failed);
  check('a failure message may not carry a mention', !failed.includes('@everyone'), failed);
  check('a failure message is cut to a line',
    errorText(new Error('x'.repeat(5000))).length <= 200, String(errorText(new Error('x'.repeat(5000))).length));
}

// 20. The contract and the two callers know about the verdict layer, and
//     neither of them can hand the step a verdict.
//
//     A feature the callers do not pass is a feature that does not run — and
//     a feature the callers can pass is a feature a pull request author can
//     use to silence the review of their own pull request.
{
  const doc = readFileSync(join(ROOT, 'docs', 'thread-sync-contract.md'), 'utf8');
  const module = readFileSync(join(ROOT, 'scripts', 'thread-sync.mjs'), 'utf8');
  const reusable = readFileSync(join(ROOT, '.github', 'workflows', 'thread-sync.yml'), 'utf8');
  const reference = readFileSync(join(ROOT, '.github', 'workflows', 'ai-review.yml'), 'utf8');

  check('the contract names the verdict layer', /verdict/i.test(doc), '');
  check('the contract names the verdict key', doc.includes('path::CLASS'), '');
  check('the contract says the line is not part of the key',
    /not part of the key/i.test(doc), '');

  // The step reads the verdicts; nobody hands them over.
  check('the module reads the verdicts itself', /getContent/.test(module), '');
  check('the module reads them from the base of the pull request',
    /pull_request\.base\.sha/.test(module), '');
  check('the module reads them from a fixed path',
    module.includes(`path: DEFAULT_VERDICTS_PATH`), '');
  check('the reusable workflow takes no verdict as an input',
    !/^ {6}verdicts/m.test(reusable), '');
  check('the reusable workflow has no input at all for the verdicts',
    !/verdicts_path/.test(reusable), '');
  check('the reusable workflow carries no verdict content',
    !/VERDICTS/.test(reusable), '');
  check('the reference consumer carries no verdict content',
    !/VERDICTS:\s*\$\{\{\s*steps\./.test(reference), '');
  check('the reference consumer does not pass the verdicts on',
    !/verdictsPath:/.test(reference), '');
  check('the reference consumer does not read the verdicts out of the checkout',
    !/git show "\$BASE:/.test(reference), '');
  check('the contract says where the verdicts may be read from',
    /base/i.test(doc) && /verdict/i.test(doc), '');
  check('the contract says the caller may not hand them over',
    /says nothing at all about the verdicts/i.test(doc), '');

  // A failure message can carry a path from the diff, so it is text like any
  // other — and it is escaped by the module, in one place, so the two
  // callers cannot drift.
  check('the module escapes the text of a failure', /export const errorText/.test(module), '');
  check('the reusable workflow prints a failure through the module',
    /errorText\(e\)/.test(reusable), '');
  check('the reference consumer prints a failure through the module',
    /errorText\(e\)/.test(reference), '');
  check('no caller prints a raw failure message',
    !/addRaw\(e\.message\)/.test(reusable) && !/addRaw\(e\.message\)/.test(reference), '');
}

console.log(failures ? `\n${failures} checks failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);