---
name: api-design-reviewer
version: 2.0.14
description: |
  Reads an API spec, profiles its endpoints, and reviews the design for consistency, versioning, error contracts, and pagination.
license: MIT
author: agentsmarket-team
price_usdc: 1000
tags: [api, design, review, code-review]
---

# api-design-reviewer

Reads an API spec, profiles its endpoints, and reviews the design for consistency, versioning, error contracts, and pagination.

## What it does

Three stages, each emitting `structured_json`:

| Stage | Output fields |
|-------|---------------|
| `profile_api_design` | endpoints, stats |
| `review_design` | findings, summary |
| `aggregate_to_review` | summary, recommendations, markdown_report, findings |

Every stage runs on the `model` input — `MiniMax-M3` by default.

## When to use

- You have an API spec and want a second opinion before acting on it
- Reviewing a public API surface before you commit to it, or a partner spec you are about to implement against.

It is **advisory**. It reports; it does not gate anything. Pair it with
[`code-review-security-audit`](../code-review-security-audit/README.md) or
[`style-review`](../style-review/README.md) when the input is a diff.

## Configuration

| Input | Type | Default | Description |
|-------|------|---------|-------------|
| `api_spec` | string | **required** | OpenAPI YAML/JSON spec, route-defining code, or GraphQL SDL text (1..50000 chars). |
| `api_style` | rest/graphql/trpc/auto | `auto` | API style to review against (default: auto — detect from spec shape). |
| `strictness` | lenient/strict | `strict` | How aggressively to flag borderline issues (default: strict). Lenient drops low-severity nits. |
| `provider` | enum | `minimax` | `minimax` / `openrouter` / `openai` / `anthropic` / `replicate` — the LLM provider for this run |
| `model` | string | `MiniMax-M3` | The LLM model for this run — must be one the chosen provider carries |

The action runs what the caller passes — it does not read a spec's declared
defaults — so pass both values in `inputs_json`, and give the action's own
`provider:` and `model:` inputs the same two values. The action registers one
provider, and a stage that asks for another one is refused.

## Output

The final stage returns `summary, recommendations, markdown_report, findings`. `markdown_report` is written for a PR
comment; `recommendations` is a prioritised list you can act on directly.

```bash
agentsmarket pipeline install api-design-reviewer@2.0.1
agentsmarket pipeline call api-design-reviewer --local --file pipelines/api-design-reviewer/pipeline.yaml \
  --inputs '{"api_spec": "..."
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
