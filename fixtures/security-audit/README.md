# The security audit case corpus

Seven cases, one weakness each, and a known answer per case.

`code-review-security-audit` had been measured for the first time in November
2026, and every measurement of it was a number without an answer: "the pipeline
found 7 findings on this diff". A number without a known answer is not a
measurement — it is a mood. The sibling corpus for `style-review`
(`fixtures/style-review/`, added in parallel) has the same shape and the same
reason to exist.

The corpus answers three questions about the audit, and only these three:

1. **Does it find the weakness the diff contains?** (recall)
2. **Does it report things that are not there?** (false positives — the
   near-misses planted next to every weakness)
3. **Is it the same every time?** (the same diff, the same spec, the same
   model, `temperature: 0` — and a different answer)

## Why the cases are written, not collected

The measurements that started this corpus ran on real pull requests of real
consumer repositories. Those pull requests are **not** in this corpus, and
they cannot be: this repository is public and those repositories are private.
Copying a customer's diff into a public repository publishes their code.

So the cases are written. Each one is a diff in the shape of a real pull
request — a source change, a test, a README, sometimes a second module — with
exactly one weakness in it, and a near-miss next to the weakness that must not
be reported. The *shapes* come from what the real measurements showed (a race
on an ownership check, an OAuth callback that trusts its `state`, a workflow
that interpolates a pull request title into a shell line, a query built by
pasting a parameter, a download path built from a request, a token written
into a log, a route that checks nobody's role). The code is new.

Each case contains **exactly one weakness**. That is what makes the answer
known: a second finding is either a false positive or an answer that is not
known, and a corpus that cannot tell those apart measures nothing.

## What is in here

```
cases/<case>.diff      the diff the audit is given
cases/expected.json    the known answer: what must be found, what must not
cases/expected.md      the same answer, for a human
run-cases.mjs          runs a spec over the cases and writes one JSON file
summarize.py           turns those JSON files into the table
check-cases.mjs        says what is wrong with the corpus itself
```

The pipeline sees the diff and nothing else — no file list, no repository, no
expectation file.

## How it was run

```bash
npm install --no-save --no-audit --no-fund @agentsmarket/pipeline-runtime@latest yaml
export MINIMAX_API_KEY=...            # the model is the spec's own default, MiniMax-M3

node fixtures/security-audit/run-cases.mjs \
  --spec pipelines/code-review-security-audit/pipeline.yaml --repeats 3 \
  --out /tmp/sa.json

python3 fixtures/security-audit/summarize.py /tmp/sa.json
node fixtures/security-audit/check-cases.mjs
```

`--only <case>` runs one case, which is how a case that was lost to a provider
rate limit is re-run without spending the whole corpus again. The summarizer
takes several files and prints them side by side; two files that carry the same
label (the same spec version and the same repeat count) are numbered, so one
case per file does not count every run once per file.

`run-cases.mjs` executes the spec through the real runtime, so the
measurement covers the stages, the model and the runtime — not a
re-implementation of them. The key comes from the environment, never from
argv.

`check-cases.mjs` is the corpus's own check, and the consumer smoke test runs
it. It says what is wrong with the corpus, because a corpus that does not
hold together measures nothing and fails quietly:

- a case with no expectation is never checked;
- an expectation for a case that does not exist is never checked either;
- a hunk header that does not match its body makes the model read the wrong
  line, and the measurement then measures a mapping, not an audit;
- a line that the diff does not contain cannot be checked — the near-miss
  would be outside the diff, and the pipeline never saw it;
- a case longer than the spec's `code_diff` limit (50 000 characters) cannot
  be run at all — the runtime refuses the input, and the case is simply absent
  from the results.

## The three answers the runs are checked against

A finding lands in one of three buckets, and the buckets are different in
kind:

- **found** — the expected weakness, in the expected file, under a class that
  names it. Recall.
- **false positive** — a finding on a planted near-miss: a place where the
  code is safe, so any finding there is wrong. Precision, and it is
  decidable: the corpus can point at the line.
- **everything else** — the pipeline's other opinions about the surrounding
  code. The corpus counts them and does not rule on them.

The class list matters more than it looks. The pipeline does not use one class
per weakness: for the same two lines of the OAuth callback it said `CWE-352`
in one run and `CWE-287` in another. So the answer lists every class that
names the same weakness, and the measurement reports which class was used —
that is the `CANON` problem again, in a place where it can be counted.

## What it returns

The numbers below are from one session: one model (MiniMax-M3, `temperature: 0`),
one spec version (`code-review-security-audit` 3.4.7), one corpus. Seven cases,
three runs each — **21 runs, no failures, $0.82**.

| case | expected | found | false positives | other findings | the class it was named with |
|---|---|---|---|---|---|
| `race-ownership` | `src/wallet/transfer.ts`, CWE-362 | **3/3** | 0 | 9 | `CWE-367` ×3 |
| `oauth-state` | `src/auth/google-callback.ts`, CWE-352 | **3/3** | 0 | 25 | `CWE-352` ×3, `CWE-287` ×1 |
| `workflow-shell` | `.github/workflows/notify.yml`, CWE-78 | **3/3** | 0 | 8 | `CWE-78` ×3 |
| `sql-concat` | `src/reports/by-id.ts`, CWE-89 | **3/3** | 0 | 6 | `CWE-89` ×4 |
| `path-traversal` | `src/files/download.ts`, CWE-22 | **3/3** | **1** | 17 | `CWE-22` ×6 |
| `token-log` | `src/http/client.ts`, CWE-532 | **3/3** | 0 | 8 | `CWE-532` ×3 |
| `missing-authorization` | `src/admin/users.ts`, CWE-862 | **3/3** | 0 | 5 | `CWE-862` ×3 |

**Recall: 21/21 runs found the weakness the diff contains.** The audit is not
the weak part.

**Precision: one false positive in 21 runs.** The pipeline reported
`CWE-22` on `downloadInvoice` — the handler that resolves the path and checks
that it stays inside the directory. It said the handler *lacks* the
containment check. It has it:

```ts
const path = resolve(FILES_DIR, name);
if (!path.startsWith(resolve(FILES_DIR) + sep)) {
  return new Response('not found', { status: 404 });
}
```

That is the whole false-positive count, and it is decidable: the corpus can
point at the line.

**The other findings (78, about 3.7 per run) are not adjudicated.** They are
the pipeline's opinions about the code around the weakness — whether the
cookie parser should reject a duplicate cookie, whether the destination
wallet of a transfer should be checked, whether a redirect URI may fall back
to a fixed host. Some of them are real, some are noise. The corpus counts
them and does not rule on them: a corpus that called every one of them a
false positive would be judging the pipeline, not measuring it.

A second session of the same corpus found the weakness in **20 of 20** runs
(21 attempts, one lost to a provider rate limit), with **one** false positive —
the same one — and **62** other findings instead of 78. The recall and the false
positive held; the count of the pipeline's opinions about the surrounding code
did not, and it was never expected to: it is a sampling model. That is the
third question the corpus asks, and the answer is "not the same every time,
except about the weakness".


### The class names move

The same weakness does not always get the same class. The race in
`transferFunds` was called `CWE-367` in all three runs — and `CWE-362` is the
same weakness under its other name. The OAuth callback was `CWE-352` three
times and `CWE-287` once, for the same two lines.

So `expected.json` lists every class that names the same weakness, and the
answer is "found" under any of them. A verdict keyed on one class number
would miss a finding it should have caught — the same problem the verdict
memory solves with `CANON`, in a place where it can be counted.

### Does stage 1 narrow stage 2?

Issue [#6](https://github.com/agents-market/github-workflows/issues/6) asks whether the
cheap first stage narrows what the review stages read. The corpus can answer it, so
it does.

A second session recorded what the scanner said, not only what the review stages
found: **seven cases, three runs each — 21 attempts, 20 completed (one lost to a
provider rate limit), $0.76.**

| case | stage 1 pointed at the weakness | candidates | of which elsewhere |
|---|---|---|---|
| `missing-authorization` | 3/3 | 5 | 0 |
| `oauth-state` | 3/3 | 12 | 3 |
| `path-traversal` | 2/2 | 9 | 3 |
| `race-ownership` | **1/3** | 3 | 0 |
| `sql-concat` | 3/3 | 8 | 0 |
| `token-log` | 3/3 | 5 | 0 |
| `workflow-shell` | 3/3 | 8 | 0 |

**Stage 1 pointed at the weakness in 18 of 20 runs.** The two it missed are the
same case, and the reason is not a near miss: in those runs the scanner returned
`{"candidates": []}` — nothing at all. That is checked, not assumed: the raw
output was captured, and an empty list is a valid answer to the stage's schema,
not a failure to parse it. A separate five-run batch of the same case produced
one more empty list, so **three of eight runs** of the race case got nothing from
the scanner.

The review stages found the weakness in **20 of 20** runs — including the two
where the scanner said nothing, because they read the diff themselves.

**So stage 1 does not narrow stage 2, and it cannot be made to.** Two reasons,
one measured and one structural:

- **Measured.** Narrowing stage 2 to the scanner's candidates would have lost the
  weakness in every run where the scanner returned nothing: 2 of 20 on this
  corpus, 3 of 8 on the race case.
- **Structural.** `deep_review`'s prompt carries the whole diff and tells the
  model to "re-read the diff yourself to catch business-logic flaws" and to report
  "each NEW finding the scanner missed". The scanner's output is a lead list, not
  a filter; stage 2 exists to find what stage 1 did not.

### What the money is

Per stage, over the 20 completed runs ($0.76 in total):

| stage | cost | share | per run |
|---|---|---|---|
| `pattern_scan` | $0.0628 | 8.2% | $0.0031 |
| `deep_review` | $0.2789 | 36.6% | $0.0139 |
| `gap_review` | $0.2588 | 34.0% | $0.0129 |
| `aggregate` | $0.1615 | **21.2%** | $0.0081 |

The aggregate stage reads no pipeline input of its own: it merges what the passes
above found. It is a fifth of the run. Declaring `reads: []` removes its whole
`Inputs:` block — the diff and the four small inputs beside it:

- on this corpus, whose diffs run 1 100–4 200 characters: **$0.0012 per run**;
- on the 47 608-character diff from #6: **$0.0239 per run**, against a run that
  cost $0.1475.

That is the saving that does not cost recall. The rest of the aggregate's input —
the review stages' own output — stays: `reads:` narrows the inputs, not the
previous stages' results.

### What a first draft of the corpus measured

The first version of these cases had filler code that was not actually safe:
the upload handler did not enforce the size limit its own config declared,
the session lookup took the session id from the request, the guard trusted a
header. The first measurement showed 110 findings beyond the planted
weakness — and reading them showed the pipeline was right about most of them
and the corpus was wrong. The cases were rewritten until each one held
exactly one weakness and every near-miss was safe code.

That is what a corpus with a known answer is for: it made the *corpus* the
thing under test, and it did so by refusing to let the measurement stand.

