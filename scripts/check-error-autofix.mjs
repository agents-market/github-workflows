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

import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

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

// A minified bundle, and the two frames it produced: the first inside a
// dependency, the second in the consumer's own code. The columns are the
// ones the fixture bundle really has — checked against the reference
// implementation of source map v3.
const BUNDLE_STACK = [
  'TypeError: Failed to fetch',
  '    at e (https://app.test/js/app-7fJ3k2Q1.js:1:26)',
  '    at Module.u (https://app.test/js/app-7fJ3k2Q1.js:1:141)',
].join('\n');

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

/** Copy a fixture tree into the throwaway repository. */
function copyFixture(repo, name) {
  const from = join(HERE, '..', 'fixtures', name);
  for (const entry of readdirSync(from)) {
    cpSync(join(from, entry), join(repo, entry), { recursive: true });
  }
}

/** Parse what a step wrote to $GITHUB_OUTPUT. */function parseOutputs(text) {
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

/**
 * The same, but a failure is a failed check and not a crash.
 *
 * The command may not exist at all — a script that never learned it — and
 * the answer to that has to be a red line in the report, not a stack trace
 * that stops the rest of the checks from running.
 */
function tryRun(command, repo, env) {
  try {
    return { ...run(command, repo, env), failed: false };
  } catch (e) {
    return { outputs: {}, stdout: String(e.stderr || e.message || ''), failed: true };
  }
}

const execFileAsync = promisify(execFile);

/**
 * The same, without blocking.
 *
 * The checks that serve a map over HTTP need it: `execFileSync` blocks the
 * event loop, so the server in this process could not answer the script it
 * had just started.
 */
async function runAsync(command, repo, env) {
  const outFile = join(repo, `github-output-${command}-${counter++}`);
  await execFileAsync('node', [SCRIPT, command, repo], {
    env: { ...process.env, GITHUB_OUTPUT: outFile, ...env },
  });
  return { outputs: parseOutputs(readFileSync(outFile, 'utf8')) };
}

/** The same, without blocking, and a failure is a failed check. */
async function tryRunAsync(command, repo, env) {
  try {
    return { ...(await runAsync(command, repo, env)), failed: false };
  } catch (e) {
    return { outputs: {}, stdout: String(e.stderr || e.message || ''), failed: true };
  }
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

// 4. The stage output arrives escaped. The action writes what a workflow
//     output can hold — one line — so a newline becomes %0A. The model
//     writes its JSON over several lines as often as over one, and a
//     consumer that does not unescape it reads a value that cannot be
//     parsed: the run then says the pipeline named no file to change,
//     about a pipeline that named a file perfectly well.
{
  const repo = makeRepo();
  const pretty = JSON.stringify(JSON.parse(RESULT), null, 2);
  const escaped = pretty.replace(/%/g, '%25').replace(/\r?\n/g, '%0A');
  let parsesAsItStands = true;
  try { JSON.parse(escaped); } catch { parsesAsItStands = false; }
  check('the escaped stage output is not JSON as it stands', !parsesAsItStands);
  const { outputs } = tryRun('apply', repo, { STAGE_OUTPUT: escaped, ERROR_REPORT: REPORT });
  check('an escaped stage output is still a fix', outputs.pr_ready === 'true', `pr_ready=${outputs.pr_ready}`);
  check('the patch carries the change', (outputs.patch || '').includes('user?.name'));
}

// 5. A snippet that is not in the file is not applied.
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

// 6. A snippet that is in the file twice is refused: which one is the fault
//    is not something the script can decide.
{
  const repo = makeRepo();
  const result = JSON.parse(RESULT);
  result.fix.file = 'src/dup.ts';
  const { outputs } = run('apply', repo, { STAGE_OUTPUT: JSON.stringify(result), ERROR_REPORT: REPORT });
  check('an ambiguous snippet is refused', outputs.pr_ready === 'false', `pr_ready=${outputs.pr_ready}`);
  check('the ambiguous file is untouched', readFileSync(join(repo, 'src/dup.ts'), 'utf8') === DUPLICATED);
}

// 7. A test that would overwrite a file is refused: a bot that deletes
//    somebody's test is worse than a bot that opens an issue.
{
  const repo = makeRepo();
  const result = JSON.parse(RESULT);
  result.fix.test_path = 'tests/existing.test.ts';
  const { outputs } = run('apply', repo, { STAGE_OUTPUT: JSON.stringify(result), ERROR_REPORT: REPORT });
  check('a test that would overwrite a file is refused', outputs.pr_ready === 'false', `pr_ready=${outputs.pr_ready}`);
  check('the existing test is untouched', readFileSync(join(repo, 'tests/existing.test.ts'), 'utf8') === 'test("kept", () => {});\n');
}

// 8. The contract: the spec and the script agree on the keys.
{
  const spec = YAML.parse(readFileSync(SPEC, 'utf8'));
  const script = readFileSync(SCRIPT, 'utf8');
  const last = spec.stages[spec.stages.length - 1];
  const fixSchema = last.output_schema?.properties?.fix;
  for (const key of ['error_report', 'source_files', 'repo_context', 'playbook']) {
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

// 9. The pipeline runs, and the envelope it produces is the one the script
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
      inputs: {
        error_report: REPORT,
        source_files: { 'src/users.ts': SOURCE },
        repo_context: 'Node 20',
        playbook: { signature: 'Load failed', approach: 'Reload once.', files_hint: ['src/users.ts'], needs_location: false },
      },
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

// 10. The playbook: the consumer's own record of a known issue. When one
//    matches, it decides the files — that is how an error with no stack at
//    all ("Load failed") gets fixed.
{
  const repo = makeRepo();
  writeFileSync(join(repo, '.error-playbook.json'), JSON.stringify({
    issues: [{
      signature: 'Load failed',
      approach: 'Reload once when the dynamic import fails.',
      files_hint: ['src/users.ts'],
      needs_location: false,
    }],
  }));
  const { outputs } = run('sources', repo, { ERROR_REPORT: 'Load failed' });
  const payload = JSON.parse(outputs.inputs_json);
  check('the playbook entry reaches the pipeline', payload.playbook?.signature === 'Load failed');
  check('the approach reaches the pipeline', String(payload.playbook?.approach || '').includes('Reload once'));
  check('the playbook names the file the fix belongs in', Object.keys(payload.source_files).join() === 'src/users.ts');
  check('the playbook is reported back', String(outputs.playbook_json || '').includes('Load failed'));
}

// 11. A playbook that does not match leaves the pipeline alone.
{
  const repo = makeRepo();
  writeFileSync(join(repo, '.error-playbook.json'), JSON.stringify({
    issues: [{ signature: 'Load failed', approach: 'Reload once.', files_hint: ['src/users.ts'] }],
  }));
  const { outputs } = run('sources', repo, { ERROR_REPORT: REPORT });
  const payload = JSON.parse(outputs.inputs_json);
  check('a playbook that does not match stays out of the pipeline', Object.keys(payload.playbook || {}).length === 0);
  check('the file the stack points at is still the one', Object.keys(payload.source_files).join() === 'src/users.ts');
}

// 12. No playbook at all is normal, not an error.
{
  const repo = makeRepo();
  const { outputs } = run('sources', repo, { ERROR_REPORT: REPORT });
  const payload = JSON.parse(outputs.inputs_json);
  check('a repository without a playbook still works', Object.keys(payload.playbook || {}).length === 0);
}

// 13. A playbook that does not parse stops the run: a fix built on the
//     wrong playbook is worse than no fix.
{
  const repo = makeRepo();
  writeFileSync(join(repo, '.error-playbook.json'), '{not json');
  let failed = false;
  let message = '';
  try {
    run('sources', repo, { ERROR_REPORT: REPORT });
  } catch (e) {
    failed = true;
    message = String(e.stderr || e.message || '');
  }
  check('a playbook that does not parse fails loudly', failed);
  check('the failure says what is wrong', message.includes('not valid JSON'), message.slice(0, 160));
}

// 14. The known issue reaches the pull request: the reviewer has to see
//     that this error is one the consumer already wrote down.
{
  const repo = makeRepo();
  const { outputs } = run('apply', repo, {
    STAGE_OUTPUT: RESULT,
    ERROR_REPORT: REPORT,
    PLAYBOOK_JSON: JSON.stringify({ signature: 'Load failed', approach: 'Reload once.' }),
  });
  check('the body names the known issue', String(outputs.body || '').includes('Load failed'));
  check('the body carries the approach', String(outputs.body || '').includes('Reload once.'));
}

// 15. A minified bundle has no path to take: the position in it means
//     nothing without the source map. The frames are walked, the frame in
//     the dependency is skipped, and the consumer's own code is found.
{
  const repo = makeRepo();
  copyFixture(repo, 'source-map');
  const { outputs } = run('sources', repo, { ERROR_REPORT: BUNDLE_STACK, MAPS_DIR: 'maps' });
  const payload = JSON.parse(outputs.inputs_json);
  check('the bundle is resolved to the source file', Object.keys(payload.source_files).join() === 'src/app.js', Object.keys(payload.source_files).join());
  const locations = JSON.parse(outputs.location_json || '[]');
  check('the resolved line is the line the map says', locations[0]?.line === 7, JSON.stringify(locations));
  check('the resolution says where it came from', locations[0]?.via === 'source map');
}

// 16. No source map, no position. The run says that instead of guessing:
//     a bundle without a map has no line in it.
{
  const repo = makeRepo();
  copyFixture(repo, 'source-map');
  let failed = false;
  let message = '';
  try {
    run('sources', repo, { ERROR_REPORT: BUNDLE_STACK });
  } catch (e) {
    failed = true;
    message = String(e.stderr || e.message || '');
  }
  check('a bundle with no source map fails loudly', failed);
  check('the failure says the position was not resolved', message.includes('source map'), message.slice(0, 200));
}

// 17. The signature is the error's class, not this occurrence of it: the
//     same failure twice is one pull request, not two. The branch is named
//     after it, so the second run replaces the first one.
{
  const first = run('apply', makeRepo(), { STAGE_OUTPUT: RESULT, ERROR_REPORT: REPORT });
  const second = run('apply', makeRepo(), {
    STAGE_OUTPUT: RESULT,
    ERROR_REPORT: `${REPORT}\n    at later (src/users.ts:9:1)`,
  });
  check('the same error class gets the same branch', first.outputs.branch === second.outputs.branch,
    `${first.outputs.branch} vs ${second.outputs.branch}`);
  check('the signature is the class and the file', first.outputs.signature === 'TypeError@src/users.ts',
    String(first.outputs.signature));
  check('the body carries the signature marker', String(first.outputs.body || '').includes('<!-- error-signature: TypeError@src/users.ts -->'));
  check('the body carries the probe', String(first.outputs.body || '').includes('<!-- error-probe: TypeError: Cannot read properties of null'));
}

// 18. Another class is another thing to fix, and another pull request.
{
  const result = JSON.parse(RESULT);
  result.analysis.error_class = 'RangeError';
  const { outputs } = run('apply', makeRepo(), { STAGE_OUTPUT: JSON.stringify(result), ERROR_REPORT: REPORT });
  check('another class gets another signature', outputs.signature === 'RangeError@src/users.ts', String(outputs.signature));
}

// 19. A known issue is signed by its name, not by the file: the name is
//     what the error looks like in the feed of errors still firing.
{
  const { outputs } = run('apply', makeRepo(), {
    STAGE_OUTPUT: RESULT,
    ERROR_REPORT: REPORT,
    PLAYBOOK_JSON: JSON.stringify({ signature: 'Load failed', approach: 'Reload once.' }),
  });
  check('a known issue is signed by its name', outputs.signature === 'Load failed', String(outputs.signature));
  check('the probe is the name too', outputs.probe === 'Load failed', String(outputs.probe));
}

// 20. The map over a URL. The base is the directory the maps live in — a
//     deployment that keeps them under a prefix puts that prefix in the
//     base — and the maps are private, so the endpoint wants a token.
{
  const repo = makeRepo();
  copyFixture(repo, 'source-map');
  const map = readFileSync(join(repo, 'maps/js/app-7fJ3k2Q1.js.map'), 'utf8');
  const server = createServer((req, res) => {
    const authorized = req.headers.authorization === 'Bearer maps-key';
    if (authorized && req.url === '/private/maps/js/app-7fJ3k2Q1.js.map') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(map);
      return;
    }
    res.writeHead(404);
    res.end('no map here');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  // The server must not keep the process alive: `close()` alone waits for
  // the keep-alive socket the fetch left behind.
  server.unref();
  const base = `http://127.0.0.1:${server.address().port}/private/maps`;
  try {
    const { outputs } = await runAsync('sources', repo, {
      ERROR_REPORT: BUNDLE_STACK,
      MAPS_BASE_URL: base,
      MAPS_TOKEN: 'maps-key',
    });
    const locations = JSON.parse(outputs.location_json || '[]');
    check('the map is fetched over a URL', locations[0]?.file === 'src/app.js', JSON.stringify(locations));
    check('the position over a URL comes from the map', locations[0]?.line === 7);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

// 21. A map that needs a key the consumer did not give is a map that is
//     not there: the position is not resolved, and the run says so.
{
  const repo = makeRepo();
  copyFixture(repo, 'source-map');
  const server = createServer((req, res) => {
    if (req.headers.authorization === 'Bearer maps-key') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(readFileSync(join(repo, 'maps/js/app-7fJ3k2Q1.js.map'), 'utf8'));
      return;
    }
    res.writeHead(401);
    res.end('who are you');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  // The server must not keep the process alive: `close()` alone waits for
  // the keep-alive socket the fetch left behind.
  server.unref();
  const base = `http://127.0.0.1:${server.address().port}/private/maps`;
  let failed = false;
  let message = '';
  try {
    await runAsync('sources', repo, { ERROR_REPORT: BUNDLE_STACK, MAPS_BASE_URL: base });
  } catch (e) {
    failed = true;
    message = String(e.stderr || e.message || '');
  } finally {
    server.closeAllConnections();
    server.close();
  }
  check('a map that will not serve fails loudly', failed);
  check('the failure says the position was not resolved', message.includes('source map'), message.slice(0, 200));
}

// ---------------------------------------------------------------------------
// The policy around the bot.
//
// A `gh` of our own on the PATH answers these, so the rules can be seen
// working instead of described: one pull request per error class, a ceiling
// on how many fixes may be open at once, the issue that replaces a pull
// request the repository will not let us open, and the daily sweep that asks
// whether the merged fix stopped the error.
// ---------------------------------------------------------------------------

const PROBE = "TypeError: Cannot read properties of null (reading 'name')";
const PR_BODY = [
  'The fix.',
  '',
  '<!-- error-signature: TypeError@src/users.ts -->',
  `<!-- error-probe: ${PROBE} -->`,
].join('\n');

// A `gh` that answers from a state file and writes down what it was asked.
// The state is what GitHub would say; the log is what the script did.
const FAKE_GH = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.GH_STATE, 'utf8'));
fs.appendFileSync(process.env.GH_LOG, JSON.stringify(args) + '\\n');
const print = (value) => process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value));
const after = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
const kind = args[0];
const action = args[1];
if (kind === 'label' && action === 'create') { print('label created'); process.exit(0); }
if (kind === 'repo' && action === 'view') {
  // The real gh does not know --repo here: the repository is an argument.
  if (args.includes('--repo')) { process.stderr.write('unknown flag: --repo\\n'); process.exit(1); }
  print({ defaultBranchRef: { name: state.default_branch || 'main' } }); process.exit(0);
}
if (kind === 'pr' && action === 'list') {
  const head = after('--head');
  if (head) print((state.prs_by_head || {})[head] || []);
  else if (after('--state') === 'merged') print(state.merged_prs || []);
  else print(state.open_prs || []);
  process.exit(0);
}
if (kind === 'pr' && action === 'create') {
  if (state.pr_create_fails) {
    process.stderr.write('GraphQL: Resource not accessible by integration\\n');
    process.exit(1);
  }
  print('https://github.com/' + (after('--repo') || 'o/r') + '/pull/99');
  process.exit(0);
}
if (kind === 'issue' && action === 'list') { print(state.open_issues || []); process.exit(0); }
if (kind === 'issue' && action === 'create') { print('https://github.com/' + (after('--repo') || 'o/r') + '/issues/101'); process.exit(0); }
if ((kind === 'pr' || kind === 'issue') && action === 'comment') { print('commented'); process.exit(0); }
process.stderr.write('fake gh: unknown command: ' + args.join(' ') + '\\n');
process.exit(2);
`;

/** A `gh` on the PATH, answering from `state`. */
function fakeGh(state = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'autofix-gh-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const stateFile = join(dir, 'state.json');
  const logFile = join(dir, 'calls.log');
  writeFileSync(stateFile, JSON.stringify(state));
  writeFileSync(logFile, '');
  const path = join(bin, 'gh');
  writeFileSync(path, FAKE_GH);
  chmodSync(path, 0o755);
  return {
    env: { PATH: `${bin}:${process.env.PATH}`, GH_STATE: stateFile, GH_LOG: logFile },
    calls: () => readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)),
  };
}

/** The environment a publish/report run needs. */
const PUBLISH_ENV = {
  REPO: 'owner/repo',
  BRANCH: 'fix/auto-12345678',
  TITLE: 'fix(src/users.ts): the null user',
  BODY: PR_BODY,
  SIGNATURE: 'TypeError@src/users.ts',
};

// 22. A fix with no pull request yet opens one.
{
  const gh = fakeGh({});
  const { outputs } = tryRun('publish', makeRepo(), { ...gh.env, ...PUBLISH_ENV, MAX_OPEN_PRS: '3' });
  const calls = gh.calls();
  check('a fix with no pull request opens one', outputs.outcome === 'pr', String(outputs.outcome));
  check('the pull request is created', calls.some((c) => c[0] === 'pr' && c[1] === 'create'));
  check('the pull request carries the branch', calls.some((c) => c[0] === 'pr' && c[1] === 'create' && c.includes('fix/auto-12345678')));
  check('the pull request is labelled as the bot\'s', calls.some((c) => c[0] === 'pr' && c[1] === 'create' && c.includes('auto-fix')));
}

// 23. The pull request goes to the repository's default branch. The name of
//     the branch is not "main" in every repository, and a pull request aimed
//     at a branch that is not there is a pull request that cannot be opened.
{
  const gh = fakeGh({ default_branch: 'trunk' });
  tryRun('publish', makeRepo(), { ...gh.env, ...PUBLISH_ENV, MAX_OPEN_PRS: '3' });
  const created = gh.calls().find((c) => c[0] === 'pr' && c[1] === 'create');
  check('the pull request goes to the default branch', Boolean(created) && created.includes('trunk'),
    created ? created.join(' ') : 'no pull request was created');
}

// 24. The same error class does not open a second pull request: the branch is
//     named after the error, so the open one is updated instead.
{
  const gh = fakeGh({ prs_by_head: { 'fix/auto-12345678': [{ number: 7 }] } });
  const { outputs } = tryRun('publish', makeRepo(), { ...gh.env, ...PUBLISH_ENV, MAX_OPEN_PRS: '3' });
  const calls = gh.calls();
  check('the same error class does not open a second pull request', outputs.outcome === 'duplicate', String(outputs.outcome));
  check('no second pull request is created', !calls.some((c) => c[0] === 'pr' && c[1] === 'create'));
  check('the open pull request is told the error fired again', calls.some((c) => c[0] === 'pr' && c[1] === 'comment' && c.includes('7')));
}

// 25. The ceiling. A queue of fixes nobody merges is worth less than a queue
//     of issues somebody reads.
{
  const gh = fakeGh({ open_prs: [{ number: 1 }, { number: 2 }, { number: 3 }] });
  const { outputs } = tryRun('publish', makeRepo(), { ...gh.env, ...PUBLISH_ENV, MAX_OPEN_PRS: '3' });
  const calls = gh.calls();
  check('past the ceiling the fix becomes an issue', outputs.outcome === 'over-ceiling', String(outputs.outcome));
  check('no pull request is opened past the ceiling', !calls.some((c) => c[0] === 'pr' && c[1] === 'create'));
  check('the issue is labelled for a human', calls.some((c) => c[0] === 'issue' && c[1] === 'create' && c.includes('needs-review')));
}

// 26. A pull request the repository will not let us open. The fix is on the
//     branch either way, and a fix that is only on a branch is a fix that is
//     lost.
{
  const gh = fakeGh({ pr_create_fails: true });
  const { outputs } = tryRun('publish', makeRepo(), { ...gh.env, ...PUBLISH_ENV, MAX_OPEN_PRS: '3' });
  const calls = gh.calls();
  const issue = calls.find((c) => c[0] === 'issue' && c[1] === 'create');
  check('a pull request that cannot be opened becomes an issue', outputs.outcome === 'issue', String(outputs.outcome));
  check('the issue names the branch the fix is on', Boolean(issue) && issue.join(' ').includes('fix/auto-12345678'));
}

// 27. The two paths inside `publish` that file an issue file one issue per
//     error class too. An error that fires every hour is one issue, not one
//     per hour — and in a repository that does not let Actions open pull
//     requests, the fallback is the path every run takes.
{
  const tracked = { open_issues: [{ number: 5, body: '<!-- error-signature: TypeError@src/users.ts -->' }] };

  const fallback = fakeGh({ ...tracked, pr_create_fails: true });
  const fallbackRun = tryRun('publish', makeRepo(), { ...fallback.env, ...PUBLISH_ENV, MAX_OPEN_PRS: '3' });
  check('the fallback does not open a second issue for the same error class',
    fallbackRun.outputs.outcome === 'duplicate', String(fallbackRun.outputs.outcome));
  check('the fallback comments on the issue that is already open',
    fallback.calls().some((c) => c[0] === 'issue' && c[1] === 'comment' && c.includes('5')));
  check('the fallback creates no second issue',
    !fallback.calls().some((c) => c[0] === 'issue' && c[1] === 'create'));

  const ceiling = fakeGh({ ...tracked, open_prs: [{ number: 1 }, { number: 2 }, { number: 3 }] });
  tryRun('publish', makeRepo(), { ...ceiling.env, ...PUBLISH_ENV, MAX_OPEN_PRS: '3' });
  check('the ceiling does not open a second issue for the same error class',
    !ceiling.calls().some((c) => c[0] === 'issue' && c[1] === 'create'));
}

// 28. The same error class does not open a second issue either.
{
  const gh = fakeGh({ open_issues: [{ number: 5, body: '<!-- error-signature: TypeError@src/users.ts -->' }] });
  const { outputs } = tryRun('report', makeRepo(), { ...gh.env, ...PUBLISH_ENV });
  const calls = gh.calls();
  check('the same error class does not open a second issue', outputs.outcome === 'duplicate', String(outputs.outcome));
  check('no second issue is created', !calls.some((c) => c[0] === 'issue' && c[1] === 'create'));
  check('the open issue is told the error fired again', calls.some((c) => c[0] === 'issue' && c[1] === 'comment' && c.includes('5')));
}

// 29. An error nobody has an issue for opens one.
{
  const gh = fakeGh({ open_issues: [] });
  const { outputs } = tryRun('report', makeRepo(), { ...gh.env, ...PUBLISH_ENV });
  const calls = gh.calls();
  check('an error nobody has an issue for opens one', outputs.outcome === 'issue', String(outputs.outcome));
  check('the issue is labelled for a human', calls.some((c) => c[0] === 'issue' && c[1] === 'create' && c.includes('needs-review')));
}

// 30. The daily sweep: the merged fix did not stop the error.
{
  const gh = fakeGh({ merged_prs: [{ number: 3, body: PR_BODY }] });
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`still failing: ${PROBE}\n`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  try {
    const { outputs } = await tryRunAsync('sweep', makeRepo(), {
      ...gh.env,
      REPO: 'owner/repo',
      ERROR_FEED_URL: `http://127.0.0.1:${server.address().port}/errors`,
    });
    const calls = gh.calls();
    check('an error that is still firing opens an issue', outputs.opened === '1', String(outputs.opened));
    check('the issue names the pull request that did not fix it', calls.some((c) => c[0] === 'issue' && c[1] === 'create' && c.join(' ').includes('#3')));
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

// 31. The merged fix stopped the error: nothing to say.
{
  const gh = fakeGh({ merged_prs: [{ number: 3, body: PR_BODY }] });
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('nothing is failing right now\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  try {
    const { outputs } = await tryRunAsync('sweep', makeRepo(), {
      ...gh.env,
      REPO: 'owner/repo',
      ERROR_FEED_URL: `http://127.0.0.1:${server.address().port}/errors`,
    });
    check('a fixed error opens nothing', outputs.opened === '0', String(outputs.opened));
    check('no issue is opened for a fixed error', !gh.calls().some((c) => c[0] === 'issue' && c[1] === 'create'));
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

// 32. A feed that does not answer. An empty feed would say every error
//     stopped firing, and that is the one answer that must never be invented.
{
  const gh = fakeGh({ merged_prs: [{ number: 3, body: PR_BODY }] });
  const { failed, stdout } = await tryRunAsync('sweep', makeRepo(), {
    ...gh.env,
    REPO: 'owner/repo',
    ERROR_FEED_URL: 'http://127.0.0.1:1/errors',
  });
  const message = stdout;
  check('a feed that does not answer fails the sweep', failed);
  check('the failure says the fixes were not checked', message.includes('did not answer'), message.slice(0, 200));
  check('a feed that does not answer opens no issue', !gh.calls().some((c) => c[0] === 'issue' && c[1] === 'create'));
}

// 33. The contract: the workflow files call commands that exist. A command
//     that does not exist is a job that fails for everybody who pastes the
//     file, and the person who pasted it cannot tell the fault is ours.
{
  let usage = '';
  try {
    execFileSync('node', [SCRIPT], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    usage = String(e.stderr || '');
  }
  const dir = join(HERE, '..', 'workflows');
  const files = readdirSync(dir).filter((name) => name.endsWith('.yml'));
  let checked = 0;
  for (const file of files) {
    const text = readFileSync(join(dir, file), 'utf8');
    for (const [, command] of text.matchAll(/error-autofix\.mjs"\s+(\w+)/g)) {
      checked++;
      check(`${file} calls a command that exists: ${command}`, usage.includes(command));
    }
  }
  check('the workflows call the script at all', checked > 0, `${checked} calls`);
}

console.log(failures ? `\n${failures} checks failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);