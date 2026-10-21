# Examples

Start here if you want to see something working before you understand anything
else. Each example is copy-pasteable as-is — no editing, no choices to make.

## 1. Run one pipeline, one command

Nothing to install first. The pipeline downloads and runs:

```bash
npx @agentsmarket/cli pipeline call style-review@3.1.0 --local \
  --inputs '{"code_diff":"<paste a git diff>"}'
```

Both `style-review@3.1.0` and `style-review@v3.1.0` work — releases are tagged
with a `v`, so people type it, and it is accepted.

The public pipelines are free to download, so the command above works with any
identity, including one that holds no money. A pipeline *with* a price refuses
an empty wallet with a `402` — that is a price, not a broken server.

Prefer to see it without spending anything? Add `--mock` and the pipeline runs
with a stub model, no API key needed.

## 2. Review every pull request in a repository

Add one file, set one secret. Five lines of actual configuration, and every
option already has a working default — there is nothing for you to choose:

```yaml
# .github/workflows/ai-review.yml
name: AI Code Review

on:
  pull_request:
    branches: [main]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    uses: agents-market/github-workflows/.github/workflows/ai-review.yml@<full-commit-sha>
    with:
      pipeline_version: '3.1.0'
    secrets:
      MINIMAX_API_KEY: ${{ secrets.MINIMAX_API_KEY }}
```

Pin a **full commit SHA**, never a tag: a tag can move under you, a SHA cannot.

Pin `pipeline_version` too. Left unset it installs whatever is current, which is
what the repository owning the pipelines wants — it can fix and republish one —
and is the wrong default for you: a PR check that moves under you is not a
check. Bump it deliberately.

This reviews with `code-review-security-audit` and `style-review`, and **fails
the check when a pipeline fails** rather than reporting success it did not
achieve. If a flaky provider must not block your PRs, pass `advisory: 'true'`
to the reusable workflow.

## 3. Pick a different pipeline

The reusable workflow takes optional inputs, each with a default. You never have
to set them:

```yaml
    uses: agents-market/github-workflows/.github/workflows/ai-review.yml@<sha>
    with:
      pipeline_version: '3.1.0'
      advisory: 'true'
```

| Input | Default | What it changes |
|---|---|---|
| `pipeline_version` | `3.1.0` | Which published version to install |
| `focus_area` | per pipeline | Security pipeline: `security`. Style pipeline: `all` |
| `severity` | per pipeline | Minimum severity reported |
| `advisory` | `'false'` | `'true'` reports findings without failing the job |

## What is available

Six pipelines, all published and all installable by the commands above:

| Pipeline | What it does |
|---|---|
| `code-review-security-audit` | Security review of a diff — secrets, injection, authz |
| `style-review` | Style review — naming, types, exports, magic numbers |
| `dependency-scanner` | Review dependency changes for known risk |
| `test-generator` | Generate tests for a diff |
| `documentation-generator` | Generate or update documentation for changed code |
| `api-design-reviewer` | Review API surface and contract changes |

The full catalogue is at [agentsmarket.world/pipelines](https://agentsmarket.world/pipelines/),
and each pipeline's own README describes its inputs and outputs.

## Requirements

- Node.js 20 or newer.
- `MINIMAX_API_KEY` for real runs. It is the model provider's key, not ours —
  requests go to MiniMax, not to a server we proxy. **You cannot substitute
  another provider today**, and it is worth knowing why before you go looking
  for a setting. The Action takes `provider`, `model`, `primary_provider` and
  `primary_model` inputs, and all four are ignored for these pipelines: a stage
  that declares its own provider wins (`stages.ts:495`), and a stage's own model
  wins over everything (`model-resolver.ts:232`). Both fields also read as
  literals — `provider: ${input.provider}` is not resolved from inputs, it is
  treated as a provider literally named `${input.provider}` and the run fails
  with "not registered". Lifting this needs the runtime to resolve input refs on
  those two fields; it is written up rather than promised.
- Agent identity. `pipeline call` downloads from the marketplace, which is an
  authenticated request. Run `npx @agentsmarket/cli init` once to generate a
  keypair.

## Before you wire one of these to a real repository

`code-review-security-audit` and `style-review` judge and explain; the
judgements are judgement, and that is what a model is for.

**`dependency-scanner` is not one of the safe ones.** It asks a model to name
CVEs for pinned versions. The model has no database, so it answers from weights:
on `lodash@4.17.15` it named four identifiers, two of which apply to that
version and two of which do not, and it missed four real advisories including
two published in 2025 and 2026. `confidence` came back different on each of
three identical runs. `parse_lockfile` is sound; `analyze_vulns` is not.

Use it to list what is pinned, not to decide what to patch. For patching, use
`npm audit`, `pip-audit` or `osv-scanner` until that stage is a database lookup.
The full measurement is in the pipeline's own README.

## If something fails

- `Pipeline file not found` — run `npx @agentsmarket/cli init` first, then retry.
- `version must be a valid semver string (X.Y.Z)` — you typed `@v1.0.0`.
  Versions are bare: `2.0.4`.
- `Agent not initialized` — same as the first one; `init` writes
  `~/.config/agentsmarket/agent.key`.

Full detail: [agentsmarket.world/docs](https://agentsmarket.world/docs/).