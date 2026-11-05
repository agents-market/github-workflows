#!/usr/bin/env node
// Runs a code-review-security-audit spec over the case corpus in this folder
// and writes one JSON file.
//
//   npm install --no-save --no-audit --no-fund @agentsmarket/pipeline-runtime@latest
//   MINIMAX_API_KEY=... node fixtures/security-audit/run-cases.mjs \
//     --spec pipelines/code-review-security-audit/pipeline.yaml --repeats 3 \
//     --out /tmp/sa.json
//
// The spec is executed by the real runtime, so the measurement covers the
// stages, the model and the runtime — not a re-implementation of them. The
// model is the spec's own default (MiniMax-M3) and the key comes from the
// environment, never from argv.
//
// Every run records what the audit reported, so a run can be checked against
// cases/expected.json instead of counted.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const {
  loadPipelineYaml,
  runPipelineV2,
  MiniMaxProvider,
  createModelResolver,
  createDefaultPricingResolver,
  LLMProviderRegistry,
} = await import('@agentsmarket/pipeline-runtime');

const HERE = dirname(fileURLToPath(import.meta.url));
const CASES = join(HERE, 'cases');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const specPath = resolve(arg('spec', 'pipelines/code-review-security-audit/pipeline.yaml'));
const repeats = Number(arg('repeats', '3'));
const outPath = arg('out', 'security-audit-cases.json');
const only = arg('only', '');

const apiKey = process.env.MINIMAX_API_KEY;
if (!apiKey) {
  console.error('MINIMAX_API_KEY is not set');
  process.exit(1);
}

const expected = JSON.parse(readFileSync(join(CASES, 'expected.json'), 'utf8')).cases || {};
const spec = loadPipelineYaml(readFileSync(specPath, 'utf8'));
const provider = new MiniMaxProvider({ apiKey });
const registry = new LLMProviderRegistry([provider]);
const pricing = createDefaultPricingResolver({});
const modelResolver = createModelResolver({});

const results = {
  spec: specPath,
  spec_version: spec.version,
  repeats,
  cases: [],
};

/** The findings of one stage output, or [] when the stage said nothing. */
function findingsOf(text) {
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.findings)) return parsed.findings;
  } catch {
    return [];
  }
  return [];
}

/** The candidates of the first stage, or [] when it said nothing. */
function candidatesOf(text) {
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed?.candidates)) return parsed.candidates;
  } catch {
    return [];
  }
  return [];
}

for (const file of readdirSync(CASES).filter((f) => f.endsWith('.diff')).sort()) {
  const id = file.replace(/\.diff$/, '');
  if (only && id !== only) continue;
  const code_diff = readFileSync(join(CASES, file), 'utf8');
  const entry = { id, runs: [] };
  results.cases.push(entry);

  for (let n = 1; n <= repeats; n++) {
    const inputs = {
      code_diff,
      language: expected[id]?.language || 'typescript',
      focus_area: 'security',
      severity_threshold: 'low',
      provider: 'minimax',
      model: 'MiniMax-M3',
    };

    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const started = Date.now();
      try {
        const result = await runPipelineV2({
          spec: {
            name: spec.name,
            version: spec.version ?? '0.0.0',
            defaults: spec.defaults,
            stages: spec.stages,
          },
          inputs,
          deps: {
            provider,
            registry,
            pricing,
            modelResolver,
            fetchSkill: async () => null,
            getCurrentAgentId: () => '0xfixture',
            getPipelineAuthorId: () => '0xfixture',
            isLocal: true,
          },
        });

        // The two review stages are one review in two passes; the caller
        // merges them, so the measurement merges them too.
        const findings = [
          ...findingsOf(result.outputs?.deep_review),
          ...findingsOf(result.outputs?.gap_review),
        ];

        // The cheap stage runs first and is supposed to hand the review
        // stages a shortlist. What it actually hands them is recorded here:
        // without it, "the pre-filter does not narrow" is a story, and the
        // story may be wrong — the filter may simply find nothing.
        const candidates = candidatesOf(result.outputs?.pattern_scan);

        entry.runs.push({
          n,
          attempt,
          ms: Date.now() - started,
          cost_usdc: result.totalCostMicroUsdc / 1e6,
          stages: result.stageTimings.map((s) => ({
            id: s.id,
            ms: s.ms,
            cost_usdc: s.costMicroUsdc / 1e6,
            model: s.model,
          })),
          candidates: candidates.map((c) => ({
            file: c.file ?? null,
            line: c.line ?? null,
            severity: c.severity ?? null,
            description: String(c.description ?? '').slice(0, 240),
          })),
          // The scanner's own words. An empty candidate list and an output
          // that could not be read look the same in `candidates`; only the
          // raw text tells them apart.
          pattern_scan_raw: result.outputs?.pattern_scan ?? '',
          findings: findings.map((f) => ({
            file: f.file ?? null,
            line: f.line ?? null,
            severity: f.severity ?? null,
            cwe: f.cwe_id ?? null,
            description: String(f.description ?? '').slice(0, 240),
            confidence: f.confidence ?? null,
          })),
        });
        console.error(
          `[${id}] #${n}: ${findings.length} findings, $${(result.totalCostMicroUsdc / 1e6).toFixed(5)}`
        );
        lastError = null;
        break;
      } catch (e) {
        lastError = String(e.message ?? e);
        console.error(`[${id}] #${n}: attempt ${attempt} failed — ${lastError.slice(0, 120)}`);
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
    if (lastError) entry.runs.push({ n, error: lastError });
  }
}

writeFileSync(outPath, JSON.stringify(results, null, 2));
console.error(`written ${outPath}`);
