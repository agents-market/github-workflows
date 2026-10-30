#!/usr/bin/env node
// What style-review must NOT say.
//
//   node scripts/check-style-review.mjs [spec.yaml] [README.md]
//
// The pipeline posted five findings on a 75-line YAML diff in
// `web3eco/verification-tools#26`, and not one of them was a defect:
//
//   * "quote all scalar string values consistently" — the advice contradicts the
//     repository's own prettier config (one repo sets `singleQuote: true`, the
//     next leaves the default and gets double quotes), and the pipeline cannot
//     read either config;
//   * two findings about comment length and comment duplication — no repository
//     has such a rule, so the finding cites none;
//   * two "magic numbers" that were numbers inside prose in YAML comments.
//
// Each of those cost a human a reply and a resolve, because the org rule
// requires every thread to be resolved before merge. The pipeline cannot read a
// formatter's config, so the only honest answer is to say nothing about
// formatting; and a rule that needs a citation cannot be cited, so it must not
// be invented.
//
// This check reads the spec and the README and asserts the guardrails are
// still there. It is a text check, not a behaviour check: it cannot prove the
// model never says these things, only that it is no longer told to. The
// behaviour half was measured on the same diff — the old spec produced five
// findings, the new one produces none (see the commit message).
//
// The spec path is an argument so the check can be pointed at an old spec:
// on the old spec it fails, which is the only way to know it can fail.

import { existsSync, readFileSync } from 'node:fs';
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
const SPEC = process.argv[2] ?? join(HERE, '..', 'pipelines', 'style-review', 'pipeline.yaml');
const README = process.argv[3] ?? join(HERE, '..', 'pipelines', 'style-review', 'README.md');

let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    console.log(`ok   ${name}`);
  } else {
    failures++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

const spec = YAML.parse(readFileSync(SPEC, 'utf8'));
const stage = (id) => spec.stages?.find((s) => s.id === id) ?? {};
const analyze = stage('analyze_style');
const profile = stage('profile_style');
const analyzeText = `${analyze.system ?? ''}\n${analyze.prompt ?? ''}`;
const profileText = `${profile.system ?? ''}\n${profile.prompt ?? ''}`;

// 1. Formatting is the formatter's business. The pipeline cannot read a
//    prettier/eslint config, so any advice it gives about quoting is a guess
//    that is wrong in one of every two repositories.
{
  check('the analyzer tells the model that formatting belongs to the formatter',
    /Formatting belongs to the formatter/.test(analyzeText));
  check('the analyzer names the two configs that disagree',
    /singleQuote/.test(analyzeText) && /cannot read its configuration/.test(analyzeText));
  check('the analyzer does not mention quoting outside that rule',
    !/\bquote\b/i.test(String(analyze.system ?? '')),
    'the system prompt has no business talking about quoting at all');
}

// 2. `magic_numbers` is a rule about code. A number in a comment, a cron
//    expression, a version or a SHA prefix is prose the author already
//    explained next to itself.
{
  check('the analyzer confines magic numbers to executable code',
    /A number in prose is not a magic number/.test(analyzeText));
  check('the system prompt qualifies the magic-number rule',
    /magic numbers \(unexplained numeric literals > 1 digit in executable code\)/.test(
      String(analyze.system ?? '')),
    'the unqualified form is what fired on prose');
  check('the old unqualified phrasing is gone',
    !/unexplained numeric literals > 1 digit\)/.test(analyzeText));
  check('the profiler does not feed prose numbers to the analyzer as literals',
    /a number inside a comment is prose, not a literal/i.test(profileText));
}

// 3. A `comments` finding is actionable only against a named rule.
{
  check('the analyzer requires a rule for a comments finding',
    /must name the rule it violates/.test(analyzeText));
  check('the analyzer no longer asks for comments that lack context',
    !/inline comments lacking context/.test(analyzeText));
}

// 4. The README is the marketplace listing and ships in the bundle. If the
//    spec and the listing describe different pipelines, a consumer reads the
//    listing and expects the old behaviour.
{
  if (!existsSync(README)) {
    check('the style-review README exists', false, README);
  } else {
    const readme = readFileSync(README, 'utf8');
    // The README is wrapped by hand, so a phrase can straddle a line break.
    // Compare on collapsed whitespace.
    const flat = readme.replace(/\s+/g, ' ');
    check('the README has a section for what the pipeline does not report',
      /## What it does not report/.test(readme));
    check('the README states the formatting rule',
      /Formatting\.\*?\*?.*owned by the repository's formatter/.test(flat));
    check('the README states the prose-number rule',
      /A number in prose is not a magic number/.test(flat));
    check('the README states the named-rule rule',
      /must name the rule it violates/.test(flat));
  }
}

console.log(failures ? `\n${failures} checks failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
