#!/usr/bin/env node
// The GitLab side of the review.
//
// GitLab does not run GitHub Actions, so the Action cannot do this job. What
// it can do is run the same pipelines — from the same catalogue, through the
// same published runtime — on the diff of a merge request, and put the result
// where a developer looks for it: on the merge request itself.
//
// Three of the inputs are GitLab's, and GitLab sets them:
//   CI_API_V4_URL — the API root
//   CI_PROJECT_ID, CI_MERGE_REQUEST_IID — which merge request
//
// Two are ours to ask for, as CI/CD variables:
//   GITLAB_TOKEN — a project access token with the `api` scope
//   MINIMAX_API_KEY — a MiniMax API key
//
// The pipelines are installed by the CLI before this script runs
// (`agentsmarket pipeline install <slug>`), so the specs are already on disk.
//
// Why Node and not Python: the runtime that executes a pipeline is a Node
// package, and this script calls it directly. The CLI can run a pipeline too,
// but it prints its result for a human, not for a program — there is no
// machine-readable output to read back, so a script would have to scrape the
// terminal.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';
import { runPipelineV2 } from '@agentsmarket/pipeline-runtime/dist/stages.js';
import { MiniMaxProvider } from '@agentsmarket/pipeline-runtime/dist/adapters/minimax.js';
import { LLMProviderRegistry } from '@agentsmarket/pipeline-runtime/dist/provider-registry.js';
import { StaticPricingResolver } from '@agentsmarket/pipeline-runtime/dist/pricing.js';
import { createModelResolver } from '@agentsmarket/pipeline-runtime/dist/model-resolver.js';
import { buildMockProvider } from '@agentsmarket/pipeline-runtime/dist/testing/index.js';

const INSTALL_DIR = process.env.PIPELINE_DIR || '.agentsmarket/pipelines';

// The pipelines, and what each of them is for. The order is the order the
// notes appear in.
const PIPELINES = [
  { slug: 'code-review-security-audit', label: 'security audit', focus: 'security', severity: 'medium' },
  { slug: 'style-review', label: 'style review', focus: 'all', severity: 'low' },
];

const need = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
};

// Read when they are needed, not when the file is loaded: a check imports the
// pure parts of this file and has no GitLab to talk to.
const apiRoot = () => need('CI_API_V4_URL').replace(/\/$/, '');
const project = () => need('CI_PROJECT_ID');
const mergeRequest = () => need('CI_MERGE_REQUEST_IID');
const token = () => need('GITLAB_TOKEN');

const api = async (method, path, body) => {
  const res = await fetch(`${apiRoot()}${path}`, {
    method,
    headers: {
      'PRIVATE-TOKEN': token(),
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status} ${(await res.text()).slice(0, 400)}`);
  }
  return res.status === 204 ? null : res.json();
};

// The diff of the merge request, as GitLab itself defines it: the source
// branch against the merge base. Not the diff of the checkout, which is the
// merge result and would carry the target branch's changes too — the
// reviewer would be shown code the developer never touched.
//
// GitLab truncates a very large diff and says so with `overflow`. A truncated
// diff reviewed as if it were whole is worse than no review: the missing half
// looks reviewed. So this fails loudly instead.
const diffOfMergeRequest = async () => {
  const mr = await api('GET', `/projects/${project()}/merge_requests/${mergeRequest()}`);
  const changes = await api('GET', `/projects/${project()}/merge_requests/${mergeRequest()}/changes`);
  if (changes.overflow) {
    throw new Error('the merge request is too large for GitLab to hand over its diff — the review is skipped, not partial');
  }
  const parts = [];
  for (const c of changes.changes || []) {
    const path = c.new_path || c.old_path;
    if (!path || !c.diff) continue;
    // The API gives the hunks of one file; the header is ours to add, and the
    // pipelines read the file name out of it.
    parts.push(`diff --git a/${c.old_path || path} b/${path}\n--- a/${c.old_path || path}\n+++ b/${path}\n${c.diff}`);
  }
  return { diff: parts.join('\n'), title: mr.title, source: mr.source_branch, target: mr.target_branch };
};

// The installed spec of a pipeline. The CLI writes
// .agentsmarket/pipelines/<slug>@<version>/pipeline.yaml, and the version is
// the marketplace's, not ours to guess.
const specOf = (slug) => {
  let installed;
  try {
    installed = readdirSync(INSTALL_DIR).filter((d) => d.startsWith(`${slug}@`));
  } catch {
    throw new Error(`${slug} is not installed — run: agentsmarket pipeline install ${slug}`);
  }
  if (!installed.length) throw new Error(`${slug} is not installed — run: agentsmarket pipeline install ${slug}`);
  const file = join(INSTALL_DIR, installed.sort().pop(), 'pipeline.yaml');
  return { file, spec: YAML.parse(readFileSync(file, 'utf-8')) };
};

const severityRank = { critical: 0, high: 1, medium: 2, low: 3 };

// Every finding the pipeline produced, whatever stage produced it. The stage
// names are the pipeline's business and change between versions; the shape of
// the findings is the contract. One line per file, line and class, so a
// weakness the pipeline mentions twice is one line for the reader.
export const findingsOf = (outputs) => {
  const all = [];
  for (const raw of Object.values(outputs || {})) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch { continue; }
    if (Array.isArray(parsed?.findings)) all.push(...parsed.findings);
  }
  const canon = { 'CWE-330': 'CWE-338', 'CWE-259': 'CWE-798', 'CWE-915': 'CWE-1321', 'CWE-321': 'CWE-798' };
  const classOf = (f) => {
    const id = String(f.cwe_id ?? f.cwe ?? '').trim().toUpperCase();
    if (id) return canon[id] || id;
    const tag = /^\s*\[([a-z][a-z_]{1,24})\]/i.exec(String(f.description ?? ''));
    return tag ? tag[1].toUpperCase() : null;
  };
  const merged = new Map();
  for (const f of all) {
    const key = `${f.file}::${f.line ?? ''}::${classOf(f) ?? ''}`;
    const kept = merged.get(key);
    // One weakness, one line — and the line carries the most serious reading
    // of it. The pipeline can mention the same weakness twice at two
    // severities, and the order it mentions them in is not a judgement.
    if (!kept || severityRank[String(f.severity || '').toLowerCase()] < severityRank[String(kept.severity || '').toLowerCase()]) {
      merged.set(key, f);
    }
  }
  return [...merged.values()];
};

export const noteFor = (slug, label, findings, cost, ms) => {
  const marker = `<!-- am:${slug} -->`;
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  let other = 0;
  for (const f of findings) {
    const s = String(f.severity || '').toLowerCase();
    if (s in counts) counts[s]++;
    else other++;
  }
  let b = `${marker}\n## AI Review — ${label}\n\n`;
  b += `| Metric | Value |\n|---|---:|\n`;
  const breakdown = `critical ${counts.critical} · high ${counts.high} · medium ${counts.medium} · low ${counts.low}`
    + (other ? ` · other ${other}` : '');
  b += `| Findings | ${findings.length} (${breakdown}) |\n`;
  b += `| Duration | ${(ms / 1000).toFixed(1)}s |\n`;
  b += `| Market-equivalent cost | ${cost.toFixed(6)} USDC |\n`;
  b += `\n`;
  if (!findings.length) {
    b += `_No findings._\n`;
    return b;
  }
  b += `### Findings\n\n`;
  const emoji = { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵' };
  const sorted = [...findings].sort((x, y) =>
    (severityRank[String(x.severity).toLowerCase()] ?? 9) - (severityRank[String(y.severity).toLowerCase()] ?? 9));
  for (const f of sorted) {
    const sev = String(f.severity || 'unknown').toLowerCase();
    const id = String(f.cwe_id ?? f.cwe ?? '').trim().toUpperCase();
    b += `- ${emoji[sev] || '⚪'} **${sev.toUpperCase()}** \`${f.file ?? '(unknown file)'}:${f.line ?? '?'}\``;
    if (id) b += ` \`${id}\``;
    b += ` — ${String(f.description ?? '').replace(/^\s*\[[a-z][a-z_]{1,24}\]\s*/i, '')}`;
    if (f.fix_suggestion) b += `\n  💡 ${f.fix_suggestion}`;
    b += `\n`;
  }
  b += `\n> Cost is a market-rate estimate of the tokens consumed. This pipeline ran\n`;
  b += `> locally in the CI runner — **nothing was charged**.\n`;
  return b;
};

// One note per pipeline, updated in place. A new note on every push is the
// pile-up this product spent a day removing, and on GitLab it is no cheaper
// than on GitHub.
const upsertNote = async (slug, body) => {
  const notes = await api('GET', `/projects/${project()}/merge_requests/${mergeRequest()}/notes?per_page=100`);
  const existing = notes.find((n) => typeof n.body === 'string' && n.body.includes(`<!-- am:${slug} -->`));
  if (existing) {
    try {
      await api('PUT', `/projects/${project()}/merge_requests/${mergeRequest()}/notes/${existing.id}`, { body });
      return 'updated';
    } catch {
      // Older GitLab versions expose the note under the project scope only.
      await api('PUT', `/projects/${project()}/notes/${existing.id}`, { body });
      return 'updated';
    }
  }
  await api('POST', `/projects/${project()}/merge_requests/${mergeRequest()}/notes`, { body });
  return 'created';
};

const main = async () => {
  // A file on disk wins: that is how the review is tested without a GitLab.
  let diff;
  let mr = { title: '', source: '', target: '' };
  if (process.env.DIFF_FILE) {
    diff = readFileSync(process.env.DIFF_FILE, 'utf-8');
  } else {
    const d = await diffOfMergeRequest();
    diff = d.diff;
    mr = d;
  }
  if (!diff.trim()) {
    console.log('empty diff — nothing to review');
    return;
  }
  const provider = process.env.MOCK === '1'
    // The same stub the CLI's `--mock` uses: the wiring can be tried without a
    // key and without spending anything. The findings are placeholders. The
    // name is the one the specs ask for, so the registry resolves them.
    ? { ...buildMockProvider(), name: 'minimax' }
    : new MiniMaxProvider({ apiKey: need('MINIMAX_API_KEY') });
  const deps = {
    provider,
    registry: new LLMProviderRegistry([provider]),
    pricing: new StaticPricingResolver({ 'MiniMax-M3': { input: 0.000002, output: 0.000008 } }),
    modelResolver: createModelResolver({ hardcodedDefault: 'MiniMax-M3' }),
    fetchSkill: async () => null,
    getCurrentAgentId: () => '0xcaller',
    getPipelineAuthorId: () => '0xauthor',
    isLocal: true,
  };

  let failed = false;
  for (const p of PIPELINES) {
    const { file, spec } = specOf(p.slug);
    const started = Date.now();
    let result;
    try {
      result = await runPipelineV2({
        spec,
        inputs: { code_diff: diff, language: 'generic', focus_area: p.focus, severity_threshold: p.severity },
        deps,
      });
    } catch (e) {
      failed = true;
      await upsertNote(p.slug,
        `<!-- am:${p.slug} -->\n## AI Review — ${p.label}\n\n` +
        `⚠️ **The review did not complete.** ${String(e.message).slice(0, 300)}\n\n` +
        `This is missing, not clean.\n`);
      console.error(`${p.slug}: ${e.message}`);
      continue;
    }
    const findings = findingsOf(result.outputs);
    const cost = Number(result.cost_usdc ?? result.total_cost_usdc ?? 0);
    const body = noteFor(p.slug, p.label, findings, cost, Date.now() - started);
    const how = await upsertNote(p.slug, body);
    console.log(`${p.slug} (${file}): ${findings.length} findings → note ${how}`);
  }
  if (failed) process.exitCode = 1;
};

// Run only when this file is the program, so a check can import the pure
// parts without starting a review.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
}
