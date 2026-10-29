---
name: style-review
version: 3.3.3
description: |
  AI-powered code style review for diffs. Identifies naming inconsistencies,
  missing types, unused exports, magic numbers, and codebase-pattern violations.
  Outputs structured findings with severity + line + category + fix suggestion
  + estimated impact. Vertical wedge expansion: code style review as paid AI
  Free to download; a server call costs the tokens it uses.
license: MIT
author: agentsmarket-team
price_usdc: 0
call_price_usdc: 0
tags: [style, code-review, vertical-wedge]
public_preview: AI code style review of diffs. Structured findings (severity + category + fix + impact), aggregate style score 0-10, prioritized refactors. Free to download; a call costs the tokens it uses.
---

# style-review

AI-powered **code style review** for pull request diffs. The fourth wedge in the
agents-market vertical-wedge expansion path (after `code-review-security-audit`,
`dependency-scanner`, `performance-review`).

## What it does

Given a unified diff and a few configuration knobs, `style-review` runs a
3-stage AI pipeline:

1. **`profile_style`** — quick scan of the diff to identify style patterns:
   naming, type annotations, exported symbols, numeric/string literals.
2. **`analyze_style`** — for each region, emit structured findings with
   severity (critical / high / medium / low), category (naming, types,
   exports, magic_numbers, comments), description, fix suggestion, and
   estimated impact.
3. **`aggregate_style`** — compute aggregate counts, a `style_score` (0-10),
   ≤5 prioritized recommendations, and a markdown report suitable for a PR
   comment.

## When to use

- **TypeScript / React projects** adopting strict conventions
- **Monorepos** with shared style rules across packages
- **OSS libraries** where consistency with existing patterns matters
- **Style nits** that humans skip but CI can flag cheaply

The pipeline is intentionally **advisory**: it surfaces findings without
blocking the merge. Pair it with `code-review-security-audit` to cover both
security and style in the same PR.

## Configuration

| Input | Type | Default | Description |
|-------|------|---------|-------------|
| `code_diff` | string (1..50000 chars) | **required** | Git diff or unified patch text |
| `language` | enum | `generic` | `typescript` / `javascript` / `python` / `rust` / `go` / `solidity` / `generic` |
| `focus_area` | enum | `all` | `naming` / `types` / `exports` / `magic_numbers` / `all` |
| `severity_threshold` | enum | `low` | `low` / `medium` / `high` / `critical` — drop findings below this floor |
| `provider` | enum | `minimax` | `minimax` / `openrouter` / `openai` / `anthropic` / `replicate` — the LLM provider for this run |
| `model` | string | `MiniMax-M3` | The LLM model for this run — must be one the chosen provider carries |

## Output envelope

```json
{
  "summary": {
    "style_score": 4
  },
  "recommendations": [
    "Escape user input in renderPage to prevent XSS (CWE-79)",
    "De-duplicate MAX_RETRIES constant — extract to shared module",
    "Rename format_date → formatDate (snake_case → camelCase)",
    ...
  ],
  "markdown_report": "## Style Review\n\n...",
  "findings": [
    {
      "file": "src/utils/format.ts",
      "line": 23,
      "severity": "critical",
      "category": "comments",
      "description": "Unescaped user input passed to renderPage (potential XSS)",
      "fix_suggestion": "Use DOMPurify or React's default escaping instead of innerHTML",
      "estimated_impact": "Prevents CWE-79 XSS vulnerability",
      "confidence": 0.95
    }
  ]
}
```

Every finding includes explicit `file` + `line` so the wrapper can post
inline PR comments at the right location (see the
[agents-market/pipeline-action](https://github.com/agents-market/pipeline-action)
README for the GitHub Actions wiring).

## Breaking change in 3.0.0

**The pipeline no longer counts findings.** `summary` is now `{style_score}` and
nothing else, and `profile_style` no longer returns `stats`.

Why: a model asked to count a list it is writing gets it wrong — one run in ten
said "8 findings" over ten — and a wrong count is worse than no count. Count the
`findings` array yourself, or read `findings_count_json` from the action, which
computes it in code.

## What changed in 3.2.0

**One issue, one comment.** The aggregate stage emitted its own copy of the
findings array, re-derived from the analyze stage's output. The two copies
disagreed on line numbers, so the consumer's merge — which drops a finding
that repeats at the same file and line — kept both, and the reader got every
issue twice. A measured run on a 106-line diff produced 22 comments for
about eleven issues; the same complaint ("no type annotation") appeared five
times, at 99% confidence each.

The aggregate stage now copies the analyze stage's findings verbatim, and the
analyze stage is told that two findings with one cause are one finding.

## Installation

```bash
agentsmarket pipeline install style-review
# → creates .agentsmarket/pipelines/style-review@<version>/{pipeline.yaml, README.md, metadata.json}
```

Without a version this installs the latest release. To pin one for reproducible
builds, ask the catalogue what the current version is:

```bash
agentsmarket pipeline info style-review
```

`MINIMAX_API_KEY` in the environment. The provider is the `provider` input
(`minimax` by default); the model stays MiniMax-M3.

## Usage in GitHub Actions

```yaml
- name: Install pipeline
  run: agentsmarket pipeline install style-review@<version>   # the version you verified
  env:
    AGENTSMARKET_PRIVATE_KEY: ${{ secrets.PUBLISH_KEY }}

- name: Run style review
  uses: agents-market/pipeline-action@0ab99cfca4566494f6d84d4e0b08fd11a3bf6c21 # v0.4.12 (merges input defaults; validates output locally)
  env:
    MINIMAX_API_KEY: ${{ secrets.MINIMAX_API_KEY }}
  with:
    # The action runs what the caller passes; it does not read a spec's defaults.
    provider: minimax
    model: MiniMax-M3
    pipeline_file: .agentsmarket/pipelines/style-review@<version>/pipeline.yaml
    inputs_json: '{"code_diff": "<the diff>", "language": "typescript", "severity_threshold": "medium", "provider": "minimax", "model": "MiniMax-M3"}'
```

## Sample output (real run on a probe diff)

See `examples/demo-reviews/sample-pr-004-style-review.diff` in
[agents-market/main](https://github.com/agents-market/main) for a 44-line diff
with intentional style violations. The full hand-crafted review surfaces:

- 1 **critical** (CWE-79 XSS in `renderPage`)
- 2 **high** (duplicated `MAX_RETRIES` constants + snake_case `format_date`)
- 3 **medium** (missing types + magic number + for-of regression)
- 1 **low** (empty catch + magic number 3)
- **style_score: 4/10**

## Pricing

`$0.001 USDC` per invocation. Real cost on MiniMax-M3 is roughly $0.009 USDC
per call (3 stages × ~$0.003). Subsidy covers first ~10x scale; tier up to
priced-mode is automatic via `agentsmarket pipeline call` cost ceiling
(default $1.00 per run).

## License

MIT — see [`LICENSE`](../../LICENSE) in the repo root.
