---
name: test-generator
version: 2.0.4
description: |
  Reads a diff, profiles the functions it changes, and generates test cases in the project’s own framework, targeting branches or lines.
license: MIT
author: agentsmarket-team
price_usdc: 1000
tags: [testing, code-review, developer-tools]
---

# test-generator

Reads a diff, profiles the functions it changes, and generates test cases in the project’s own framework, targeting branches or lines.

## What it does

Three stages, each emitting `structured_json`:

| Stage | Model | Output fields |
|-------|-------|---------------|
| `profile_code_behavior` | MiniMax-M2.7 | functions, stats |
| `generate_tests` | MiniMax-M3 | test_cases, summary |
| `aggregate_to_test_file` | MiniMax-M2.7 | summary, recommendations, markdown_report, findings, generated_test_code |

## When to use

- You have a diff to test and want a second opinion before acting on it
- Getting a changed function under test first, then letting a human judge whether the cases are worth keeping.

It is **advisory**. It reports; it does not gate anything. Pair it with
[`code-review-security-audit`](../code-review-security-audit/README.md) or
[`style-review`](../style-review/README.md) when the input is a diff.

## Configuration

| Input | Type | Default | Description |
|-------|------|---------|-------------|
| `code_diff` | string | **required** | Git diff or unified patch text (1..50000 chars). Standard hunk header format `@@ -a,b +c,d @@`. |
| `language` | typescript/javascript/python/rust/go | `typescript` | Primary language in the diff (drives framework detection and test syntax; default: typescript). |
| `test_framework` | vitest/jest/pytest/auto | `auto` | Test framework to generate for (auto = detect from imports: vitest/jest for TS/JS, pytest for Python;… |
| `coverage_target` | branches/lines/all | `all` | What the generator should prioritize covering (default: all). |

## Output

The final stage returns `summary, recommendations, markdown_report, findings, generated_test_code`. `markdown_report` is written for a PR
comment; `recommendations` is a prioritised list you can act on directly.

```bash
agentsmarket pipeline install test-generator@2.0.1
agentsmarket pipeline call test-generator --local --file pipelines/test-generator/pipeline.yaml \
  --inputs '{"code_diff": "..."
  }'
```

## Pricing and cost

`$1.000 USDC` per invocation. The spec caps a
single run at `$1.00 USDC` and fails rather than
exceeding it (`on_exceed: fail`).

Verified end-to-end against a real MiniMax-M3 on 2026-10-17: three stages, about
10 s, roughly $0.01 of real model spend.

## License

MIT — see [`LICENSE`](../../LICENSE) in the repo root.
