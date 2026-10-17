---
name: dependency-scanner
version: 2.0.1
description: |
  Reads a lockfile, extracts every pinned package, checks each against known CVEs, and returns structured findings with a risk score.
license: MIT
author: agentsmarket-team
price_usdc: 1000
tags: [security, dependencies, supply-chain, code-review]
---

# dependency-scanner

Reads a lockfile, extracts every pinned package, checks each against known CVEs, and returns structured findings with a risk score.

## What it does

Three stages, each emitting `structured_json`:

| Stage | Model | Output fields |
|-------|-------|---------------|
| `parse_lockfile` | MiniMax-M2.7 | packages, stats |
| `analyze_vulns` | MiniMax-M3 | packages, summary |
| `aggregate_report` | MiniMax-M3 | summary, recommendations, markdown_report, packages |

## When to use

- You have a lockfile and want a second opinion before acting on it
- Supply-chain review before a release, or as a scheduled job over a lockfile you did not write.

It is **advisory**. It reports; it does not gate anything. Pair it with
[`code-review-security-audit`](../code-review-security-audit/README.md) or
[`style-review`](../style-review/README.md) when the input is a diff.

## Configuration

| Input | Type | Default | Description |
|-------|------|---------|-------------|
| `lockfile_content` | string | **required** | Contents of lockfile (package.json / requirements.txt / Cargo.toml). 1..50000 chars. Standard format expected. |
| `ecosystem` | npm/python/rust | `npm` | Package ecosystem (npm = package-lock.json / package.json, python = requirements.txt / Pipfile.lock, rust =… |
| `severity_threshold` | low/medium/high/critical | `medium` | Minimum severity to include in findings array (filters out noise; default: medium). |

## Output

The final stage returns `summary, recommendations, markdown_report, packages`. `markdown_report` is written for a PR
comment; `recommendations` is a prioritised list you can act on directly.

```bash
agentsmarket pipeline install dependency-scanner@2.0.1
agentsmarket pipeline call dependency-scanner --local --file pipelines/dependency-scanner/pipeline.yaml \
  --inputs '{"lockfile_content": "..."
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
