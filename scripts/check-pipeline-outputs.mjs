#!/usr/bin/env node
// What a pipeline must not drop between its last stage and its caller.
//
//   node scripts/check-pipeline-outputs.mjs [spec.yaml ...]
//
// `code-review-security-audit` produced a `markdown_report`: the last stage
// declared it, the pipeline's own `test.yaml` asserted it, and the README
// showed it in the output envelope. The pipeline did not expose it. Every
// caller that asked for `report.markdown_report` — the consumer in
// `web3eco/shared-actions` among them — got nothing, and wrote the fallback
// string into every PR comment.
//
// The drop was invisible. The stage ran, the test passed, the README was
// right, and the catalogue served a pipeline that threw a field away on the
// way out. Nothing in the spec said the field had to be reachable.
//
// This check reads the spec and asserts that every field the last stage
// produces is reachable through the pipeline's `outputs`. The spec path is an
// argument so the check can be pointed at an old spec: on the old spec it
// fails, which is the only way to know that it can fail.
//
// It is a shape check, not a behaviour check. It cannot prove the model
// writes a report; it proves the pipeline does not throw the report away.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

let YAML;
try {
  YAML = (await import('yaml')).default;
} catch (e) {
  console.error('the yaml package is not installed — npm install --no-save yaml');
  console.error(String(e.message || e));
  process.exit(1);
}

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = join(HERE, '..');

// The shape of `fields` is not the same in every pipeline: a list in most of
// them, a map of field name to type in dependency-scanner. Both name fields.
const fieldNames = (fields) => {
  if (Array.isArray(fields)) return fields;
  if (fields && typeof fields === 'object') return Object.keys(fields);
  return [];
};

function defaultSpecs() {
  return [
    'code-review-security-audit',
    'style-review',
    'dependency-scanner',
    'api-design-reviewer',
    'documentation-generator',
    'test-generator',
    'error-autofix',
  ].map((slug) => join(REPO, 'pipelines', slug, 'pipeline.yaml'));
}

const specs = process.argv.slice(2);
const paths = specs.length ? specs : defaultSpecs();

let failures = 0;

for (const path of paths) {
  const parts = path.split('/');
  const at = parts.lastIndexOf('pipelines');
  const slug = at >= 0 ? parts[at + 1] : parts[parts.length - 1].replace(/\.ya?ml$/, '');
  const spec = YAML.parse(readFileSync(path, 'utf8'));

  const stages = spec.stages ?? [];
  const last = stages[stages.length - 1];
  if (!last) {
    console.log(`ok   ${slug}: no stages, nothing to expose`);
    continue;
  }

  const produced = new Set(fieldNames(last.fields));
  const exposed = new Set();
  for (const output of Object.values(spec.outputs ?? {})) {
    for (const field of fieldNames(output.fields)) exposed.add(field);
  }

  const dropped = [...produced].filter((f) => !exposed.has(f));

  if (dropped.length) {
    failures++;
    console.log(
      `FAIL ${slug}: the last stage (${last.id}) produces ${dropped.join(', ')}, ` +
        'but the pipeline does not expose it — a caller cannot read what the pipeline produced'
    );
  } else {
    console.log(`ok   ${slug}: ${last.id} produces ${[...produced].join(', ') || 'nothing'}, all exposed`);
  }
}

if (failures) {
  console.log(`\n${failures} pipeline(s) drop a field their last stage produces.`);
  process.exit(1);
}
console.log('\nOK: every pipeline exposes what its last stage produces.');
