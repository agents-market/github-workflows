# The style-review case corpus

Six cases, one thing each, and a known answer per case. The corpus exists
because `style-review` was measured for the first time in November 2026, and
the first measurement was a number on a page: "the pipeline found N findings on
this diff". A number without a known answer is not a measurement — it is a mood.

The corpus also answers a question the pipeline's own guardrails raised: the
rule "a number in prose is not a magic number" is in the spec, but a config
file with `timeout_ms: 30000` is not prose either, and the pipeline kept
calling such values "executable configuration" and reporting them.

## What is in here

```
cases/<case>.diff      the diff the pipeline is given
cases/expected.md      what a good review says about each case
run-cases.mjs          runs a spec over the cases and writes one JSON file
summarize.py           turns those JSON files into the categories table
severity-stability.py  turns them into the severity table
```

`expected.md` is the answer the runs are checked against: per case, what must
not be reported and what is expected. The pipeline never sees any of it.

## How it was run

```bash
npm install --no-save --no-audit --no-fund @agentsmarket/pipeline-runtime@0.5.11
export MINIMAX_API_KEY=...            # the model is the spec's own default, MiniMax-M3

node fixtures/style-review/run-cases.mjs --spec /path/to/style-review-3.3.6.yaml \
  --repeats 6 --out /tmp/A.json

node fixtures/style-review/run-cases.mjs --spec pipelines/style-review/pipeline.yaml \
  --repeats 6 --category-thresholds "magic_numbers=none" --out /tmp/C.json

python3 fixtures/style-review/summarize.py /tmp/A.json /tmp/C.json
python3 fixtures/style-review/severity-stability.py /tmp/A.json /tmp/C.json
```

`run-cases.mjs` executes the spec through the real runtime, so the
measurement covers the stages, the model and the runtime — not a
re-implementation of them. It passes `category_thresholds` only if the spec
declares the input: an unknown input adds a line to the `Inputs:` block every
stage receives, and that is a change in the prompt, so the baseline would be a
different pipeline.

## What it returns, measured 2026-11-03

Six runs per case per arm, six arms, **216 runs, $1.85**, MiniMax-M3,
temperature 0.

| arm | runs | findings | `magic_numbers` | severity | cost |
|---|---|---|---|---|---|
| base, 3.3.6 | 36 | 43 | 6 | low 37 · medium 6 · high 0 | $0.324 |
| + "independent" | 36 | 39 | 6 | low 35 · medium 4 · high 0 | $0.306 |
| + scale | 36 | 40 | 7 | low 25 · medium 7 · high 8 | $0.294 |
| + scale and one clarification | 36 | 40 | 7 | low 26 · medium 3 · high 11 | $0.330 |
| cut-off | 36 | 32 | **0** | low 30 · medium 2 · high 0 | $0.286 |
| scale and cut-off | 36 | 40 | **0** | low 28 · medium 5 · high 7 | $0.307 |

What the arms are: **"independent"** is one sentence in the prompt (a
finding's severity does not depend on the rest of the diff); **"scale"** is
four levels with definitions; **"scale and one clarification"** is that plus
one sentence separating `medium` from `high` for a literal; **"cut-off"** is
`category_thresholds=magic_numbers=none`.

### Severity stability

`6/6` is how many of the six runs found the finding, and the list is the
severities it was given.

| case | expected | base | independent | scale | scale + fix | cut-off | scale + cut-off |
|---|---|---|---|---|---|---|---|
| `abbreviation` | `naming` | 6/6, low+medium — **floats** | 6/6, low | 6/6, low | 6/6, low | 6/6, low | 6/6, low |
| `lying-comment` | `comments` | 5/6, low+medium — **floats** | 4/6, low+medium — **floats** | 3/6, high | 4/6, high | 4/6, low+medium — **floats** | 6/6, high |
| `magic-literal` | `magic_numbers` | 6/6, low | 6/6, low | 6/6, high+medium — **floats** | 6/6, high | cut off | cut off |
| `missing-types` | `types` | 6/6, low | 6/6, low | 6/6, low | 6/6, low | 6/6, low | 6/6, low |
| `unused-export` | `exports` | 0/6 | 0/6 | 0/6 | 0/6 | 0/6 | 0/6 |

`config-number`, the YAML config, produced one finding in one of 216 runs, and
it was a `magic_numbers` finding — the false positive the spec's own rule was
written against.

## What the numbers say

**Two of six cases float, and the scale fixes both.** In the base, the same
finding comes back `low` in one run and `medium` in the next — on the
abbreviation case and on the comment that contradicts the code. With the scale
and the clarification, nothing floats and nothing new starts floating.

**One sentence is not enough.** The "independent" arm — a single sentence
telling the model that a finding's severity does not depend on the rest of the
diff — fixes the abbreviation case and leaves the calibration where it was,
but the comment case keeps floating. The model needs to know what each level
means, not only that the label is absolute.

**The scale without the clarification makes a new case float.** On a literal,
"the code works anyway" (`medium`) and "the unit is unknown" (`high`) are both
true, and the model picks differently from run to run: 6/6 runs, two different
severities. One clarifying sentence — a literal whose unit nobody can tell is
`high` even when the code works — closes it: 6/6 `high`.

**The scale moves the calibration, and that is a choice.** `low` goes from 37
findings to 26 and `high` from none to 11. A comment that contradicts the code
and a literal whose unit nobody can tell are `high` now, because that is what
they cost the reader. The pipeline's advisory tone is unchanged; the labels
are not.

**The cut-off does not fix severity — it removes the class.** `magic_numbers`
goes from 6–7 findings to none, and with it every thread the consumer would
have had to close. It is the only lever here that removes churn outright.

**Presence floats in every arm.** The comment that contradicts the code is
found in 3 to 6 of 6 runs, whichever arm it is. The scale fixes the label,
not the detection, and for a consumer whose rule is "close every thread before
merge" a finding that appears half the time is the bigger cost: it is a new
thread, not a reworded one.

**`exports` is unreachable from a diff.** 0 findings in 216 runs. The pipeline
is given a diff, not the repository, so it cannot know that `formatPercent` is
never imported. `expected.md` marks that case's answer as optional for this
reason.
