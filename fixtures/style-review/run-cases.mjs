#!/usr/bin/env node
// Runs a style-review spec over the case corpus in this folder and writes one
// JSON file.
//
//   npm install --no-save --no-audit --no-fund @agentsmarket/pipeline-runtime@latest
//   MINIMAX_API_KEY=... node fixtures/style-review/run-cases.mjs \
//     --spec pipelines/style-review/pipeline.yaml --repeats 2 --out /tmp/sr.json
//
// The spec is executed by the real runtime, so the measurement covers the
// stages, the model and the runtime — not a re-implementation of them. The
// model is the spec's own default (MiniMax-M3) and the key comes from the
// environment, never from argv.
//
// `--category-thresholds` is passed to the spec as the `category_thresholds`
// input, and only if the spec declares it: an unknown input would add a line
// to the `Inputs:` block every stage receives, which is a change in the
// prompt and would make the baseline a different pipeline.
//
// Every run records what the analyzer stage reported, so a run can be checked
// against cases/expected.md instead of counted.

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

const specPath = resolve(arg('spec', 'pipelines/style-review/pipeline.yaml'));
const repeats = Number(arg('repeats', '2'));
const outPath = arg('out', 'style-review-cases.json');
const categoryThresholds = arg('category-thresholds', '');

const apiKey = process.env.MINIMAX_API_KEY;
if (!apiKey) {
  console.error('MINIMAX_API_KEY is not set');
  process.exit(1);
}

const spec = loadPipelineYaml(readFileSync(specPath, 'utf8'));
const provider = new MiniMaxProvider({ apiKey });
const registry = new LLMProviderRegistry([provider]);
const pricing = createDefaultPricingResolver({});
const modelResolver = createModelResolver({});

const results = {
  spec: specPath,
  spec_version: spec.version,
  category_thresholds: categoryThresholds,
  repeats,
  cases: [],
};

for (const file of readdirSync(CASES).filter((f) => f.endsWith('.diff')).sort()) {
  const code_diff = readFileSync(join(CASES, file), 'utf8');
  const entry = { id: file.replace(/\.diff$/, ''), runs: [] };
  results.cases.push(entry);

  for (let n = 1; n <= repeats; n++) {
    const inputs = {
      code_diff,
      language: 'typescript',
      focus_area: 'all',
      severity_threshold: 'low',
      provider: 'minimax',
      model: 'MiniMax-M3',
    };
    if (spec.inputs && 'category_thresholds' in spec.inputs) {
      inputs.category_thresholds = categoryThresholds;
    }

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

        let findings = [];
        let parseError = null;
        try {
          findings = JSON.parse(result.outputs.analyze_style ?? '{}').findings ?? [];
        } catch (e) {
          parseError = String(e.message ?? e);
        }

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
          findings: findings.map((f) => ({
            file: f.file,
            line: f.line,
            severity: f.severity,
            category: f.category,
            description: f.description,
            confidence: f.confidence,
          })),
          parse_error: parseError,
        });
        console.error(
          `[${entry.id}] #${n}: ${findings.length} findings, $${(result.totalCostMicroUsdc / 1e6).toFixed(5)}`
        );
        lastError = null;
        break;
      } catch (e) {
        lastError = String(e.message ?? e);
        console.error(`[${entry.id}] #${n}: attempt ${attempt} failed — ${lastError.slice(0, 120)}`);
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
    if (lastError) entry.runs.push({ n, error: lastError });
  }
}

writeFileSync(outPath, JSON.stringify(results, null, 2));
console.error(`written ${outPath}`);
