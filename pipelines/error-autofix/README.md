---
name: error-autofix
version: 1.1.2
description: 'AI error autofixer — takes a production error and the source files it points at, returns the root cause, a concrete fix and a reproducing test. Knows nothing about GitHub: the caller applies the patch and opens the pull request.'
license: MIT
author: agentsmarket-team
price_usdc: 0
call_price_usdc: 0
tags: [autofix, debugging, vertical-wedge]
public_preview: Production error → root cause + a concrete fix + a reproducing test, as snippets the caller applies. The caller owns the pull request.
---

# error-autofix

An error arrives from production. This pipeline says what is actually wrong and
what to change about it.

It is ignorant of GitHub on purpose. It takes the error, the files the stack
points at, and gives back:

1. **`analyze_error`** — the root cause: the error class, the faulty line, the
   explanation, and whether the fault can be fixed by changing one file.
2. **`propose_fix`** — the fix itself: the exact text to replace, the text that
   replaces it, why it stops the error, and a test that fails before and passes
   after.

The caller owns the branch, the token and the pull request. That boundary is
the point: the same pipeline serves a GitHub workflow, a cron job, or a person
reading the output in a terminal.

## When to use

- A production error whose stack trace points at your own code
- A crash you can reproduce from the log line alone
- Nightly "what broke this week" triage, batched over a list of errors

Not for a crash whose stack points into a dependency, and not for a bug with no
stack at all: without the files, the pipeline says so instead of guessing.

## Configuration

| Input | Type | Default | Description |
|-------|------|---------|-------------|
| `error_report` | string (1..20000 chars) | **required** | The error as production produced it: message + stack trace |
| `source_files` | object | **required** | `{path: contents}` — the files the stack points at |
| `repo_context` | string (0..4000 chars) | `""` | What the service is, which framework, the conventions to follow |
| `playbook` | object | `{}` | The consumer's own record of a known issue that this error matched |
| `provider` | enum | `minimax` | `minimax` / `openrouter` / `openai` / `anthropic` / `replicate` |
| `model` | string | `MiniMax-M3` | The LLM model for this run — must be one the chosen provider carries |

## The playbook

Not every error has a position. A failed dynamic import — `Load failed` in
Safari — happens before there is a stack frame to point at. The playbook is the
answer: the consumer writes down the errors they already know about and the fix
each of them gets, and the pipeline is told about the one that matched.

It is configuration, not code: the pipeline and the workflow are the same in
every consumer's repository, and the specifics live in the consumer's own file.
The reference wiring reads it from `.error-playbook.json` in the repository
root:

```json
{
  "issues": [
    {
      "signature": "Load failed",
      "match": "contains",
      "approach": "Catch the failed import and reload once.",
      "files_hint": ["src/pages/_app.tsx"],
      "needs_location": false
    }
  ]
}
```

| Key | Meaning |
|-----|---------|
| `signature` | What to match against the error. Required. |
| `match` | `contains` (default) / `exact` / `regex` (the whole report) |
| `approach` | The fix the consumer expects, in their words |
| `files_hint` | The files the fix belongs in |
| `needs_location` | `false` when the error carries no position — the analysis reports line `0` instead of inventing one |

The first entry that matches wins, so the order in the file is the order of
precedence. The reference wiring matches the signature itself, in code — a model
deciding this decides differently twice.

## Output envelope

```json
{
  "analysis": {
    "error_class": "TypeError",
    "root_cause": "user.name is read before the null check that guarantees it",
    "file": "src/api/users.ts",
    "line": 42,
    "explanation": "getName() is called with a user that may be null, and reads user.name first.",
    "fixable": true,
    "confidence": 0.9
  },
  "fix": {
    "file": "src/api/users.ts",
    "old_snippet": "  const name = user.name;",
    "new_snippet": "  const name = user?.name ?? '';",
    "explanation": "An optional chain yields an empty name instead of a TypeError.",
    "test_path": "tests/users.test.ts",
    "test_content": "test('returns an empty name for a missing user', () => {\n  expect(getName(null)).toBe('');\n});",
    "confidence": 0.9
  }
}
```

## The rule the caller has to enforce

**`old_snippet` has to be in the file, byte for byte.** The caller replaces that
exact text and refuses the fix when it is not there. That is why the pipeline
returns snippets and not a diff: a diff written by a model does not apply, and a
patch that does not apply is a pull request nobody can review.

The caller checks three things before it opens anything: `old_snippet` occurs
exactly once in `file`, the patch is not empty, and a test was written. One file
changed, a non-empty patch, a test — then it is a pull request; anything else is
an issue with the analysis attached. The reference wiring is
[`workflows/ai-error-autofix.yml`](../../workflows/ai-error-autofix.yml); the
policy around that bot is in
[`scripts/error-autofix.mjs`](../../scripts/error-autofix.mjs).

Resolving a minified bundle to a source file is the caller's job too: it needs
the source map, and the map is the consumer's.

## Reading the stage output

The action escapes what it writes to the outputs file — `%` becomes `%25`, a
newline `%0A` — because a workflow output is one line. This stage answers
JSON, and a model writes JSON over several lines as often as over one: when
it indents, the output arrives escaped, and a caller that parses it as it stands
gets nothing. Unescape it — newlines first, then percent signs:
`text.replace(/%0A/g, '\n').replace(/%25/g, '%')`. The reference wiring does
this, and falls back to `result_json` when the stage output cannot be read.

## Installation

```bash
agentsmarket pipeline install error-autofix
# → creates .agentsmarket/pipelines/error-autofix@<version>/{pipeline.yaml, README.md, metadata.json}
```

Without a version this installs the latest release; `agentsmarket pipeline info
error-autofix` lists what is published. `MINIMAX_API_KEY` in the environment.
The provider is the `provider` input and the model is the `model` input —
`minimax` and `MiniMax-M3` by default.

## Usage in GitHub Actions

```yaml
- name: Install pipeline
  run: agentsmarket pipeline install error-autofix@<version>

- name: Run the autofix
  uses: agents-market/pipeline-action@434ff6c46d82e34d601233e00bd2c564c68baa08 # v0.4.9 (resolves ${input.provider})
  env:
    MINIMAX_API_KEY: ${{ secrets.MINIMAX_API_KEY }}
  with:
    # The action runs what the caller passes; it does not read a spec's defaults.
    provider: minimax
    model: MiniMax-M3
    pipeline_file: .agentsmarket/pipelines/error-autofix@<version>/pipeline.yaml
    inputs_json: '{"provider": "minimax", "model": "MiniMax-M3", "error_report": "TypeError: ...", "source_files": {"src/api/users.ts": "..."}, "repo_context": "Node 20", "playbook": {}}'
```

## What it will not do

- **It does not invent a file.** If the stack points at code that was not given
  to it, `fixable` is false and `explanation` says what is missing.
- **It does not count.** There are no counts in the output — the caller counts.
- **It does not open anything.** No token, no branch, no pull request: that
  decision belongs to the caller.

## Pricing

Free to download. A server call costs the tokens it uses — two stages on
MiniMax-M3.

## License

MIT — see [`LICENSE`](../../LICENSE) in the repo root.
