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

## 2. The two laws

Everything below follows from two laws. When they conflict with convenience,
they win.

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
npx @agentsmarket/cli pipeline call style-review@2.0.3 --local
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
`style-review@2.0.3` and `style-review@v2.0.3` resolve.

**2. The v-prefix works.** `style-review@v2.0.3` is accepted. Releases here are
tagged `v0.12.2`, so this is the form people type first.

**3. The first README command runs.** It points at 2.0.3, which exists.

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