---
name: dependency-scanner
version: 2.0.1
description: |
  CVE IDENTIFIERS IN THIS PIPELINE ARE RECALLED FROM MODEL WEIGHTS, NOT LOOKED UP.
  Do not use it to decide whether to patch. See "Read this first" below.
---

# dependency-scanner

Reads a lockfile, extracts every pinned package, checks each against known CVEs, and returns structured findings with a risk score.


## Read this first — this pipeline does not check anything up

`analyze_vulns` asks a model to name CVEs for pinned versions. The model has no
network and no database. It answers from weights.

Measured 2026-10-19, three identical runs on `lodash@4.17.15`, checked against
OSV with GHSA aliases resolved. (18 Oct, before the output templates were fixed:
4 named, 2 applicable, 4 missed. The fix gained one and lost none.)

| | |
|---|---|
| advisories OSV holds for this version | 6 |
| CVE ids this pipeline named | 5 |
| of those, applicable to this version | **3** |
| of those, real lodash CVEs but for other version ranges | 2 |
| real advisories it did not name | **3**: CVE-2025-13465, CVE-2026-2950, CVE-2026-4800 |

Every identifier it produced is a real lodash CVE. It does not invent them — it
applies remembered advisories to a version they do not cover, and cannot know
anything published after training. All three misses are dated 2025 and 2026.

**So: `parse_lockfile` is trustworthy, `analyze_vulns` is not.** A finding from
this pipeline is not evidence. Use `npm audit`, `pip-audit` or `osv-scanner`
until this is a database lookup.

## Why it is still published

Because it is the right pipeline with one stage in the wrong place. The fix is
to replace `analyze_vulns` with an HTTP call to OSV, and there is no stage
primitive that can make one:

- no `http:` stage exists;
- `shell:` exists and is refused — `pipeline-action` runs with `isLocal: false`
  (`packages/pipeline-action/src/executor-deps.ts:222`), so `stages.ts` throws;
- `mcp_servers` are validated against a pre-registered registry, so an arbitrary
  endpoint cannot be named.

All three were checked, not assumed. Until the primitive exists, this pipeline
cannot be made correct, and publishing it as if it were would be the one
genuinely dangerous thing in this repository — a security tool that answers
confidently from memory.

`fixtures/lodash-4.17.15.json` and `fixtures/README.md` are the regression test
for the fix: six advisories in, six advisories out.

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
