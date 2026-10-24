# Examples

Start here if you want to see something working before you understand anything
else. Each example is copy-pasteable as-is — no editing, no choices to make.

## 1. Run one pipeline, one command

Nothing to install first. The pipeline downloads and runs:

```bash
npx @agentsmarket/cli pipeline call style-review@3.2.1 --local \
  --inputs '{"code_diff":"<paste a git diff>"}'
```

Both `style-review@3.2.1` and `style-review@v3.2.1` work — releases are tagged
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

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  review:
    uses: agents-market/github-workflows/.github/workflows/ai-review.yml@latest
    secrets:
      MINIMAX_API_KEY: ${{ secrets.MINIMAX_API_KEY }}
```

That is the whole file, unchanged:
[`workflows/ai-code-review.yml`](../workflows/ai-code-review.yml).

`@latest` is a tag we move to the newest revision that passed the consumer
smoke test. It works the moment you paste it, and a fix we publish still
reaches you without a pin bump. If you would rather your check not move under
you, pin the commit instead:

```bash
gh api repos/agents-market/github-workflows/git/ref/tags/latest --jq .object.sha
```

The `permissions` block is not decoration. A reusable workflow can only narrow
the permissions it is given, so a caller that does not grant `pull-requests:
write` gets a review that runs and cannot post.

The two pipelines are installed at their current versions. To pin them, add
`audit_version` and `style_version` under `with:` — one each, because the two
are released on their own schedule and a version that fits one of them does
not exist for the other.

This reviews with `code-review-security-audit` and `style-review`, and **fails
the check when a pipeline fails** rather than reporting success it did not
achieve. If a flaky provider must not block your PRs, pass `advisory: 'true'`
to the reusable workflow.

## 3. Pick a different pipeline

The reusable workflow takes optional inputs, each with a default. You never have
to set them:

```yaml
    uses: agents-market/github-workflows/.github/workflows/ai-review.yml@latest
    with:
      advisory: 'true'
```

| Input | Default | What it changes |
|---|---|---|
| `audit_version` | current | Which published version of the security audit to install |
| `style_version` | current | Which published version of the style review to install |
| `focus_area` | per pipeline | Security pipeline: `security`. Style pipeline: `all` |
| `severity` | per pipeline | Minimum severity reported — read the note below |
| `advisory` | `'false'` | `'true'` reports findings without failing the job |

## 4. Fix an error from production, automatically

The error goes in, a pull request with the fix and a test comes out. Copy
[`workflows/ai-error-autofix.yml`](../workflows/ai-error-autofix.yml) to
`.github/workflows/ai-error-autofix.yml` in your repository and add the same
one secret, `MINIMAX_API_KEY`. The trigger is yours to choose:

```yaml
on:
  repository_dispatch:
    types: [production_error]
```

and it also runs by hand (`workflow_dispatch`) with an error pasted in. The
permissions it needs are the ones it asks for: `contents: write` to push the
fix branch, `pull-requests: write` to open the pull request, `issues: write`
to open the issue when the fix is not mechanical.

What it does with the error is the part worth knowing:

- the `error-autofix` pipeline says what is wrong and what to change;
- the workflow applies the change only when it is mechanical — one file, the
  text to replace present exactly once, a test written — and opens a pull
  request;
- anything else becomes an **issue** with the analysis attached, because a pull
  request nobody can review is worse than an issue;
- the pull request is reviewed by the same AI review as every other pull
  request, called explicitly: GitHub does not run workflows for a pull request
  opened by its own token.

Not every error has a position. A failed dynamic import — `Load failed` in
Safari — happens before there is a stack frame to point at. For those, keep a
`.error-playbook.json` in your repository: the errors you already know about
and the fix each of them gets. A matched entry names the files the fix
belongs in, and the pipeline is told the recipe instead of guessing. The
format is in the
[pipeline README](../pipelines/error-autofix/README.md#the-playbook).

And a minified bundle has no position either: `js/app-HASH.js:1:141` means
nothing without the source map. The workflow resolves the frames through it —
the map of a bundle is the bundle's own path with `.map` added — and reads it
from your checkout (`MAPS_DIR`) or from a URL (`MAPS_BASE_URL`, a repository
variable). Without a map the position is not resolved, and the run says so
instead of guessing.

The workflow fetches the script that resolves the stack and applies the fix
from this repository, at the `latest` tag — the same promise the review
workflow makes. To pin it, set `AI_AUTOFIX_REF` to a commit SHA.

## 5. The same review on GitLab

GitLab does not run GitHub Actions, so the wiring there is its own file:
[`workflows/gitlab-code-review.yml`](../workflows/gitlab-code-review.yml).
Same two pipelines, same published runtime, same finding on the same merge
request — the difference is the API on the other side.

Two CI variables instead of one secret: `MINIMAX_API_KEY` and `GITLAB_TOKEN`
(a project access token with the `api` scope). The findings land as one note
per pipeline, updated in place.

### Which severity floor to use

The security audit's own default is `medium`, and it is the one to keep: on
this repository's fixture it found every planted weakness and invented
nothing. On that fixture that means the eleven planted weaknesses plus one to
three observations about missing controls (a route without auth, no CSRF
token). They point at real absences, but they are not weaknesses anyone
planted.

The floor is a **hint to the model, not a filter**. The stage is told to drop
findings below it and to report the dropped ones separately; the model decides
what "below" means. Three consequences you can plan around:

- **The sets are not nested.** A higher floor is not a subset of a lower one.
  The severity is the model's own rating, and it moves between runs.
- **Raising the floor does not reliably shrink the output.** On the fixture
  `high` and `critical` still reported all eleven planted weaknesses.
- **Lowering the floor can lose real weaknesses.** At `low` the audit dropped
  the open redirect, the prototype pollution and the weak crypto — and the
  second pass then found nothing to replace them.

So: use **`high`** when the review is a *gate* and you want to see what the
model rates serious, and expect the set to change rather than to shrink. Use
**`low`** for a first look at unfamiliar code, never as a gate. Use
**`critical`** as a last-resort gate — it is a stricter hint to the same model,
not a guarantee.

## What is available

Seven pipelines, all published and all installable by the commands above:

| Pipeline | What it does |
|---|---|
| `code-review-security-audit` | Security review of a diff — secrets, injection, authz |
| `style-review` | Style review — naming, types, exports, magic numbers |
| `dependency-scanner` | Review dependency changes for known risk |
| `test-generator` | Generate tests for a diff |
| `documentation-generator` | Generate or update documentation for changed code |
| `api-design-reviewer` | Review API surface and contract changes |
| `error-autofix` | Turn a production error into a fix and a reproducing test |

The full catalogue is at [agentsmarket.world/pipelines](https://agentsmarket.world/pipelines/),
and each pipeline's own README describes its inputs and outputs.

## Requirements

- Node.js 20 or newer.
- `MINIMAX_API_KEY` for real runs. It is the model provider's key, not ours —
  requests go to the provider, not to a server we proxy. **You cannot substitute
  another provider today**, and it is worth knowing why before you go looking
  for a setting. The Action takes `provider`, `model`, `primary_provider` and
  `primary_model` inputs, and all four are ignored for these pipelines: a stage
  that declares its own provider wins, and a stage's own model wins over
  everything. The provider is written into the spec on purpose — a stage that
  reads `provider: ${input.provider}` instead does work from CLI 0.12.5 on and
  from the marketplace, but the Action's bundled runtime still reads that field
  literally and refuses to run the pipeline.
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