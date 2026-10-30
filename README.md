# agents-market/github-workflows

> **Public community repo for AI pipelines + reference GitHub workflows.**
> Pipelines are published to [agentsmarket.world](https://agentsmarket.world) marketplace from here.
> Consumers install via [`@agentsmarket/cli`](https://www.npmjs.com/package/@agentsmarket/cli) → `agentsmarket pipeline install <slug>@<version>`.

> **Read [`VISION.md`](VISION.md) before changing anything here.** It states what
> this repository is for — canonical official pipelines that as many developers
> as possible want to use — and what we are aiming at: a five-line consumer
> workflow file, one command to run a pipeline, and no decision for the reader
> to make. It also carries the measured list of where we fall short.

## Mission

End-to-end fix for the 3-place pipeline drift vector: today a single pipeline YAML lives in:

```
agents-market/main/examples/pipelines/<name>.yaml   ← canonical
web3eco/shared-actions/.github/pipelines/<name>.yaml ← verbatim copy
web3eco/shared-actions/.github/workflows/*.yml      ← copy of copy (embedded inline)
```

**This repo is the single source of truth.** Pipelines live here as folders:

```
pipelines/<name>/
├── pipeline.yaml       ← spec (stages only, no metadata)
└── README.md           ← frontmatter (metadata) + markdown description
```

Consumers (any GitHub repo) install pipelines from this repo via the marketplace CLI.

## What's here

### `pipelines/` — canonical pipelines

Each subdirectory is one pipeline, carrying `pipeline.yaml`, a `README.md`
generated from that spec, and a `test.yaml` describing expected output.

| Pipeline | Input | Stages |
|----------|-------|--------|
| [`code-review-security-audit`](pipelines/code-review-security-audit/) | source diff | 4 |
| [`style-review`](pipelines/style-review/) | source diff | 3 |
| [`dependency-scanner`](pipelines/dependency-scanner/) | lockfile | 3 |
| [`api-design-reviewer`](pipelines/api-design-reviewer/) | API spec | 3 |
| [`documentation-generator`](pipelines/documentation-generator/) | source diff | 3 |
| [`test-generator`](pipelines/test-generator/) | source diff | 3 |
| [`error-autofix`](pipelines/error-autofix/) | production error + the files it points at | 2 |

Published versions live in the [marketplace](https://agentsmarket.world); the
publish workflow bumps them and writes them back into `pipeline.yaml`.

The first two came from the `agents-market/code-review` migration. The other
four were promoted out of `agents-market/main/examples/` on 2026-10-17, after
every example was run end-to-end against a real MiniMax-M3: of 20, ten execute,
and these four cover four different input domains. The examples that did not
execute are withdrawn from the catalogue. The seventh,
[`error-autofix`](pipelines/error-autofix/), is the first one that reads an
error instead of a diff — it answers with the text to replace and the text to
put there, and the caller writes the patch.

**All seven share one shape** — `structured_json` at every hop, three stages
except the security audit, which reads its own first pass a second time to
catch what that pass missed, and `error-autofix`, which has two. What differs
is the input, not the design. Treat them as one pattern with seven front-ends
until something genuinely multi-stage (a loop, a fan-out, a tool call) runs
reliably enough to be canonical.

Nothing executes `test.yaml` today: `agentsmarket pipeline test` is disabled in
the CLI for 0.10.0. The files are written down so the expectations are
reviewable, not because CI checks them.

### `workflows/` — the consumer-side wiring

[`workflows/ai-code-review.yml`](workflows/ai-code-review.yml) is the file
adopters paste. Copy it to `.github/workflows/ai-review.yml` in your repo, set
`MINIMAX_API_KEY`, and every pull request is reviewed by two pipelines: a
security audit and a style review. Nothing else to install, nothing to choose.
It names the reusable workflow at `@latest` — a tag we move to the newest
revision that passed the consumer smoke test. A fix we publish therefore
reaches the people who pasted it without a pin bump. If you would rather your
check not move under you, pin the commit instead:

```bash
gh api repos/agents-market/github-workflows/git/ref/tags/latest --jq .object.sha
```

Inputs are optional. `audit_version` and `style_version` are unset by default,
which installs whatever version is current — one input each, because the two
pipelines are released on their own schedule; `focus_area` and
`severity` are left unset on purpose, so each pipeline keeps its own default
(`security` for the audit, `all` for style). `advisory` is a string, `"false"`
by default: a failing pipeline fails the job, so a broken review is visible
rather than silently green. Pass `"true"` to downgrade that to a warning.

A caller that has a diff and no pull request passes it as `code_diff`, and the
review lands in the job summary instead of on a pull request. That is the
seam the next example uses.

[`workflows/ai-error-autofix.yml`](workflows/ai-error-autofix.yml) is the
other file adopters paste, and it is the first one that acts rather than
reports: an error from production goes in, a pull request with the fix and a
test comes out — or, when the fix is not mechanical, an issue with the
analysis. The `error-autofix` pipeline does the judgement; the workflow owns
the token, the branch and the pull request. The pull request it opens is
reviewed by the same canonical review as every other pull request, called
explicitly, because GitHub does not run workflows for a pull request opened by
its own token.

The rules around that bot — one pull request per error class, a ceiling on
how many fixes may be open at once, an issue instead of a pull request the
repository will not let it open — are in
[`scripts/error-autofix.mjs`](scripts/error-autofix.mjs), where
[`scripts/check-error-autofix.mjs`](scripts/check-error-autofix.mjs) can see
them. The daily check that a merged fix actually stopped the error is a
second file, [`workflows/ai-error-autofix-watch.yml`](workflows/ai-error-autofix-watch.yml):
it needs a feed of what is still failing (`ERROR_FEED_URL`), and a feed that
does not answer fails the sweep rather than reporting that every error
stopped.

For wiring a pipeline directly rather than through the review workflow, see
`agents-market/pipeline-action@0ab99cfca4566494f6d84d4e0b08fd11a3bf6c21 # v0.4.12 (merges input defaults; validates output locally)`.

### The inline thread sync — a step you call, not a step you copy

The review leaves a comment on the pull request for each finding. The part
that decides whether such a comment is a **new finding** or **the same
finding one line lower** is the thread sync, and it used to live inside
`ai-review.yml` as a block every consumer had to copy. The fork
[`web3eco/shared-actions`](https://github.com/web3eco/shared-actions/pull/103)
copied it and ended up with a different behaviour from the original, because
the behaviour was never written down.

It is now a reusable workflow, and the decisions live in one file —
[`scripts/thread-sync.mjs`](scripts/thread-sync.mjs) — that the reusable
workflow and the reference consumer both run:

```yaml
  - name: Sync inline review threads
    uses: agents-market/github-workflows/.github/workflows/thread-sync.yml@<full-commit-sha>
    with:
      findings: ${{ steps.review.outputs.findings_json }}
      marker: code-review-security-audit
```

The **class** of a finding is its identity — the line moves, the class does
not. The class is the CWE id of a security finding, or the category tag a
style finding opens its message with (`[naming]` → `NAMING`). Two ids that
name one weakness are folded together, so the reader is not shown the same
weakness twice.

A finding that did **not** move keeps its comment: the reader is told once,
not once per push. A finding that moved has its old thread closed and is
posted afresh.

What a consumer may rely on, and what a change breaks, is in
[`docs/thread-sync-contract.md`](docs/thread-sync-contract.md). The contract
has a version, and `scripts/check-thread-sync.mjs` checks that the code and
the document still agree.

### `examples/` — sample integrations

Start here if you want to see something working before you understand anything
else. [`examples/README.md`](examples/README.md) has one command that runs a
pipeline and one workflow file that reviews every PR — both copy-pasteable with
no editing. The workflow file on its own is
[`workflows/ai-code-review.yml`](workflows/ai-code-review.yml).

### GitLab

GitLab does not run GitHub Actions, so the wiring there is its own:
[`workflows/gitlab-code-review.yml`](workflows/gitlab-code-review.yml) is the
same file for `.gitlab-ci.yml`, with the same two pipelines and the same
published runtime behind it. Two CI variables instead of one secret — a
MiniMax key and a GitLab token — and the findings land on the merge request as
one note per pipeline, updated in place.

The review script is [`scripts/gitlab-review.mjs`](scripts/gitlab-review.mjs).
Its calls to the GitLab API were exercised against a stand-in server rather
than a live GitLab, so the first run is the one that proves the API side.

### `.github/workflows/publish.yml`

CI/CD: PR-merge to main → auto-detect changed pipelines → bump version → publish to marketplace.

## Quick start (consumer)

> **Just want to try one? → [`examples/README.md`](examples/README.md)** — one
> command that runs a pipeline, one workflow file that reviews every PR, both
> copy-pasteable without editing.


One command. It downloads the pipeline and runs it — no install step, no
lockfile to understand:

```bash
npx @agentsmarket/cli pipeline call style-review@3.1.0 --local \
  --inputs '{"code_diff":"<git diff>"}'
```

> **Free to pull, and the difference is stated out loud.** The two public
> pipelines — `style-review` and `code-review-security-audit` — cost nothing to
> download, and the command above works with an identity that holds no money.
> A pipeline *with* a price refuses an empty wallet with a `402`, because that
> is what a price is. The smoke test runs both halves on every push, so neither
> can change quietly.

In your own GitHub workflow, one file and five lines of configuration — the
rest is the trigger and the permissions a reusable workflow needs. Every option
has a working default, so there is nothing to choose:

```yaml
# .github/workflows/ai-review.yml
jobs:
  review:
    uses: agents-market/github-workflows/.github/workflows/ai-review.yml@latest
    secrets:
      MINIMAX_API_KEY: ${{ secrets.MINIMAX_API_KEY }}
```

`@latest` is a tag we move to the newest revision that passed the consumer
smoke test, so this works the moment it is pasted, and it keeps working when
we fix something. Pin the commit instead if you would rather your check did
not move under you:

```bash
gh api repos/agents-market/github-workflows/git/ref/tags/latest --jq .object.sha
```

The whole file, unchanged, is
[`workflows/ai-code-review.yml`](workflows/ai-code-review.yml).

Full guide: see [`CONTRIBUTING.md`](CONTRIBUTING.md). The target these examples
are moving towards is in [`VISION.md`](VISION.md).

## What the reader sees

One comment per weakness, standing on the line the review gives this time.
The model's line for a weakness is not stable — the same weakness comes back
on a neighbouring line, sometimes fourteen lines away — so a comment is keyed
by the weakness itself: the CWE id for the security audit, the category tag
for the style review. A new run closes the comment that carried the same
weakness and posts the fresh one. The pull request does not collect a second
copy of every finding.

Two weaknesses of one class in one file stay two comments, and a finding of
another class never hides behind a comment that stands on its line.

Closing a comment needs a token that is allowed to close it. The default
`GITHUB_TOKEN` can delete a review comment but cannot resolve a thread, and a
thread that carries replies is never deleted, only resolved. When a comment
cannot be closed, the standing comment stays and no second one is added: one
comment the reader can see beats two they cannot.

A weakness the review does not report any more keeps its comment. The review
does not take back a finding because one run missed it.

## Architecture (3-tier)

```
agents-market/
├── main                  ← monorepo: server + cli + landing + pipeline-runtime src
├── pipeline-action       ← standalone GH Action (bundled, published to Marketplace)
└── github-workflows      ← THIS REPO. Pipelines + reference workflows.
```

`web3eco/shared-actions` (and any consumer) installs pipelines from here via the marketplace.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). External contributions welcome via PR — see `PULL_REQUEST_TEMPLATE.md`.

## Status

- **Migration from `agents-market/code-review`**: complete. See [TASKS row 114](https://github.com/agents-market/main/blob/main/TASKS.md#row-114) for the epic plan.
- **Canonical pipelines**: seven, all live — see [`pipelines/`](#pipelines--canonical-pipelines). Two migrated from `code-review`; four promoted from `examples/` after a real-model audit; one that reads a production error instead of a diff.

## Removed

`code-review-vulnerability-detection` (formerly `.pipeline.yaml` in the repo root) has been withdrawn. It was an earlier draft of the same idea and is strictly dominated by `code-review-security-audit`: one thin LLM stage instead of a cost-tiered scan → deep-review → aggregate chain, no `cwe_id` / `confidence` / false-positive `rejected` reporting, and its GitHub-side stages were never implemented — the pipeline's own header carried the note `github-pr-* skills are STUBS`. It also posted only `comments[0]`, silently dropping every finding after the first.

Nothing consumed it: the dogfooding review workflow has always used `code-review-security-audit`. Use that instead.

## License

MIT — see [`LICENSE`](LICENSE).
