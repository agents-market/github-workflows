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
| Every pipeline reliable | `style-review` and `code-review-security-audit` at 100%; `test-generator` fails roughly 1 run in 3 on a large diff | `test-generator` is not official yet |

### The blocking item

The gap that matters more than all the others combined is the first two rows.
Today, our own install command tells the user to run a command that cannot work:

```
$ agentsmarket pipeline install style-review
  Run it:     agentsmarket pipeline call style-review --local --mock
$ agentsmarket pipeline call style-review --local --mock
✗ Pipeline file not found for slug "style-review".
```

The lockfile already records exactly what is needed to fix this — `slug`,
`version` and `sha256` — so the resolution is a lookup, not a new concept.
Until it is fixed, **Law 1 is violated at the very first step**, and no amount
of README polish or marketing reaches a developer past it.

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