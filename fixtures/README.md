# Why this fixture exists

`dependency-scanner` had never been run against anything with a known answer.
This is that: `lodash@4.17.15` has six published advisories.

## What the pipeline returns, re-measured 2026-10-19

Re-measured after every output template stopped being a skeleton. Three
identical runs of `analyze_vulns` on this fixture:

| | before, 18 Oct | now, 19 Oct |
|---|---|---|
| CVE ids named | 4 | 5 |
| of those, applicable to 4.17.15 per OSV | **2** | **3** — `CVE-2020-28500`, `CVE-2020-8203`, `CVE-2021-23337` |
| of those, real but for other version ranges | 2 — `CVE-2019-10744`, `CVE-2021-44906` | 2 — the same two |
| real advisories OSV knows and the pipeline did not name | 4 | 3 — `CVE-2025-13465`, `CVE-2026-2950`, `CVE-2026-4800` |

The stage gained one real finding and lost none. It did not become trustworthy:
it still names two advisories that do not apply to this version, and still misses
the three most recent ones.

The authoritative set, resolved from OSV today. OSV answers with `GHSA-*` ids
only, so comparing on `CVE` makes a correct implementation look 100% wrong:

```
GHSA-29mw-wpgm-hmr9 -> CVE-2020-28500    named
GHSA-35jh-r3h4-6jhm -> CVE-2021-23337    named
GHSA-p6mc-m468-83gw -> CVE-2020-8203     named
GHSA-f23m-r3pf-42rh -> CVE-2026-2950     MISSED
GHSA-r5fr-rjxr-66jc -> CVE-2026-4800     MISSED
GHSA-xxjr-mmjv-4gpg -> CVE-2025-13465    MISSED
```

The stage does not look anything up. It recalls, so it applies remembered
advisories to a version they do not cover, misses everything published after
training, and reports a different confidence on the same input each time.

Two of the three misses are dated 2025 and 2026. No amount of prompting fixes
that; only a lookup does.

### Why the templates mattered here too

That gain came from an unrelated fix, so it is worth recording why. Every
`Return JSON:` block in all six pipelines was a skeleton — `"findings": [...]`,
`"rejected": [{"id": int, "reason": str}]` — and the model copies a skeleton
verbatim instead of filling it in. That surfaced while measuring a different
pipeline's flakiness, at 20% of runs, and then generalised: **all 12 output
blocks were skeletons; none is now.** A prompt that shows an unfillable shape
teaches the model to emit the shape.

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
