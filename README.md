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

Each subdirectory is one pipeline. Currently in flight:

| Pipeline | Status | Used by |
|----------|--------|---------|
| _(none yet — G3 in epic plan)_ | — | — |

### `workflows/` — reference GitHub Actions workflows

Thin reusable workflows + examples showing how to invoke pipelines via `agents-market/pipeline-action@v0.4.x`.

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

- **Migration from `agents-market/code-review`**: in progress. See [TASKS row 114](https://github.com/agents-market/main/blob/main/TASKS.md#row-114) for the epic plan.
- **Canonical pipelines**: 0 migrated yet (G0-G4 in the epic). Pilot = `style-review`, then `code-review-security-audit`.

## Legacy

The old `code-review-vulnerability-detection` pipeline (`.pipeline.yaml` in repo root) is still here for backwards compat — the existing dogfooding security-review workflow uses it. Migration plan: it will move to `pipelines/code-review-vulnerability-detection/` in a future epic step.

## License

MIT — see [`LICENSE`](LICENSE).
