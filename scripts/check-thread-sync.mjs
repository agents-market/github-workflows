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
} from './thread-sync.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '..');

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

console.log(failures ? `\n${failures} checks failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
