# Why this fixture exists

`dependency-scanner` had never been run against anything with a known answer.
This is that: `lodash@4.17.15` has six published advisories.

## What the pipeline returns, measured 2026-10-18

Three identical runs of `analyze_vulns` on this fixture:

| | result |
|---|---|
| CVE ids named | `CVE-2019-10744`, `CVE-2020-8203`, `CVE-2021-23337`, `CVE-2021-44906` |
| of those, applicable to 4.17.15 per OSV | 2 — `CVE-2020-8203`, `CVE-2021-23337` |
| of those, real but for other version ranges | 2 — `CVE-2019-10744`, `CVE-2021-44906` |
| real advisories OSV knows and the pipeline did not name | 4 — incl. `CVE-2025-13465`, `CVE-2026-2950`, `CVE-2026-4800` |
| `confidence` values across the three runs | 0.88 / 0.90 / 0.92 / 0.95 / 0.97 |

The stage does not look anything up. It recalls, so it applies remembered
advisories to a version they do not cover, misses everything published after
training, and reports a different confidence on the same input each time.

Two of the four misses are dated 2025 and 2026. No amount of prompting fixes
that; only a lookup does.

## Why this is not wired into dogfooding yet

Three reasons, each measured rather than assumed:

1. This repository has no dependencies to scan — 34 files, no lockfile.
2. `test.yaml` is executed by nothing (`README.md`: `pipeline test` is
   disabled), so there is no mock-level check behind it either.
3. A PR comment built from invented CVE identifiers is worse than no PR
   comment. That is the whole argument.

Once `analyze_vulns` is an `http:` call to OSV, this fixture becomes a
regression test: six advisories in, six advisories out, and the correct ones.

## Reproducing

```bash
npx agentsmarket pipeline call dependency-scanner --local \
  --inputs "{\"lockfile_content\": $(python3 -c 'import json;print(json.dumps(open("fixtures/lodash-4.17.15.json").read()))'), \"ecosystem\":\"npm\", \"severity_threshold\":\"low\"}"
```
