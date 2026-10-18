# VISION — what this repository is for

> This file is the north star. It is not a changelog and it does not describe
> what exists today. It describes **what we are aiming at**, so that every new
> file, PR and decision can be checked against it.
>
> If a change contradicts this document, either the change is wrong or this
> document needs updating on purpose. Silently drifting away from it is the one
> outcome this file exists to prevent.

## 1. What this repository is

**A home for canonical, official pipelines that as many developers as possible
want to use.**

Not a collection of interesting experiments. Not a playground. For every
pipeline that lives here, a stranger should be able to copy two lines from our
website, paste them into their own repository, and have it work on the first
try.

The test for membership is simple and unforgiving:

> Would a developer who has never heard of us get value from this in under a
> minute of friction?

If the answer is "not without reading the docs", the pipeline is not ready to be
official yet — no matter how good it is.

## 2. The three laws

Everything below follows from three laws. When they conflict with convenience,
they win. The third was added on 2026-10-18, after finding that
six of our own eighteen stages were paying for a model call to do
arithmetic.

### Law 1 — Minimum friction

A developer should be able to go from "I heard about this" to "it ran" with
**no setup steps, no configuration, no decisions.**

Every extra line we ask a stranger to write is a line where they stop and
abandon. Every choice we ask them to make is a chance to get it wrong.

### Law 2 — Maximum clarity

If a developer has to ask "what do I put here?", we have failed — no matter how
good the underlying pipeline is.

Each example must be readable at a glance by someone who has never used our
CLI, and copy-pasteable without editing.

### Law 3 — If a stage can be done without an LLM, it must be

**An LLM is the most expensive, slowest and least predictable tool we have. Use
it for the one thing only it can do: judgement. Everything else is software's
job.**

This is not an optimisation, it is a correctness rule. An LLM asked to count
findings can get the count wrong, and it will get it wrong differently every
run. Software asked to count findings gets the same answer every time, for
free, in microseconds, with no API key.

The test for a stage is one question:

> Would a competent engineer's script, written once, produce this output?

If yes, the stage is a script. If the answer needs taste — "is this actually a
vulnerability?", "which of these matters most?", "explain it in a sentence a
human will act on" — then it is a model, and only that part should be one.

Applied honestly, most pipelines are mostly not model work:

| Stage kind | Example | Belongs to |
|---|---|---|
| Parse, split, count, sort, filter, format | counts by severity, top-5 list, Markdown summary | software |
| Look it up in a database | CVE lookup, license list, advisory feed | software |
| Decide whether something is a problem | is this injection? is this a false positive? | **model** |
| Explain in words a human acts on | remediation advice | **model** |

A stage that mixes the two should be split. The split is not a refactor — the
model stage gets a smaller, sharper job, and the deterministic part becomes
testable.

Three costs that disappear with the LLM, and none of them are about money:

1. **Flakiness.** A pipeline that is 60% reliable is not a product. Every
   instance of Law 3 removed is a run that cannot fail randomly.
2. **Untestability.** A deterministic stage can have a unit test. A model stage
   can only be measured across many runs, which is slow, costs money, and is
   inconclusive at the sample sizes we can afford.
3. **Availability.** Model stages need a key, a network, and a provider that is
   up. Script stages need nothing. A pipeline that runs anywhere is worth more
   than one that runs well somewhere.

**The corollary matters just as much.** Removing the LLM from a stage does not
mean writing bash inside a pipeline — it means the stage stops being a model
call. Where that computation lives is a separate question, and the answer must
work on every consumption path, not just `CLI --local`. See section 4: a stage
built on `shell:` works in two paths out of three, which is not "works".

## 3. The ideal end state

This is the target. It is written as the thing we want the website to show and
the README to lead with.

### 3.1 The ideal GitHub Workflow file

A consumer adds **one file, five lines, nothing to choose**:

```yaml
jobs:
  review:
    uses: agents-market/github-workflows/.github/workflows/ai-review.yml@<sha>
    secrets:
      MINIMAX_API_KEY: ${{ secrets.MINIMAX_API_KEY }}
```

That is the whole integration. Every option — pipeline version, focus area,
severity, strict-vs-advisory — has a sensible default inside our workflow. The
consumer chooses **nothing**. If a consumer can reach a decision point, we
failed to pick a good default.

Two properties we insist on:

- **A full commit SHA, never a tag.** A tag can move underneath a pin; a SHA
  cannot. Every pinned example in this repo uses a full SHA.
- **Secrets are passed explicitly.** GitHub does not forward secrets to a
  called workflow on its own. This is the only reason the snippet is five lines
  and not three, and it is the floor.

Comments in a *consumer-facing* snippet are a smell. Our internal workflow may
be thoroughly commented — that comment budget is ours, not the consumer's. A
consumer file explains itself by being obvious.

### 3.2 The ideal pipeline invocation

One command. It downloads the pipeline and runs it:

```
npx @agentsmarket/cli pipeline call style-review@2.0.4 --local
```

No `install` first. No lockfile to understand. No `--file`. No directory to
create. The pipeline arrives, runs, prints its result, and exits.

The version is explicit in the command on purpose: it is what makes the example
reproducible, and it is what the website links to. But it is **not** a decision
the developer has to make — we show them the exact string to paste.

### 3.3 The ideal example pipeline

An example pipeline is not a demo, it is **advertising**. It should be:

- **Short enough to read in full** on a website page, so the reader understands
  what they are about to run.
- **Self-contained** — plausible defaults, no required inputs beyond what the
  command line passes.
- **Reliable.** An example that fails one run in ten teaches a stranger that we
  do not understand our own product. A pipeline is not official until it passes
  consistently, not usually.

### 3.4 The ideal README opening

The first command on the page is one a stranger can run **right now**, at the
current published version, with no editing. If the first command in this
repository's README can fail, this repository is not ready.

## 4. Where we actually are

Measured, not assumed. Everything below was verified against the live
marketplace and the current CLI.

| Ideal | Actual | Gap |
|---|---|---|
| One command downloads and runs | `pipeline call style-review@2.0.3 --local` searches the filesystem and fails — it never downloads | **CLI does not parse `<slug>@<version>` on `call`** |
| Install then call works | Install writes `.agentsmarket/pipelines/style-review@2.0.3/`, but `call` does not look there. **The CLI prints a run command that fails.** | **`call` ignores the lockfile install just wrote** |
| First README command runs | README says `style-review@v1.0.0`; the server rejects it — `version must be a valid semver string (X.Y.Z)` | **the leading `v` is not accepted** |
| Consumer file is minimal | 40 lines, ~26 of them comments | trim to the five-line target |
| Examples exist for the website | `examples/` is empty apart from `.gitkeep` | **nothing to embed** |
| Every pipeline reliable | `style-review` 100%, `code-review-security-audit` 100%, `test-generator` **17 of 20** across 6k and 15k diffs but **10 of 14** at 50k | fails only on very large diffs — see below |

### The blocking items

**1. `call` now works in one command.** The gap that mattered most is closed
and verified end to end: `agents-market/main` #33, published as CLI 0.12.2 with
runtime 0.5.1, downloads and runs the pipeline from a clean directory. Both
`style-review@2.0.4` and `style-review@v2.0.4` resolve.

**2. The v-prefix works.** `style-review@v2.0.4` is accepted. Releases here are
tagged `v0.12.2`, so this is the form people type first.

**3. The first README command runs.** It points at 2.0.4, which exists.

**4. The promise is checked.** `.github/workflows/smoke.yml` runs both commands
on every push to `main` and fails loudly if either stops working. It went red
three times on its way green — once because the published CLI could not do it,
once because the runner had no identity, once because `code_diff` is required —
and each failure was a real defect rather than a flaky test.

### Still open

| Item | State |
|---|---|
| `examples/` is empty | Nothing for the website to embed yet. This is the largest remaining gap. |
| `test-generator` at 50k-char diffs | Degraded, not broken. Measured against the published artifact: 5/6 at 6 000 chars, 6/6 at 15 000, 10/14 at 50 000. The 50 000 figure was measured against the local spec before publication. |
| Consumer file is 18 lines, not 5 | The `on:`/`permissions`/`secrets` header is unavoidable; the rest is what we will trim when a CI system supports `uses:` at workflow top level. |
| Server silently overwrote four pipelines at `2.0.1` | Fixed in the server repo on 2026-10-14 (#12), not yet deployed. The published `2.0.1` specs now carry `maxTokens`, and the pre-fix copies are unrecoverable. Publishing those four again under a fresh version is the only way to get a clean history. |
| Four pipelines still sit at `2.0.1` | `style-review` and `code-review-security-audit` are at 2.0.3 with the fixes. The other four were republished in place, so their fixes live under the version they already had. |
| `maxTokens` needs CLI ≥ 0.12.2 | Published 2.0.3 specs depend on it. Anything older ignores the field silently and falls back to 4096. The smoke test pins the floor. |

### A note on test-generator

It looked broken and mostly is not. Measured against the artifact consumers
actually install, `test-generator@2.0.1`:

| diff size | result |
|---|---|
| 6 000 chars | 5 of 6 |
| 15 000 chars | 6 of 6 |
| 50 000 chars | 10 of 14 |

The earlier "fails one run in three" figure came from the 50 000-char case
alone, measured against the local spec. That is the size limit of the input,
not a broken pipeline — and 50 000 is the documented maximum, so the worst case
is a legitimate use.

The failure itself is worth knowing about, because it is not a tuning problem:
the model answers with a Markdown document instead of JSON. The prompt asks for
`markdown_report` containing "Markdown summary with generated test code
snippets, code fences", and the model produces exactly that as its whole
answer. Constraining it harder made things worse — 6 of 10, with
`markdown_report` simply missing from the reply.

So: keep it, measure it at realistic sizes, and do not advertise it above
15 000 chars. A pipeline that is reliable at its documented limit is official.
One that is not, is not.

### Law 3 applied to our own pipelines — audit

Every stage of every canonical pipeline, asked the question from Law 3. This is
the first honest look; nobody had asked it before.

| Pipeline | Stage | Verdict | Why |
|---|---|---|---|
| `code-review-security-audit` | `pattern_scan` | **LLM, but not a scanner** | Named like a scanner, is not one. It asks the model to judge injection, secrets, crypto, access control and then invent a description and a fix for each. That is judgement. What it also does wrong: `lines_scanned` / `hunks_scanned` are counted **by the model**. A `grep -c '^@@'` is exact; a model guessing is not, and differs run to run. |
| | `deep_review` | **LLM — correct** | Business-logic flaws, IDOR, race conditions. Genuinely judgement. |
| | `aggregate` | **7 of 8 fields are software** | See below. |
| `style-review` | `profile_style` | **borderline** | Detects naming/type/literal *patterns*. Half of it is AST or regex work; half is judging whether a pattern is a problem. |
| | `analyze_style` | **LLM — correct** | Judgement, with a fix suggestion. |
| | `aggregate_style` | **7 of 8 fields are software** | Same shape as `aggregate`. |
| `dependency-scanner` | `parse_lockfile` | **already script** | Correct — and it is the cheapest of the three. |
| | `analyze_vulns` | **should NOT be a model** | See below. |
| | `aggregate_report` | **software** | Counts and a table. |
| `test-generator` | `profile_code_behavior` | **borderline** | Same shape as `profile_style`. |
| | `generate_tests` | **LLM — correct** | Writing tests is the judgement. |
| | `aggregate_to_test_file` | **software** | Assembles a file. This is the stage that answers in Markdown instead of JSON, because it is a document assembler being asked to emit JSON. |
| `documentation-generator` | `profile_code_structure` | **software** | AST facts. |
| | `generate_documentation` | **LLM — correct** | Prose. |
| | `aggregate_to_markdown` | **software** | Assembly. |
| `api-design-reviewer` | `profile_api_design` | **borderline** | Surface extraction is software; consistency judgement is not. |
| | `review_design` | **LLM — correct** | Judgement. |
| | `aggregate_to_review` | **software** | Counts. |

### `aggregate` in detail

This is the clearest case, and it is the one you asked about.

| Field | Verdict |
|---|---|
| `total_findings` | arithmetic — `findings.length` |
| `critical_count`, `high_count`, `medium_count`, `low_count` | four filters on one field |
| `recommendations` | take the top 5 by severity, already ordered |
| `markdown_report` | render a template from the counts above |
| `overall_risk_score` | the only one that asks for judgement |

Seven of eight fields are decided before any judgement is involved. Asking a
model for them costs a call, can be wrong, and is different every run — and the
`output_schema` below the prompt *already specifies every one of them precisely*,
which is a schema a function could satisfy exactly.

Worse, the schema is what makes this stage fail. `markdown_report` with
`maxLength: 8000` and a required Markdown structure is the largest free-text
field in the pipeline, and it is the field most likely to truncate, most likely
to arrive as prose rather than JSON, and least likely to be read by anyone —
the listing renders it, the consumer's CI prints it, and a human reads the
counts.

### `analyze_vulns` in detail

Currently: a model is asked to identify known CVEs for a pinned version, and
the prompt names NVD, GitHub Advisories, Snyk and OSV as sources it may
consult.

The model cannot consult them. It has no network and no database — it
generates from weights. So the stage does not do what its own prompt says; it
produces a plausible-looking CVE identifier from memory, which is the worst
possible failure mode for a security tool: confidently wrong, with a severity
and a confidence score attached that make it look authoritative.

This is the exact defect the other agent hit while building `analyze_vulns`
without an LLM from OSV.dev, and they were right to hit it. A lookup is a
lookup. It should be an `http:` call to OSV, deterministic, free, verifiable,
and correct on versions that were published after any model's training cutoff.

### What this costs us if we ignore it

Of 18 stages across the six pipelines, **at least 6 are software wearing an LLM
cost**, and one — `analyze_vulns` — is actively unsafe in this form. The
aggregate stages alone account for roughly a third of the spend on every review,
to compute numbers a calculator would get right.

`test-generator` is the visible symptom. Its `aggregate_to_test_file` fails
about one run in three on a large diff, always the same way: the model answers
with a Markdown document instead of JSON. The stage is assembling a file from
parts already produced. It should not be able to fail like that.

## 5. Rules that follow

Decisions that look like taste but are not:

1. **A default beats an option.** Every knob a consumer can turn is a decision
   we pushed onto them. Ship the right default instead.
2. **Show the real version, always.** Examples with stale versions are worse
   than no examples: they cost the reader a failed command and their trust.
3. **An example must be runnable from a clean directory.** No pre-existing
   lockfile, no config, no prior install.
4. **Reliability is part of the product.** A canonical pipeline that fails
   intermittently is a support burden and a bad advertisement.
5. **Fail loudly.** A workflow that reports green while part of it failed is
   worse than a red one, because it teaches the reader to ignore us.
6. **Fewer lines, same behaviour.** When two versions do the same thing, the
   shorter one is the better deliverable — especially the one a stranger reads.

## 6. Maintaining this file

Update this document in the same commit as any change that moves the table in
section 4. The table is the to-do list; a stale table turns this file into
fiction, and a fictional north star is worse than none.
