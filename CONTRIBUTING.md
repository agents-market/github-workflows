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
  some_input:
    type: string
    required: true

stages:
  - id: stage-one
    provider: minimax
    model: MiniMax-M3
    system: "You are ..."
    prompt: |
      Process ${input.some_input}.
    output_format: structured_json
    fields: [findings, summary]
```

**Important:**
- Spec only — no `# metadata` comments at top. Metadata lives in `README.md` frontmatter.
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
- uses: agents-market/pipeline-action@v0.4.x
  with:
    pipeline_file: ./pipelines/your-pipeline-slug/pipeline.yaml
\`\`\`

## Inputs

| Input | Type | Required | Description |
|-------|------|----------|-------------|
| `some_input` | string | yes | ... |

## Outputs

See `findings_json` action output — array of `{severity, file, line, message, cwe, confidence, recommendation}`.

## Examples

\`\`\`yaml
- uses: agents-market/pipeline-action@v0.4.x
  with:
    pipeline_file: ./pipelines/your-pipeline-slug/pipeline.yaml
    inputs_json: '{"some_input": "value"}'
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
- Use only official marketplace actions (`agents-market/pipeline-action@v0.4.x`)
- No hardcoded secrets (use `secrets:` references)
- Single-purpose (no kitchen-sink workflows)

## License

By contributing, you agree to license your contribution under MIT (matching this repo).
