#!/usr/bin/env node
// What the autofix script does, checked against a throwaway repository.
//
//   node scripts/check-error-autofix.mjs
//
// The script under test is the one the workflow runs: it resolves a stack
// trace to files, and it applies the fix the pipeline proposed. Both halves
// are checked here, including the cases where the fix must NOT be applied —
// a snippet that is not in the file, a snippet that is in it twice, a test
// that would overwrite a file. A guard nobody checks is a guard that does not
// exist.
//
// The last check is the contract: the pipeline's spec and this script have to
// agree on the keys. When they do not, the script reads nothing, applies
// nothing and reports no error — the workflow opens an issue with no
// explanation and nobody can tell why.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The published runtime is what actually executes a pipeline, and the `yaml`
// package parses the spec. Both are installed by the smoke test:
//   npm install --no-save @agentsmarket/pipeline-runtime@latest yaml
let YAML, runPipelineV2, LLMProviderRegistry, StaticPricingResolver, createModelResolver, buildMockProvider;
try {
  YAML = (await import('yaml')).default;
  ({ runPipelineV2 } = await import('@agentsmarket/pipeline-runtime/dist/stages.js'));
  ({ LLMProviderRegistry } = await import('@agentsmarket/pipeline-runtime/dist/provider-registry.js'));
  ({ StaticPricingResolver } = await import('@agentsmarket/pipeline-runtime/dist/pricing.js'));
  ({ createModelResolver } = await import('@agentsmarket/pipeline-runtime/dist/model-resolver.js'));
  ({ buildMockProvider } = await import('@agentsmarket/pipeline-runtime/dist/testing/index.js'));
} catch (e) {
  console.error('the published runtime is not installed — npm install --no-save @agentsmarket/pipeline-runtime@latest yaml');
  console.error(String(e.message || e));
  process.exit(1);
}

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SCRIPT = join(HERE, 'error-autofix.mjs');
const SPEC = join(HERE, '..', 'pipelines', 'error-autofix', 'pipeline.yaml');

let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    console.log(`ok   ${name}`);
  } else {
    failures++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

const SOURCE = `export function getName(user) {
  const name = user.name;
  return name;
}
`;

const DUPLICATED = `export function twice(user) {
  const name = user.name;
  return name;
}

export function alsoTwice(user) {
  const name = user.name;
  return name;
}
`;

const RESULT = JSON.stringify({
  analysis: {
    error_class: 'TypeError',
    root_cause: 'user.name is read before the null check',
    file: 'src/users.ts',
    line: 2,
    explanation: 'getName() reads user.name directly.',
    fixable: true,
    confidence: 0.9,
  },
  fix: {
    file: 'src/users.ts',
    old_snippet: '  const name = user.name;',
    new_snippet: "  const name = user?.name ?? '';",
    explanation: 'Read the name through an optional chain.',
    test_path: 'tests/users.test.ts',
    test_content: "test('returns an empty name', () => {});",
    confidence: 0.9,
  },
});

const REPORT = "TypeError: Cannot read properties of null (reading 'name')\n    at getName (src/users.ts:2:18)";

/** A throwaway git repository with the files the stack traces point at. */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'autofix-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'tests'), { recursive: true });
  writeFileSync(join(dir, 'src/users.ts'), SOURCE);
  writeFileSync(join(dir, 'src/dup.ts'), DUPLICATED);
  writeFileSync(join(dir, 'tests/existing.test.ts'), 'test("kept", () => {});\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: dir });
  return dir;
}

/** Parse what a step wrote to $GITHUB_OUTPUT. */
function parseOutputs(text) {
  const out = {};
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const heredoc = lines[i].match(/^([^<]+)<<(.+)$/);
    if (heredoc) {
      const [, name, delimiter] = heredoc;
      const body = [];
      i++;
      while (i < lines.length && lines[i] !== delimiter) body.push(lines[i++]);
      out[name.trim()] = body.join('\n');
      continue;
    }
    const pair = lines[i].match(/^([^=]+)=(.*)$/);
    if (pair) out[pair[1].trim()] = pair[2];
  }
  return out;
}

let counter = 0;
/** Run the script and read what it wrote. Throws when the script fails. */
function run(command, repo, env) {
  const outFile = join(repo, `github-output-${command}-${counter++}`);
  const stdout = execFileSync('node', [SCRIPT, command, repo], {
    env: { ...process.env, GITHUB_OUTPUT: outFile, ...env },
    encoding: 'utf8',
  });
  return { outputs: parseOutputs(readFileSync(outFile, 'utf8')), stdout };
}

// 1. The stack trace becomes the pipeline's inputs.
{
  const repo = makeRepo();
  const { outputs } = run('sources', repo, { ERROR_REPORT: REPORT, REPO_CONTEXT: 'Node 20' });
  let payload = null;
  try { payload = JSON.parse(outputs.inputs_json); } catch { /* reported below */ }
  check('sources produces the pipeline inputs', payload !== null);
  if (payload) {
    check('the error report is passed on verbatim', payload.error_report === REPORT);
    check('the file the stack points at is passed on', Object.keys(payload.source_files).join() === 'src/users.ts');
    check('the file is passed on with its contents', (payload.source_files['src/users.ts'] || '').includes('user.name'));
    check('the repo context is passed on', payload.repo_context === 'Node 20');
  }
}

// 2. A stack that names no file in this checkout is not a fix.
{
  const repo = makeRepo();
  let failed = false;
  try {
    run('sources', repo, { ERROR_REPORT: 'Error: at /var/lib/other/missing.js:1:1' });
  } catch {
    failed = true;
  }
  check('a stack that names no file here fails loudly', failed);
}

// 3. The fix is applied, the test is written, the patch is real.
{
  const repo = makeRepo();
  const { outputs } = run('apply', repo, { STAGE_OUTPUT: RESULT, ERROR_REPORT: REPORT });
  check('a mechanical fix is ready for a pull request', outputs.pr_ready === 'true', `pr_ready=${outputs.pr_ready}`);
  const changed = readFileSync(join(repo, 'src/users.ts'), 'utf8');
  check('the old text is gone', !changed.includes('  const name = user.name;'));
  check('the new text is in the file', changed.includes("  const name = user?.name ?? '';"));
  check('the test is written', existsSync(join(repo, 'tests/users.test.ts')));
  check('the patch carries the change', (outputs.patch || '').includes('user?.name'));
  check('the patch carries the new file', (outputs.patch || '').includes('tests/users.test.ts'));
  check('the title names the file', (outputs.title || '').startsWith('fix(src/users.ts)'));
  check('the body carries the root cause', (outputs.body || '').includes('user.name is read before the null check'));
  check('the body carries the error', (outputs.body || '').includes('TypeError'));
  check('the branch is named after the error', /^fix\/auto-[0-9a-f]{8}$/.test(outputs.branch || ''));
}

// 4. A snippet that is not in the file is not applied.
{
  const repo = makeRepo();
  const result = JSON.parse(RESULT);
  result.fix.old_snippet = '  const name = user.nmae;';
  const { outputs } = run('apply', repo, { STAGE_OUTPUT: JSON.stringify(result), ERROR_REPORT: REPORT });
  check('a snippet that is not in the file is refused', outputs.pr_ready === 'false', `pr_ready=${outputs.pr_ready}`);
  check('the file is untouched', readFileSync(join(repo, 'src/users.ts'), 'utf8') === SOURCE);
  check('the patch is empty', (outputs.patch || '').trim() === '');
  check('the body says why there is no pull request', (outputs.body || '').includes('Why there is no pull request'));
  check('no test was written', !existsSync(join(repo, 'tests/users.test.ts')));
}

// 5. A snippet that is in the file twice is refused: which one is the fault
//    is not something the script can decide.
{
  const repo = makeRepo();
  const result = JSON.parse(RESULT);
  result.fix.file = 'src/dup.ts';
  const { outputs } = run('apply', repo, { STAGE_OUTPUT: JSON.stringify(result), ERROR_REPORT: REPORT });
  check('an ambiguous snippet is refused', outputs.pr_ready === 'false', `pr_ready=${outputs.pr_ready}`);
  check('the ambiguous file is untouched', readFileSync(join(repo, 'src/dup.ts'), 'utf8') === DUPLICATED);
}

// 6. A test that would overwrite a file is refused: a bot that deletes
//    somebody's test is worse than a bot that opens an issue.
{
  const repo = makeRepo();
  const result = JSON.parse(RESULT);
  result.fix.test_path = 'tests/existing.test.ts';
  const { outputs } = run('apply', repo, { STAGE_OUTPUT: JSON.stringify(result), ERROR_REPORT: REPORT });
  check('a test that would overwrite a file is refused', outputs.pr_ready === 'false', `pr_ready=${outputs.pr_ready}`);
  check('the existing test is untouched', readFileSync(join(repo, 'tests/existing.test.ts'), 'utf8') === 'test("kept", () => {});\n');
}

// 7. The contract: the spec and the script agree on the keys.
{
  const spec = YAML.parse(readFileSync(SPEC, 'utf8'));
  const script = readFileSync(SCRIPT, 'utf8');
  const last = spec.stages[spec.stages.length - 1];
  const fixSchema = last.output_schema?.properties?.fix;
  for (const key of ['error_report', 'source_files', 'repo_context']) {
    check(`the spec declares ${key}`, Boolean(spec.inputs?.[key]));
    check(`the script reads ${key}`, script.includes(key));
  }
  check('the spec produces the analysis the script reads', last.fields.includes('analysis'));
  check('the spec produces the fix the script reads', last.fields.includes('fix'));
  for (const key of ['file', 'old_snippet', 'new_snippet', 'test_path', 'test_content']) {
    check(`the fix schema requires ${key}`, Boolean(fixSchema?.required?.includes(key)));
    check(`the script reads the fix's ${key}`, script.includes(key));
  }
}

// 8. The pipeline runs, and the envelope it produces is the one the script
//    reads. The mock answers with values shaped by the spec's own schema, so
//    the run proves the schema is satisfiable — a schema no answer can meet
//    is a pipeline that fails on every call.
{
  const spec = YAML.parse(readFileSync(SPEC, 'utf8'));
  const fieldSchemas = {};
  for (const stage of spec.stages) {
    for (const [name, schema] of Object.entries(stage.output_schema?.properties || {})) {
      fieldSchemas[name] = schema;
    }
  }
  const provider = {
    ...buildMockProvider(),
    name: 'minimax',
    async generateText(prompt, opts) {
      const obj = {};
      for (const field of opts?.fields ?? []) obj[field] = shaped(fieldSchemas[field]);
      return { text: JSON.stringify(obj), usage: { inputTokens: 10, outputTokens: 10 } };
    },
  };
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
  let result = null;
  let failure = '';
  try {
    result = await runPipelineV2({
      spec,
      inputs: { error_report: REPORT, source_files: { 'src/users.ts': SOURCE }, repo_context: 'Node 20' },
      deps,
    });
  } catch (e) {
    failure = String(e.message || e).slice(0, 300);
  }
  check('the pipeline runs', result !== null, failure);
  if (result) {
    const last = spec.stages[spec.stages.length - 1].id;
    let out = null;
    try { out = JSON.parse(result.outputs[last]); } catch { /* reported below */ }
    check('the pipeline produces the analysis', out?.analysis && typeof out.analysis === 'object');
    check('the pipeline produces the fix', out?.fix && typeof out.fix === 'object');
    check('the fix carries the text to replace', typeof out?.fix?.old_snippet === 'string');
    check('the fix carries the text to put there', typeof out?.fix?.new_snippet === 'string');
    check('the fix carries the test', typeof out?.fix?.test_path === 'string');
  }
}

/**
 * A value that satisfies a JSON schema, so the mock answer passes validation.
 *
 * Built from `properties`, not from `required`: the prompt asks the model for
 * the properties, so the mock answers with the properties. A schema that
 * requires a key the prompt never mentions is a schema no answer can meet —
 * and the run below fails on it, which is the point.
 */
function shaped(schema) {
  if (!schema) return 'mock';
  switch (schema.type) {
    case 'object': {
      const obj = {};
      for (const key of Object.keys(schema.properties || {})) obj[key] = shaped(schema.properties[key]);
      return obj;
    }
    case 'array': return [];
    case 'integer':
    case 'number': return 1;
    case 'boolean': return true;
    default: return 'mock';
  }
}

console.log(failures ? `\n${failures} checks failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);