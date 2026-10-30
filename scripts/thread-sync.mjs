#!/usr/bin/env node
// The inline thread sync — the part of the review that decides whether a
// review comment is a new finding or the same finding one line lower.
//
//   node scripts/thread-sync.mjs          prints the contract version and the
//                                         class of a sample body
//
// This file holds the *decisions*. The GitHub calls live in the workflow that
// calls this module, so the policy can be read, reviewed and tested without a
// network.
//
// It is a module, not a script, because there are two callers and they must
// not drift: `.github/workflows/thread-sync.yml` (the reusable workflow a
// consumer calls) and `.github/workflows/ai-review.yml` (the reference
// consumer, which dogfoods the same code). Two implementations side by side
// is exactly how the fork ended up with two behaviours — see issue #38.
//
// The contract this file implements is written down in
// docs/thread-sync-contract.md. The check that keeps this honest is
// scripts/check-thread-sync.mjs.

/**
 * The contract version. A consumer that depends on the class semantics may
 * pin this; a change to the marker format or to the CANON map bumps it.
 *
 * Bump the minor part for a behaviour change a consumer can observe (a
 * different decision about a thread that did not move), and the major part
 * for a change to the *shape* of the contract (the marker format, the CANON
 * map itself) — a consumer that reads its own comments back has to be
 * re-read after a major bump.
 */
export const CONTRACT_VERSION = '1.0';

/**
 * Two ids that name one weakness are one weakness.
 *
 * The catalogue carries both CWE-330 and CWE-338 for "a random number that is
 * not random", so the model picks either from run to run: the run of
 * 2026-10-22 called the same `Math.random` token CWE-330 and then CWE-338,
 * and the comment for the first id never closed. The reader saw the weakness
 * twice.
 *
 * The map is deliberately short. A pair belongs here when the two ids name
 * the same defect: 321 (a hard-coded cryptographic key) and 798 (hard-coded
 * credentials) are the same line of code. CWE-200 (information exposure) is
 * left out — it is a wider class than 209 (an error message with a secret in
 * it), and merging them would hide one of two different exposures in the
 * same file. Two comments for one weakness is the smaller fault: a hidden
 * finding is worse than a duplicate.
 */
export const CANON = {
  'CWE-330': 'CWE-338',
  'CWE-259': 'CWE-798',
  'CWE-915': 'CWE-1321',
  'CWE-321': 'CWE-798',
};

/** Canonical form of a class id: upper case, and folded through CANON. */
export const canon = (id) => {
  const u = String(id || '').trim().toUpperCase();
  return CANON[u] || u;
};

/**
 * The marker the class is written as. It is a hidden HTML comment: the reader
 * never sees it, and the next run reads it back out of the body.
 *
 * The format is part of the contract — see docs/thread-sync-contract.md.
 */
export const classMarker = (cls) => `<!-- am:class:${cls} -->`;

/** The pipeline marker: the first line of every body this step writes. */
export const pipelineMarker = (marker) => `<!-- am:${marker} -->`;

/**
 * The category tag the style pipeline opens its description with.
 *
 * Anchored at the start of the *text*: a bracket in the middle of a sentence
 * is prose, not a class.
 */
const tagOf = (text) => {
  const t = /^\s*\[([a-z][a-z_]{1,24})\]/i.exec(String(text || ''));
  return t ? t[1].toUpperCase() : null;
};

/**
 * The class of a finding, as the pipeline says it.
 *
 * The security audit's class is its CWE id; the style pipeline has no id, and
 * its class is the category tag its message opens with ("[naming] ...").
 *
 * The message is NOT searched for a CWE id: the message is written from the
 * diff, and a diff can mention any CWE in a comment. A class read out of the
 * prose is a class nobody chose, and it changes from run to run — that was
 * the reason the fork's first version of this disagreed with itself.
 */
export const classOfFinding = (f) => {
  const cwe = String((f && f.cwe) || '').trim();
  if (cwe) return canon(cwe);
  const tag = tagOf(f && f.message);
  return tag ? canon(tag) : null;
};

/**
 * The class of a body this step wrote.
 *
 * The body carries the class in a marker, so the read is exact. The text is
 * the fallback for a thread posted before the marker existed, and there the
 * category tag sits *after* the confidence — the body starts with the
 * pipeline marker, so a tag anchored at the start of the body is never found.
 * That was the bug in issue #38: `classOfText` looked for the tag at the
 * beginning of the body, and the style pipeline's body begins with the
 * pipeline marker.
 */
export const classOfBody = (body) => {
  const b = String(body || '');
  // The marker this step writes. It is found anywhere in the body: the body
  // format is ours, and the marker is the one place we wrote the class.
  const m = /<!--\s*am:class:([a-z0-9_-]+)\s*-->/i.exec(b);
  if (m) return canon(m[1].toUpperCase());
  // A thread posted before the class marker existed. The CWE id sits in
  // backticks right after the severity, on the second line — that is the
  // structured place, and the only place.
  const legacy = /\*\*[A-Z]+\*\*\s*`\s*(CWE-\d+)\s*`/i.exec(b);
  if (legacy) return canon(legacy[1].toUpperCase());
  // The style pipeline has no CWE id: its class is the category tag, right
  // after the confidence.
  const after = /\(conf\s*\d+%\)\s*:\s*\[([a-z][a-z_]{1,24})\]/i.exec(b);
  if (after) return canon(after[1].toUpperCase());
  // Last resort: the tag at the very start of the text, for a body written by
  // something that put the description first.
  const atStart = tagOf(b);
  return atStart ? canon(atStart) : null;
};

/**
 * The class of a *text* — the fallback for a finding with no class of its own.
 *
 * Same rule as `classOfBody`: the category tag is read after `(conf N%)`,
 * not at the start of the string, because the body begins with the pipeline
 * marker.
 */
export const classOfText = (text) => {
  const b = String(text || '');
  const c = /CWE-\d+/i.exec(b);
  if (c) return canon(c[0].toUpperCase());
  const v = /CVE-\d{4}-\d+/i.exec(b);
  if (v) return v[0].toUpperCase();
  const after = /\(conf\s*\d+%\)\s*:\s*\[([a-z][a-z_]{1,24})\]/i.exec(b);
  if (after) return canon(after[1].toUpperCase());
  return tagOf(b);
};

/**
 * The decision this module makes, for one pull request, in one round.
 *
 * The plan is a pure function of what is already on the pull request and what
 * the pipeline found. The workflow turns the plan into GraphQL and REST
 * calls; nothing here touches the network, so the policy can be tested.
 *
 * @param {object} input
 * @param {Array} input.threads   the threads of this pipeline, with their class
 * @param {Array} input.findings  the findings of this round
 * @param {Set|Array} input.inDiff  the files in the diff
 * @returns {{post: Array, close: Array, keep: Array, skipped: Array}}
 */
export const planSync = ({ threads = [], findings = [], inDiff = [] } = {}) => {
  const diff = inDiff instanceof Set ? inDiff : new Set(inDiff);

  // Live threads of this pipeline, by class and file. The class is the
  // identity: the line moves, the class does not.
  const byClass = new Map();
  for (const t of threads) {
    if (t.isResolved || t.isOutdated) continue;
    if (!diff.has(t.path)) continue;
    const cls = t.class || classOfBody(t.body);
    if (!cls) continue;
    const key = `${t.path}::${cls}`;
    const list = byClass.get(key) || [];
    list.push(t);
    byClass.set(key, list);
  }

  // Match first, close second. Two weaknesses of one class in one file must
  // not take each other's comments away, so a thread that a finding claims is
  // off limits to the closing pass.
  const kept = new Set();
  const matched = new Set();
  for (const f of findings) {
    if (!diff.has(f.file)) continue;
    const cls = classOfFinding(f);
    if (!cls) continue;
    const standing = byClass.get(`${f.file}::${cls}`) || [];
    // Same class on the same line: that is this finding, already said. It is
    // left where it is and nothing is posted for it.
    const same = standing.find(t => t.line === f.line && !kept.has(t.id));
    if (same) {
      kept.add(same.id);
      matched.add(f);
    }
  }

  const post = [];
  const close = [];
  const skipped = [];
  const closedIds = new Set();

  for (const f of findings) {
    if (!diff.has(f.file)) { skipped.push({ finding: f, why: 'file not in diff' }); continue; }
    if (matched.has(f)) { skipped.push({ finding: f, why: 'same class on the same line' }); continue; }
    const cls = classOfFinding(f);
    const standing = cls ? (byClass.get(`${f.file}::${cls}`) || []) : [];
    // The class moved to another line: close what it carried on this file,
    // then post the fresh one where the model puts it this time. A thread a
    // finding claimed above stays: that is another weakness of the same class,
    // not the one that moved.
    let closed = true;
    let toClose = 0;
    for (const t of standing) {
      if (kept.has(t.id) || closedIds.has(t.id)) continue;
      toClose++;
      close.push(t);
      closedIds.add(t.id);
      closed = closed && true;
    }
    // A thread that cannot be closed stays as it is, and no second one is
    // added: a standing comment the reader can see beats two they cannot.
    if (toClose && !closed) { skipped.push({ finding: f, why: 'could not close the old thread' }); continue; }
    post.push({ finding: f, class: cls });
  }

  // A thread whose file left the diff or whose line moved on says nothing
  // about the code any more.
  for (const t of threads) {
    if (!t.isResolved && (t.isOutdated || !diff.has(t.path))) {
      if (!closedIds.has(t.id)) { close.push(t); closedIds.add(t.id); }
    }
  }

  return { post, close, keep: [...kept], skipped };
};

/**
 * The body this step writes for a finding.
 *
 * The shape is part of the contract: the pipeline marker is the first line,
 * the severity is the second, the class marker is the third, and the
 * confidence with the message follows.
 */
export const buildBody = ({ marker, finding, cls, emoji = {}, verified = {} }) => {
  const MARK = pipelineMarker(marker);
  const sev = String(finding.severity || 'unknown').toUpperCase();
  let b = `${MARK}\n${emoji[finding.severity] || '⚪'} **${sev}**`;
  if (finding.cwe) {
    const id = String(finding.cwe).trim().toUpperCase();
    const v = verified[id];
    b += ` \`${id}\``;
    // The id is only worth printing if it was checked against the official
    // catalogue; an unchecked code is worse than none.
    b += v ? ` — [${v.short || v.name}](${v.url})` : ' — not in the published catalogue';
  }
  // The class marker is on a line of its own, so the reader's text never
  // carries it and the legacy fallback can find the confidence where it
  // expects to find it.
  if (cls) b += `\n${classMarker(cls)}\n`;
  // A marker written by the model is data, not a marker: a forged one would
  // change the class of the finding.
  const msg = String(finding.message || '')
    .replace(/<!--\s*am:[a-z0-9_:-]+\s*-->/gi, '')
    .replace(/^\s*\[[a-z][a-z_]{1,24}\]\s*/i, '');
  b += ` (conf ${Math.round((finding.confidence || 0) * 100)}%): ${msg}`;
  if (finding.recommendation) {
    b += `\n\n💡 ${String(finding.recommendation).replace(/<!--\s*am:[a-z0-9_:-]+\s*-->/gi, '')}`;
  }
  return b;
};

/**
 * The whole step: read the threads of the pull request, decide, close, post.
 *
 * This is what both callers run — the reusable workflow and the reference
 * consumer. The GitHub calls are here rather than in the workflow so that
 * there is one implementation of the step and not two: the fork
 * web3eco/shared-actions copied the step and had to make two decisions
 * upstream never had to make, because upstream was the only implementation
 * and the behaviour was not written down anywhere. See issue #38.
 *
 * @param {object} io
 * @param {object} io.github    the `github` object of actions/github-script
 * @param {object} io.context  the `context` object of actions/github-script
 * @param {Array}  io.findings  the findings of this round
 * @param {string} io.marker    the pipeline id
 * @param {object} io.verified  the CWE catalogue entries, by id
 * @param {function} io.warn    how to report a warning
 * @returns {Promise<object>}  the counters the log line prints
 */
export const syncThreads = async ({ github, context, findings = [], marker, verified = {}, warn = () => {} }) => {
  const MARK = pipelineMarker(marker);
  const valid = findings.filter(f =>
    f && typeof f.file === 'string' && f.file.length > 0
    && Number.isFinite(f.line) && f.line > 0);

  const q = await github.graphql(`
    query($owner:String!,$repo:String!,$number:Int!){
      repository(owner:$owner,name:$repo){
        pullRequest(number:$number){
          reviewThreads(first:100){
            nodes{ id isResolved isOutdated path line
                   comments(first:10){ totalCount nodes{ id databaseId body } } }
          } } } }`,
    { owner: context.repo.owner, repo: context.repo.repo, number: context.issue.number });
  if (!q || !q.repository) throw new Error('graphql returned no repository — nothing to sync');
  const threads = q.repository.pullRequest.reviewThreads.nodes;

  // A thread is this pipeline's when its first comment carries the pipeline
  // marker. The marker is written by this step, so it is exact, and it keeps
  // each pipeline off the other pipeline's threads.
  const ours = threads.filter(t => {
    const first = t.comments.nodes[0];
    return first && typeof first.body === 'string' && first.body.includes(MARK);
  });

  const { data: files } = await github.rest.pulls.listFiles({
    ...context.repo, pull_number: context.issue.number, per_page: 100,
  });
  const inDiff = new Set(files.map(f => f.filename));

  // The decision: which threads to close, which findings to post, which
  // threads a finding keeps.
  const plan = planSync({
    threads: ours.map(t => ({
      id: t.id, path: t.path, line: t.line,
      isResolved: t.isResolved, isOutdated: t.isOutdated,
      body: t.comments.nodes[0] && t.comments.nodes[0].body,
      // The GraphQL node is carried along: closing a thread needs the
      // comment ids, and the decision only ever needs the fields above.
      node: t,
    })),
    findings: valid,
    inDiff,
  });

  const closeThread = async (t) => {
    const node = t.node || t;
    const first = node.comments && node.comments.nodes && node.comments.nodes[0];
    let why = '';
    // A thread with replies is a conversation: never delete it, only resolve
    // it.
    if (first && ((node.comments && node.comments.totalCount) || 0) === 1) {
      try {
        // The REST call wants the numeric comment id, not the GraphQL node id
        // — the node id is a 404 here.
        await github.rest.pulls.deleteReviewComment({
          ...context.repo, comment_id: first.databaseId,
        });
        return 'replaced';
      } catch (e) { why = `delete: ${e.message}`; }
    }
    try {
      await github.graphql(
        `mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread{ isResolved } } }`,
        { id: t.id });
      return 'resolved';
    } catch (e) {
      // The token may not be allowed to close a thread — the run of
      // 2026-10-22 showed the default GITHUB_TOKEN refused to resolve with
      // "Resource not accessible by integration", while a personal token
      // closed the same threads. A thread that cannot be closed stays as it
      // is, and the fresh comment for that class is not posted: a standing
      // comment the reader can see beats two they cannot. But a comment that
      // can go must go, or the review keeps claiming weaknesses that were
      // fixed days ago.
      warn(`cannot close a thread at ${t.path}:${t.line} — ${e.message}${why ? `; ${why}` : ''}`);
      return null;
    }
  };

  let resolved = 0, replaced = 0, posted = 0;
  const stood = new Set();
  for (const t of plan.close) {
    const how = await closeThread(t);
    if (how === 'resolved') resolved++;
    else if (how === 'replaced') replaced++;
    else stood.add(t.id); // could not close: it stands
  }

  const emoji = { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵' };
  let skipped = plan.skipped.length;
  // A review comment is anchored to a commit. Without the head sha there is
  // nowhere to anchor it, and every post would fail one by one — a run that
  // says "no findings" when it found three. Fail the step instead.
  const headSha = context.payload && context.payload.pull_request
    && context.payload.pull_request.head && context.payload.pull_request.head.sha;
  if (!headSha) throw new Error('the pull request head sha is missing — nowhere to anchor a review comment');
  for (const p of plan.post) {
    // A thread of this class that could not be closed still stands on this
    // file. Posting next to it would put two comments of one class in front
    // of the reader, which is the churn the class key was introduced to
    // stop.
    const standing = plan.close.filter(t => t.path === p.finding.file && stood.has(t.id));
    if (standing.length) { skipped++; continue; }
    const body = buildBody({ marker, finding: p.finding, cls: p.class, emoji, verified });
    try {
      await github.rest.pulls.createReviewComment({
        ...context.repo, pull_request: context.issue.number,
        commit_id: headSha,
        path: p.finding.file, line: p.finding.line, side: 'RIGHT', body,
      });
      posted++;
    } catch (e) {
      warn(`inline skip ${p.finding.file}:${p.finding.line} — ${e.message}`);
    }
  }

  return { posted, resolved, replaced, skipped, live: plan.keep.length };
};

// Run as a script: what does this file say about itself?
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(`thread-sync contract version ${CONTRACT_VERSION}`);
  console.log(`classes folded: ${Object.keys(CANON).length}`);
  console.log(`marker format: ${classMarker('CWE-20')}`);
  console.log(`legacy body class: ${classOfBody('<!-- am:style-review -->\n🟡 **HIGH** (conf 80%): [naming] x is named badly')}`);
}
