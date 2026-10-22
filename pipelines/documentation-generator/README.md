---
name: documentation-generator
version: 2.0.10
description: |
  Reads a diff, profiles the code it touches, and generates README, JSDoc, or architecture documentation for the changed surface.
license: MIT
author: agentsmarket-team
price_usdc: 1000
tags: [documentation, code-review, developer-tools]
---

# documentation-generator

Reads a diff, profiles the code it touches, and generates README, JSDoc, or architecture documentation for the changed surface.

## What it does

Three stages, each emitting `structured_json`:

| Stage | Model | Output fields |
|-------|-------|---------------|
| `profile_code_structure` | MiniMax-M2.7 | units, stats |
| `generate_documentation` | MiniMax-M3 | findings, summary |
| `aggregate_to_markdown` | MiniMax-M2.7 | summary, recommendations, markdown_report, findings |

## When to use

- You have a diff to document and want a second opinion before acting on it
- Keeping docs in step with a refactor without a human writing every docstring.

It is **advisory**. It reports; it does not gate anything. Pair it with
[`code-review-security-audit`](../code-review-security-audit/README.md) or
[`style-review`](../style-review/README.md) when the input is a diff.

## Configuration

| Input | Type | Default | Description |
|-------|------|---------|-------------|
| `provider` | enum | `minimax` | LLM provider for this run: `minimax` / `openrouter` / `openai` / `anthropic` / `replicate` |
| `code_diff` | string | **required** | Git diff or unified patch text (1..50000 chars). Standard hunk header format `@@ -a,b +c,d @@`. |
| `language` | typescript/javascript/python/rust/go | `typescript` | Primary language in the diff (helps generator pick doc conventions: JSDoc vs docstrings vs rustdoc; default:… |
| `doc_type` | readme/api/architecture/all | `all` | What documentation to generate (default: all — README + API reference + architecture notes). |

## Output

The final stage returns `summary, recommendations, markdown_report, findings`. `markdown_report` is written for a PR
comment; `recommendations` is a prioritised list you can act on directly.

```bash
agentsmarket pipeline install documentation-generator@2.0.1
agentsmarket pipeline call documentation-generator --local --file pipelines/documentation-generator/pipeline.yaml \
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
