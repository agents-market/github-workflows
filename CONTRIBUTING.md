# Contributing

Thanks for contributing to `agents-market/github-workflows`! This repo is the canonical source for [agentsmarket.world](https://agentsmarket.world) marketplace pipelines and reference GitHub Actions workflows.

## Adding a new pipeline

### 1. Create the pipeline folder

```
pipelines/<your-pipeline-slug>/
├── pipeline.yaml       ← spec (stages only)
└── README.md           ← frontmatter + markdown description
```

### 2. Write `pipeline.yaml` (spec only, no metadata)

```yaml
name: your-pipeline-slug
defaults:
  model: MiniMax-M3

inputs:
  provider:
    type: string
    required: false
    default: minimax
  model:
    type: string
    required: false
    default: MiniMax-M3
  some_input:
    type: string
    required: true

stages:
  - id: stage-one
    provider: ${input.provider}
    model: ${input.model}
    system: "You are ..."
    prompt: |
      Process ${input.some_input}.
    output_format: structured_json
    fields: [findings, summary]
```

**Important:**
- Spec only — no `# metadata` comments at top. Metadata lives in `README.md` frontmatter.
- The provider is an input, not a name in the spec: `provider: ${input.provider}`, with a declared default. A stage that names a provider outright wins over the Action's `provider` input, and the caller pays for a provider they did not choose.
- The model travels with it: `model: ${input.model}`. The provider's own list says which model exists, so a model left in the spec would make the provider input a promise the pipeline cannot keep — the id depends on the provider, `MiniMax-M3` on minimax and `openai/gpt-4-turbo` on openrouter.
- LLM stage prompts MUST require `file` and `line` fields explicitly (integer line number, not range). Without these, the action drops findings as missing metadata. See [TASKS row 113](https://github.com/agents-market/main/blob/main/TASKS.md#row-113) for the bug class.

### 3. Write `README.md` (frontmatter + body)

```markdown
---
name: your-pipeline-slug
description: "One-line description for marketplace listing."
author: your-github-username
homepage_url: https://github.com/your-username/your-pipeline-repo
support_url: https://github.com/agents-market/github-workflows/discussions
license: MIT
tags: [category, subcategory]
---

# Your Pipeline Name

Longer description here. What does it do? When should you use it?

## Usage

\`\`\`yaml
- uses: agents-market/pipeline-action@ca2c4905cfc36c33aa3e46af1288b55fc0189343 # v0.4.11 (merges the declared input defaults)
  with:
    pipeline_file: ./pipelines/your-pipeline-slug/pipeline.yaml
\`\`\`

## Inputs

| Input | Type | Required | Description |
|-------|------|----------|-------------|
| `provider` | string | no | The LLM provider for this run. `minimax` by default. |
| `model` | string | no | The LLM model for this run. `MiniMax-M3` by default, and it must be one the chosen provider carries. |
| `some_input` | string | yes | ... |

## Outputs

See `findings_json` action output — array of `{severity, file, line, message, cwe, confidence, recommendation}`.

## Examples

\`\`\`yaml
- uses: agents-market/pipeline-action@ca2c4905cfc36c33aa3e46af1288b55fc0189343 # v0.4.11 (merges the declared input defaults)
  with:
    # The action runs what the caller passes; it does not read a spec's defaults.
    provider: minimax
    model: MiniMax-M3
    pipeline_file: ./pipelines/your-pipeline-slug/pipeline.yaml
    inputs_json: '{"provider": "minimax", "model": "MiniMax-M3", "some_input": "value"}'
\`\`\`

## Configuration

Anything operators can tune — severity threshold, model override, etc.
```

### 4. Local test

```bash
# Install locally
agentsmarket pipeline install ./pipelines/your-pipeline-slug --target-dir /tmp/test

# Run with mock provider
agents-market/pipeline-action --pipeline_file /tmp/test/your-pipeline-slug/pipeline.yaml --mock

# Verify outputs + summary render correctly
```

### 5. Open PR

PR triggers `.github/workflows/publish.yml` (dry-run in CI): validates spec, checks metadata, runs canonical smoke.

After merge, the pipeline is auto-published to marketplace with auto-bumped minor version.

## Adding a new reference workflow

```
workflows/<your-workflow-name>.yml
```

Must be:
- ≤ 250 lines
- Use only official marketplace actions (`agents-market/pipeline-action@ca2c4905cfc36c33aa3e46af1288b55fc0189343 # v0.4.11 (merges the declared input defaults)`)
- No hardcoded secrets (use `secrets:` references)
- Single-purpose (no kitchen-sink workflows)

## Pinning the pipeline action

Always pin to a **full commit SHA**, not a tag:

```yaml
uses: agents-market/pipeline-action@ca2c4905cfc36c33aa3e46af1288b55fc0189343 # v0.4.11 (merges the declared input defaults)
```

We hand you a SHA and dogfood on `main`, which looks inconsistent and is not.
You pin because a tag that moves turns a PR check into a coin toss — tag `v1` in
that repository moved, shipped an `action.yml` the runner could not parse, and
stayed broken for three weeks. We track `main` because we publish the action: a
pin here means this repository reviews itself with whatever shipped before the
last thing, which is how it went three weeks stale before anyone noticed.

The SHA above is the release we verified, not a claim that it is the newest. No
bot updates these docs, and none can be relied on to.

If you want the newest release, take the tag with the newest **commit date** and
pin its SHA. Do not take it from the version number or from the releases page —
both of those lie in that repository today:

| what you read | what you get | what is actually newest |
|---|---|---|
| highest version, `v1.0.0` | 17 Sep 2026 | `v0.4.4`, 2 Oct 2026 |
| `releases/latest` | `v0.4.3`, 27 Sep 2026 | `v0.4.4`, 2 Oct 2026 |

```bash
gh api repos/agents-market/pipeline-action/commits/v0.4.4 --jq .sha
```

A tag is a moving pointer. Tag `v1` sat broken for three weeks — it pointed at a
commit whose `action.yml` was not parseable YAML, so any consumer copying
`@v1` from the README got a red check failing at *Set up job*, with a parser
error that named neither the repository nor the ref. Re-cut on 2026-10-16; see
[pipeline-action#2](https://github.com/agents-market/pipeline-action/pull/2).

A SHA turns "the action moved under me" into a deliberate, reviewable bump.

## Pinning the review workflow

The action is pinned by SHA. The review workflow is not, and the difference is
deliberate.

`workflows/ai-code-review.yml` — the file adopters paste — calls the reusable
workflow at `@latest`:

```yaml
uses: agents-market/github-workflows/.github/workflows/ai-review.yml@latest
```

`latest` is a tag we move to the newest revision that passed the consumer smoke
test. A pin cannot do that job: nobody outside this repository knows our commit
SHA, so an example with a SHA in it is not an example, it is an editing task.
The tag keeps the example pasteable and keeps fixes reaching the people who
pasted it.

The tag moves by machinery, not by memory: `.github/workflows/tag-latest.yml`
waits for the smoke test to pass and moves `latest` to the revision that
passed. A promise has to be kept by something.

For a check that must not move under you, pin the commit instead:

```bash
gh api repos/agents-market/github-workflows/git/ref/tags/latest --jq .object.sha
```

The same rule applies to the two pipeline versions, which are separate inputs
(`audit_version`, `style_version`) because the two pipelines are released on
their own schedule.

Two related traps when writing workflows by hand — both cost a round-trip on
[PR #3](https://github.com/agents-market/github-workflows/pull/3):

- The `env` context is **not available in `uses:`** (only `github`, `needs`,
  `strategy`, `matrix`, `inputs`, `vars`). Referencing `${{ env.X }}` there fails
  whole-workflow validation with zero jobs and no error message.
- `matrix: {include: [...]}` with no base key spreads its entries **flat**, so
  `matrix.pipeline.slug` resolves to nothing. Use `matrix: {pipeline: [...]}`.

## License

By contributing, you agree to license your contribution under MIT (matching this repo).
