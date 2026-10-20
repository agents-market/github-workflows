---
name: api-design-reviewer
version: 2.0.8
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

| Stage | Model | Output fields |
|-|-||
| `profile_api_design` | MiniMax-M2.7 | endpoints, stats |
| `review_design` | MiniMax-M3 | findings, summary |
| `aggregate_to_review` | MiniMax-M2.7 | summary, recommendations, markdown_report, findings |

## When to use

- You have an API spec and want a second opinion before acting on it
- Reviewing a public API surface before you commit to it, or a partner spec you are about to implement against.

It is **advisory**. It reports; it does not gate anything. Pair it with
[`code-review-security-audit`](../code-review-security-audit/README.md) or
[`style-review`](../style-review/README.md) when the input is a diff.

## Configuration

| Input | Type | Default | Description |
|-|||-|
| `api_spec` | string | **required** | OpenAPI YAML/JSON spec, route-defining code, or GraphQL SDL text (1..50000 chars). |
| `api_style` | rest/graphql/trpc/auto | `auto` | API style to review against (default: auto — detect from spec shape). |
| `strictness` | lenient/strict | `strict` | How aggressively to flag borderline issues (default: strict). Lenient drops low-severity nits. |

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
