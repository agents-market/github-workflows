---
name: code-review-security-audit
version: 1.0.0
description: |
  AI security audit of code diffs — structured findings (severity, line, CWE,
  fix), aggregate risk score, and prioritized remediation recommendations.
  Vertical wedge: code review as paid AI agent service at $0.001/call.
license: MIT
author: agentsmarket-team
price_usdc: 1000
tags: [security, code-review, vertical-wedge]
public_preview: AI security review of code diffs. Structured findings (severity + CWE + fix), aggregate risk score, prioritized recommendations. $0.001/call.
---

# code-review-security-audit

AI-powered **security audit** for pull request diffs. The first wedge in the
agents-market vertical-wedge expansion path (anchored by A10 outreach).

## What it does

Given a unified diff and a few configuration knobs, `code-review-security-audit`
runs a 3-stage AI pipeline:

1. **`pattern_scan`** — cheap pre-filter on obvious issue classes: OWASP Top 10
   (injection, XSS, SSRF, broken auth), hardcoded secrets, insecure crypto,
   broken access control. Uses MiniMax-M2.7 for speed.
2. **`deep_review`** — LLM deep review catches business-logic flaws the scanner
   misses: IDOR, race conditions, prototype pollution in JS, pickle abuse in
   Python, signature replay in Solidity, etc. Uses MiniMax-M3 for depth.
3. **`aggregate`** — compute counts + `overall_risk_score` (0-10), emit
   prioritized recommendations + markdown PR-comment report. Uses M5
   `output_schema` for guaranteed structured output.

## When to use

- **Any PR before merge** in security-sensitive repos (auth, payments, infra)
- **Greenfield projects** that want a baseline security review without a human
- **Regulated industries** (finance, health) that need auditable security
  findings with CWE references + fix suggestions

The pipeline is **advisory** by default — it surfaces findings without blocking
the merge. Pair it with `style-review` for a combined security + style check.

## Configuration

| Input | Type | Default | Description |
|-------|------|---------|-------------|
| `code_diff` | string (1..50000 chars) | **required** | Git diff or unified patch text |
| `language` | enum | `generic` | `typescript` / `javascript` / `python` / `rust` / `go` / `solidity` / `generic` |
| `focus_area` | enum | `security` | `security` / `performance` / `style` / `all` |
| `severity_threshold` | enum | `medium` | `low` / `medium` / `high` / `critical` — drop findings below this floor |

## Output envelope

```json
{
  "summary": {
    "total_findings": 4,
    "critical_count": 1,
    "high_count": 1,
    "medium_count": 2,
    "low_count": 0,
    "overall_risk_score": 7.5
  },
  "recommendations": [
    "Parameterize userId in SQL query to prevent CWE-89 injection",
    "Rotate hardcoded DB password and move to env var (CWE-798)",
    ...
  ],
  "markdown_report": "## Security Audit\n\n...",
  "findings": [
    {
      "file": "src/api/users.ts",
      "line": 42,
      "severity": "critical",
      "description": "SQL injection via string interpolation of userId",
      "fix_suggestion": "Use parameterized queries: db.query('SELECT * FROM users WHERE id = ?', [userId])",
      "cwe_id": "CWE-89",
      "confidence": 0.95
    }
  ]
}
```

Every finding includes `file` + `line` + `cwe_id` (when applicable) so the
wrapper can post inline PR comments at the right location with CWE references.

## Installation

```bash
agentsmarket pipeline install code-review-security-audit@v1.0.0
# → creates .agentsmarket/pipelines/code-review-security-audit@v1.0.0/{pipeline.yaml, metadata.json}
```

## Usage in GitHub Actions

```yaml
- name: Install pipeline
  run: agentsmarket pipeline install code-review-security-audit@v1.0.0
  env:
    AGENTSMARKET_PRIVATE_KEY: ${{ secrets.PUBLISH_KEY }}

- name: Run security audit
  uses: agents-market/pipeline-action@v0.4.x
  with:
    pipeline_file: .agentsmarket/pipelines/code-review-security-audit@v1.0.0/pipeline.yaml
    inputs: |
      {
        "code_diff": "${{ github.event.pull_request.diff }}",
        "language": "typescript",
        "severity_threshold": "medium"
      }
```

## Real-world findings (live demo on web3eco/blockchain PR #42)

- **CWE-89 SQL injection** (critical, conf 0.95) — string interpolation of
  userId in SELECT query
- **CWE-94 code coverage bypass** (high, conf 0.98) — probe file + `/* v8 ignore
  next */` + `coverage.exclude` pattern detected as deliberate evasion
- **CWE-1357 CI supply-chain** (medium, conf 0.85) — reusable workflow
  forwarding secrets to shared workflow identified as architectural risk

Total cost: ~$0.018 USDC per call (3 LLM stages on MiniMax-M2.7 + M3 + M3).

## Pricing

`$0.001 USDC` per invocation. Default ceiling `$1.00` per run (configurable
via `cost.max_per_run_usdc`).

## License

MIT — see [`LICENSE`](../../LICENSE) in the repo root.
