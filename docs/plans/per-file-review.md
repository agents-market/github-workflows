# Per-file review — plan

**Status:** plan, not built. **Written:** 2026-10-23.

A consumer asked for a review that reads one file at a time instead of one
diff. The numbers below say it is worth having. The design below says what it
costs. Nothing here is built yet, and nothing here changes the default path.

## Why it is not the default

Measured on the ten-file fixture with the same runtime the Action uses
(`tools/per_file_probe.mjs` in the fixture repo, `RESULTS.md` for the full
runs):

| | whole diff | per file |
|---|---|---|
| planted weaknesses found (of 24) | 13.5 median (9–15 over 4 runs) | 20 median (18–20 over 3 runs) |
| model calls | 2 | 20 |
| wall clock | ~50 s | ~261 s |
| comments on the PR | 16 | 43 |

Coverage goes from 56% to 83%. Cost goes up by ten times and the PR collects
two and a half times as many comments. That is a decision for the consumer,
not for a flag that every consumer inherits.

So: an opt-in input, `per_file: 'true'`, unset by default.

## What is already known

- **The inline thread sync needs no change.** It keys threads by
  `path::class` and closes a thread only when its file left the diff. Two
  legs working on two files do not touch each other's threads.
- **The CANON map needs no change.** It is per id, not per run.
- **The findings count needs no change.** It counts the array the action
  returned, by code.
- **The CWE catalogue check needs no change.** It reads the ids the model
  wrote.
- **The diff collection does.** One leg becomes one file's diff.

## The design

### 1. The file list

The matrix has to know the files before the job starts, so one job computes
them and the review job consumes its output:

```yaml
jobs:
  prepare:
    runs-on: ubuntu-latest
    outputs:
      files: ${{ steps.list.outputs.files }}
    steps:
      - uses: actions/checkout@v7
        with: { fetch-depth: 0 }
      - id: list
        run: |
          set -euo pipefail
          BASE=${{ github.event.pull_request.base.sha }}
          HEAD=${{ github.event.pull_request.head.sha }}
          git fetch --no-tags origin "$BASE" "$HEAD" 2>/dev/null || true
          FILES=$(git diff --name-only "$BASE...$HEAD" 2>/dev/null || true)
          # One pseudo-file means "the whole diff", which is what the default
          # path does today. The matrix then has exactly one file dimension and
          # the legs are exactly the two pipelines.
          if [ -z "$FILES" ]; then FILES='[""]'; else
            FILES=$(printf '%s' "$FILES" | jq -R -s -c 'split("\n") | map(select(length>0))')
          fi
          echo "files=$FILES" >> "$GITHUB_OUTPUT"
```

**The trap:** `needs:` a job that was skipped makes the dependent job skipped
too. The prepare job therefore always runs and outputs `[""]` when per-file
mode is off — the default path keeps exactly two legs and no new failure
mode beyond one `git diff --name-only`.

**The second trap:** the review job gains a `needs:` on prepare, so a failure
there means no review at all. The step is a `git diff`; if that is the weakest
link, the whole product is. It runs on the same checkout the review job
already does.

### 2. The matrix

```yaml
    strategy:
      fail-fast: false
      matrix:
        pipeline: [ ...unchanged... ]
        file: ${{ fromJSON(needs.prepare.outputs.files) }}
```

`matrix.pipeline.*` keeps working — GitHub expands two base keys as a cross
product, and the `include:` trap documented in CONTRIBUTING.md does not apply
here because both keys are base keys.

### 3. The diff

```yaml
      - name: Collect diff
        env:
          FILE: ${{ matrix.file }}
        run: |
          set -euo pipefail
          if [ -n "$FILE" ]; then
            D=$(git diff --no-color "$BASE...$HEAD" -- "$FILE" 2>/dev/null || true)
          else
            D=$(git diff --no-color "$BASE...$HEAD" 2>/dev/null || true)
          fi
```

An empty per-file diff (a renamed file with no content change) means the leg
has nothing to review: it must not call the model and must not post a
comment. Skip the pipeline run and the summary for that leg.

### 4. The summary comment — the part that is not obvious

Today one pipeline owns one sticky comment, upserted by the marker
`<!-- am:code-review-security-audit -->`. With N files there are N legs per
pipeline, and they would fight over that marker: the last leg to finish wins
and the comment shows one file's numbers.

Three ways out, and only one of them is right:

- **N comments, one per file.** Rejected. It is exactly the comment pile-up
  this product spent a day removing, and the rule "one sticky comment per
  pipeline" exists for a reason.
- **One comment written by one leg.** Rejected. It would show one file's
  numbers for a review of ten files, and a reader cannot tell which.
- **One comment written by a merge job that aggregates the legs.** The right
  one. Each leg uploads its counts and its cost as an artifact; a final job
  downloads them, sums them, and writes the single sticky comment.

That last one is the cost of this feature: one more job, artifact upload and
download, and a sum that must not double-count a file that two pipelines
reviewed separately.

### 5. What the reader sees

Per file, the inline comments are the same as today: one per (file, class),
closed and re-posted between runs. The PR gets one summary comment per
pipeline, with the totals of the whole run and a line saying how many files
were reviewed separately.

## Verification

The two-file fixture pull request is the cheap end-to-end proof: two files ×
two pipelines = four legs, four model calls, about four minutes.

1. Run it on the fixture pull request with `per_file: 'true'`.
2. Check that the findings are the union of the two files' findings and that
   no comment mentions a file outside the diff.
3. Check that the summary comment is one per pipeline, with the sum.
4. Run it again with the default path and check that nothing changed: two
   legs, one comment per pipeline, the same findings as before.
5. The comment counts are the thing to watch. 43 comments on 24 weaknesses is
   the per-file mode working as measured, but it is also the mode a consumer
   will complain about. The summary has to say why there are more of them.

## Limits that do not go away with this feature

- The ten-file fixture's truth is a subset: the code has more weaknesses than
  the 24 planted ones, so "no invented findings" is only measurable on the
  two-file fixture. A per-file run on the ten-file fixture found 18 real
  weaknesses that nobody planted.
- The id is the model's judgement. The CANON map covers the catalogue's pairs
  (330→338, 259→798, 915→1321, 321→798); it cannot cover a pair the
  catalogue does not offer. Two comments for one weakness is the smaller
  fault: a hidden finding is worse than a duplicate.
- 24 weaknesses in 10 files is a fixture, not a benchmark. It shows the
  direction and the cost, not the population.
