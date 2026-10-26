---
name: code-review-security-audit
version: 3.4.1
description: 'AI security audit of code diffs — structured findings (severity, line, CWE, fix), aggregate summary with risk score, and prioritized remediation recommendations.'
license: MIT
author: agentsmarket-team
price_usdc: 0
call_price_usdc: 0
tags: [security, code-review, vertical-wedge]
public_preview: AI security review of code diffs. Structured findings (severity + CWE + fix), risk score, prioritized recommendations.
---

# code-review-security-audit

AI-powered **security audit** for pull request diffs.

## What it does

Given a unified diff, `code-review-security-audit` runs four stages:

1. **`pattern_scan`** — cheap pre-filter on the obvious classes: OWASP Top 10
   (injection, XSS, SSRF, broken auth), hardcoded secrets, insecure crypto.
2. **`deep_review`** — LLM deep review for the business-logic flaws the scanner
   misses: IDOR, race conditions, prototype pollution in JS, pickle abuse in
   Python, signature replay in Solidity.
3. **`gap_review`** — second pass. It reads the first pass's findings and looks
   for what that pass did not report. It repeats nothing: an already reported
   weakness is not reported again.
4. **`aggregate`** — `overall_risk_score` (0-10), prioritized recommendations,
   a markdown PR-comment report. Structured output.

Every stage runs on the `model` input — `MiniMax-M3` by default.

The consumer sees the union of both passes: findings from every stage,
de-duplicated by file/line/class.

## When to use

- **Any PR before merge** in security-sensitive repos (auth, payments, infra)
- **Greenfield projects** wanting a baseline review without a human
- **Regulated industries** that need auditable findings with CWE references

The pipeline is **advisory** — it surfaces findings without blocking the merge.
Pair it with `style-review` for a combined security + style check.

## Configuration

| Input | Type | Default | Description |
|-------|------|---------|-------------|
| `code_diff` | string (1..50000 chars) | **required** | Git diff or unified patch text |
| `language` | enum | `generic` | `typescript` / `javascript` / `python` / `rust` / `go` / `solidity` / `generic` |
| `focus_area` | enum | `security` | `security` / `performance` / `style` / `all` |
| `severity_threshold` | enum | `medium` | `low` / `medium` / `high` / `critical` — drop findings below this floor |
| `provider` | enum | `minimax` | `minimax` / `openrouter` / `openai` / `anthropic` / `replicate` — the LLM provider for this run |
| `model` | string | `MiniMax-M3` | The LLM model for this run — must be one the chosen provider carries |

`medium` is the default and the floor to keep: on this repository's fixture it
found every planted weakness and invented nothing. The floor is a hint to the
model, not a filter: `high` and `critical` still reported all eleven, `low`
lost three.

## Output envelope

```json
{
  "summary": {
    "overall_risk_score": 7.5
  },
  "recommendations": [
    "Parameterize userId in SQL query to prevent CWE-89 injection",
    "Rotate hardcoded DB password and move to env var (CWE-798)"
  ],
  "markdown_report": "## Security Audit\n\n...",
  "findings": [
    {
      "file": "src/api/users.ts",
      "line": 42,
      "severity": "critical",
      "description": "SQL injection via string interpolation of userId",
      "fix_suggestion": "Use parameterized queries: db.query('SELECT ... WHERE id = ?', [id])",
      "cwe_id": "CWE-89",
      "confidence": 0.95
    }
  ]
}
```

Every finding includes `file` + `line` + `cwe_id` (when applicable), so the
wrapper can post inline PR comments at the right location.

## What changed in 3.3.0

**A second review pass, told what the first one found.**

One pass found eight of the eleven weaknesses planted in this repository's
fixture, and which eight changed from run to run: a single review is a sample,
not a census. The new `gap_review` stage reads the first pass's output
(`$stages.deep_review.output`) and is asked for the gaps only.

Measured on the fixture: the first pass finds 8, the second finds the missing 3
(open redirect, prototype pollution, ReDoS), and the union covers 11 of 11. In
the worst runs the second pass adds a finding the reader does not need; it never
removes one.

Two rules keep the second pass from repeating itself: a weakness is the same
weakness when it is the same code, even under a different CWE id; and a
weakness is reported only where you can point at the line where something wrong
happens — the absence of a control is not a finding. This pipeline finds bugs in
the code; it is not a policy checker.

The cost is one more model call per review.

## What changed in 3.2.0

**`cwe_id` is drawn from the official catalogue, and `pattern_scan` no longer
guesses one.** The scanner used to name a weakness class from memory — ids never
checked against anything. Now `deep_review` picks the id from a closed list: the
MITRE catalogue, snapshot `2026-10-23`, 269 entries, embedded in the prompt. If nothing in the list describes the weakness, `cwe_id` is
`null`; an id outside the list is impossible by construction. The scanner emits
no id at all — it is a pre-filter.

Verifying the ids is still the consumer's job: a closed list removes invented
ids, it does not prove an id is the *right* one. The reference workflow here
checks every id against the same list and prints the official name and the MITRE
link next to the finding.

## Breaking change in 3.0.0

**The pipeline no longer counts findings.** `summary` is now
`{overall_risk_score}`; `pattern_scan` returns `candidates`, not `findings`.
A model asked to count a list it is writing gets it wrong, and a wrong count is
worse than no count — count the array yourself, or read `findings_count_json`
from the action. **Every finding also carries the file it is in**: before 3.0.0
the stages did not ask for it, and the consumer dropped every finding with a
line but no file — silently, and without counting it. On this repository that
meant the audit posted no inline comments at all, ever.

## Installation

```bash
agentsmarket pipeline install code-review-security-audit
# → .agentsmarket/pipelines/code-review-security-audit@<version>/{pipeline.yaml, metadata.json}
```

Without a version this installs the latest release; `pipeline info` names the
current one. Needs `MINIMAX_API_KEY` in the environment. The provider is the
`provider` input (`minimax` by default); the model stays MiniMax-M3.

## Usage in GitHub Actions

```yaml
- name: Install pipeline
  run: agentsmarket pipeline install code-review-security-audit@<version>

- name: Run security audit
  uses: agents-market/pipeline-action@434ff6c46d82e34d601233e00bd2c564c68baa08 # v0.4.9 (resolves ${input.provider})
  env:
    MINIMAX_API_KEY: ${{ secrets.MINIMAX_API_KEY }}
  with:
    # The action runs what the caller passes; it does not read a spec's defaults.
    provider: minimax
    model: MiniMax-M3
    pipeline_file: .agentsmarket/pipelines/code-review-security-audit@<version>/pipeline.yaml
    inputs_json: '{"code_diff": "<the diff>", "language": "typescript", "severity_threshold": "medium", "provider": "minimax", "model": "MiniMax-M3"}'
```

## Real-world findings (live demo on web3eco/blockchain PR #42)

- **CWE-89 SQL injection** (critical, 0.95) — userId interpolated into a SELECT
- **CWE-94 code coverage bypass** (high, 0.98) — `coverage.exclude` read as evasion
- **CWE-1357 CI supply-chain** (medium, 0.85) — a workflow forwarding secrets

The second pass buys the recall: on the fixture one pass finds 8 of 11 planted
weaknesses, the pair finds 11.

## Pricing

Free to download. On the server, a call costs the tokens the review uses —
about $0.035 at four stages. The spend ceiling defaults to $1.00 per run
(`cost.max_per_run_usdc`).

## License

MIT — see [`LICENSE`](../../LICENSE) in the repo root.
