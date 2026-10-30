#!/usr/bin/env node
// A stage whose answer is not valid JSON must be retried, and a stage that
// keeps failing must fail loudly.
//
//   node scripts/check-output-retry.mjs
//
// On 2026-10-16 a dogfood run of code-review-security-audit died on a stage
// with this in the log:
//
//   ✗ pipeline failed [provider=minimax model=MiniMax-M3 context=imports]:
//     Output format violations:
//     $: LLM output is not valid JSON: Expected ',' or ']' after array element
//        in JSON at position 698 (line 1 column 699)
//
// The two other stages of that run had already been paid for, so the money
// was spent and the review never arrived.
//
// The runtime could not recover, and the reason is a single line of ordering:
// the output_format check used to throw from inside the stage body, before the
// output_retry loop was reached — so a malformed answer ended the stage on the
// first attempt and the correction the loop would have offered was never
// asked for. The fix is in pipeline-runtime 0.5.1
// ("output_retry could not recover an output_format failure"). This check
// proves the published runtime has it, and it fails on 0.5.0.
//
// The second half is the one the issue actually asks for: a stage that cannot
// be satisfied must fail. A security audit that returned "no findings" because
// its answer could not be parsed reads as "there are no vulnerabilities", and
// that is worse than a red run.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    console.log(`ok   ${name}`);
  } else {
    failures++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

// The runtime version that carries the fix. Below it, the retry loop is
// pre-empted by the output_format check, so a malformed answer ends the stage
// on the first attempt.
const MIN_RUNTIME = [0, 5, 1];

let runtimeVersion = '0.0.0';
try {
  runtimeVersion = require('@agentsmarket/pipeline-runtime/package.json').version;
} catch (e) {
  check('the published runtime is installed', false, String(e.message || e));
}
{
  const parts = runtimeVersion.split('.').map(Number);
  let ok = true;
  for (let i = 0; i < 3; i++) {
    const a = parts[i] ?? 0;
    if (a !== MIN_RUNTIME[i]) { ok = a > MIN_RUNTIME[i]; break; }
  }
  check(`the installed runtime can retry an output_format failure (>= ${MIN_RUNTIME.join('.')})`,
    ok, `installed ${runtimeVersion}`);
}

let YAML, runPipelineV2, LLMProviderRegistry, StaticPricingResolver, createModelResolver, buildMockProvider;
try {
  YAML = (await import('yaml')).default;
  ({ runPipelineV2 } = await import('@agentsmarket/pipeline-runtime/dist/stages.js'));
  ({ LLMProviderRegistry } = await import('@agentsmarket/pipeline-runtime/dist/provider-registry.js'));
  ({ StaticPricingResolver } = await import('@agentsmarket/pipeline-runtime/dist/pricing.js'));
  ({ createModelResolver } = await import('@agentsmarket/pipeline-runtime/dist/model-resolver.js'));
  ({ buildMockProvider } = await import('@agentsmarket/pipeline-runtime/dist/testing/index.js'));
} catch (e) {
  console.error(`the published runtime ${runtimeVersion} could not be loaded — npm install --no-save @agentsmarket/pipeline-runtime@latest yaml`);
  console.error(String(e.message || e));
  process.exit(1);
}

const SPEC = `
name: retry-probe
version: 1.0.0
inputs:
  provider:
    type: string
    required: false
    default: minimax
stages:
  - id: only
    provider: \${input.provider}
    model: MiniMax-M3
    prompt: "Return the findings."
    output_format: structured_json
    fields: [findings]
    output_schema:
      type: object
      required: [findings]
      properties:
        findings:
          type: array
          items: { type: object }
    output_retry: loop
`;

/** A provider that answers with `texts` in order, then repeats the last one. */
const answering = (texts) => {
  let calls = 0;
  const provider = {
    ...buildMockProvider(),
    name: 'minimax',
    async generateText() {
      const text = texts[Math.min(calls, texts.length - 1)];
      calls++;
      return { text, usage: { inputTokens: 10, outputTokens: 10 } };
    },
  };
  return { provider, calls: () => calls };
};

const depsFor = (provider) => ({
  provider,
  registry: new LLMProviderRegistry([provider]),
  pricing: new StaticPricingResolver({ 'MiniMax-M3': { input: 0.000002, output: 0.000008 } }),
  modelResolver: createModelResolver({ hardcodedDefault: 'MiniMax-M3' }),
  fetchSkill: async () => null,
  getCurrentAgentId: () => '0xcaller',
  getPipelineAuthorId: () => '0xauthor',
  isLocal: true,
});

const spec = YAML.parse(SPEC);
const VALID = JSON.stringify({ findings: [{ file: 'a.ts', line: 1 }] });
// The shape the log showed: an array element that was never closed.
const INVALID = '{"findings": [{"file": "a.ts", "line": 1}, {"file": "b.ts"}';

// 2. A malformed answer is retried, and the retry is what saves the run.
{
  const { provider, calls } = answering([INVALID, VALID]);
  let result = null;
  let failure = '';
  try {
    result = await runPipelineV2({ spec, inputs: { provider: 'minimax' }, deps: depsFor(provider) });
  } catch (e) {
    failure = String(e.message || e).slice(0, 300);
  }
  check('a stage whose answer is not valid JSON is retried, not lost', result !== null, failure);
  check('the malformed answer was tried more than once', calls() > 1, `${calls()} call(s)`);
  if (result) {
    let out = null;
    try { out = JSON.parse(result.outputs.only); } catch { /* reported below */ }
    check('the retried stage produces the answer it was asked for',
      Array.isArray(out?.findings) && out.findings.length === 1);
  }
}

// 3. A stage that keeps failing fails loudly — an empty result is not an answer.
{
  const { provider, calls } = answering([INVALID]);
  let result = null;
  let failure = '';
  try {
    result = await runPipelineV2({ spec, inputs: { provider: 'minimax' }, deps: depsFor(provider) });
  } catch (e) {
    failure = String(e.message || e).slice(0, 300);
  }
  check('a stage that cannot be satisfied does not return a result', result === null,
    result ? 'the run returned a result' : '');
  check('the failure names the output problem', /not valid JSON|output/i.test(failure), failure);
  check('the malformed answer was retried before giving up', calls() > 1, `${calls()} call(s)`);
}

console.log(failures ? `\n${failures} checks failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
