# agents-market/github-workflows

> **Public community repo for AI pipelines + reference GitHub workflows.**
> Pipelines are published to [agentsmarket.world](https://agentsmarket.world) marketplace from here.
> Consumers install via [`@agentsmarket/cli`](https://www.npmjs.com/package/@agentsmarket/cli) → `agentsmarket pipeline install <slug>@<version>`.

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

| Pipeline | Input | Stages | Marketplace |
|----------|-------|--------|-------------|
| [`code-review-security-audit`](pipelines/code-review-security-audit/) | source diff | 3 | 2.0.2 |
| [`style-review`](pipelines/style-review/) | source diff | 3 | 2.0.2 |
| [`dependency-scanner`](pipelines/dependency-scanner/) | lockfile | 3 | 2.0.1 |
| [`api-design-reviewer`](pipelines/api-design-reviewer/) | API spec | 3 | 2.0.1 |
| [`documentation-generator`](pipelines/documentation-generator/) | source diff | 3 | 2.0.1 |
| [`test-generator`](pipelines/test-generator/) | source diff | 3 | 2.0.1 |

The first two came from the `agents-market/code-review` migration. The other
four were promoted out of `agents-market/main/examples/` on 2026-10-17, after
every example was run end-to-end against a real MiniMax-M3: of 20, ten execute,
and these four cover four different input domains. The examples that did not
execute are withdrawn from the catalogue.

**All six share one shape** — three stages, `structured_json` at every hop.
What differs is the input, not the design. Treat them as one pattern with six
front-ends until something genuinely multi-stage (a loop, a fan-out, a tool
call) runs reliably enough to be canonical.

Nothing executes `test.yaml` today: `agentsmarket pipeline test` is disabled in
the CLI for 0.10.0. The files are written down so the expectations are
reviewable, not because CI checks them.

### `workflows/` — reference GitHub Actions workflows

`workflows/ai-code-review.yml` is the consumer-side wiring. Copy it to
`.github/workflows/ai-review.yml` in your repo, set `MINIMAX_API_KEY`, and pin
`agents-market/github-workflows/.github/workflows/ai-review.yml` to a full
commit SHA. The review logic lives in that one file, so a fix ships here once
and every consumer gets it on the next pin bump.

Inputs are optional. `pipeline_version` defaults to `1.0.1`; `focus_area` and
`severity` are left unset on purpose, so each pipeline keeps its own default
(`security` for the audit, `all` for style). `advisory` is a string, `"true"`
by default: findings are reported but a failing pipeline does not block the
PR. Pass `"false"` to make it a required check.

For wiring a pipeline directly rather than through the review workflow, see
`agents-market/pipeline-action@v0.4.x`.

### `examples/` — sample integrations

End-to-end examples per language stack (TypeScript, Python, Rust, Solidity).

### `.github/workflows/publish.yml`

CI/CD: PR-merge to main → auto-detect changed pipelines → bump version → publish to marketplace.

## Quick start (consumer)

```bash
# Install a pipeline from this repo to your local project
agentsmarket pipeline install style-review@v1.0.0
# → creates .agentsmarket/pipelines/style-review@v1.0.0/{pipeline.yaml,README.md,metadata.json}

# Use it in your GitHub workflow
```

```yaml
# .github/workflows/ai-review.yml
- name: Install pipeline
  run: agentsmarket pipeline install style-review@v1.0.0 code-review-security-audit@v1.0.0
  env:
    AGENTSMARKET_PRIVATE_KEY: ${{ secrets.PUBLISH_KEY }}

- name: Run style-review
  uses: agents-market/pipeline-action@v0.4.x
  with:
    pipeline_file: .agentsmarket/pipelines/style-review@v1.0.0/pipeline.yaml
```

Full guide: see [`CONTRIBUTING.md`](CONTRIBUTING.md).

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
- **Canonical pipelines**: six, all live — see [`pipelines/`](#pipelines--canonical-pipelines). Two migrated from `code-review`; four promoted from `examples/` after a real-model audit.

## Removed

`code-review-vulnerability-detection` (formerly `.pipeline.yaml` in the repo root) has been withdrawn. It was an earlier draft of the same idea and is strictly dominated by `code-review-security-audit`: one thin LLM stage instead of a cost-tiered scan → deep-review → aggregate chain, no `cwe_id` / `confidence` / false-positive `rejected` reporting, and its GitHub-side stages were never implemented — the pipeline's own header carried the note `github-pr-* skills are STUBS`. It also posted only `comments[0]`, silently dropping every finding after the first.

Nothing consumed it: the dogfooding review workflow has always used `code-review-security-audit`. Use that instead.

## License

MIT — see [`LICENSE`](LICENSE).
