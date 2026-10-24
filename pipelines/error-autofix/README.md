---
name: error-autofix
version: 1.1.0
description: |
  AI error autofixer — takes a production error (message + stack trace) and the
  source files it points at, and returns the root cause, a concrete fix (the
  exact old snippet and its replacement) and a test that reproduces the error.
  Knows nothing about GitHub: the caller applies the patch and opens the pull
  request. Free to download; a server call costs the tokens it uses.
license: MIT
author: agentsmarket-team
price_usdc: 0
call_price_usdc: 0
tags: [autofix, debugging, vertical-wedge]
public_preview: Production error → root cause + a concrete fix + a reproducing test, as snippets the caller applies. Knows nothing about GitHub; the caller decides pull request or issue.
---

# error-autofix

An error arrives from production. This pipeline says what is actually wrong and
what to change about it.

It is deliberately ignorant of GitHub. It takes the error, the files the stack
points at, and gives back:

1. **`analyze_error`** — the root cause: the error class, the faulty line, the
   explanation, and whether the fault can be fixed by changing one file.
2. **`propose_fix`** — the fix itself: the exact text to replace, the text that
   replaces it, why it stops the error, and a test that fails before and passes
   after.

The caller owns everything else — the branch, the token, the pull request. That
boundary is the point: the same pipeline serves a GitHub workflow, a GitLab
pipeline, a cron job that opens an issue, or a person reading the output in a
terminal.

## When to use

- A production error whose stack trace points at your own code
- A crash you can reproduce from the log line alone
- Nightly "what broke this week" triage, batched over a list of errors

Not for a crash whose stack points into a dependency, and not for a bug with no
stack at all — the pipeline is given the files the error points at, and without
them it says so instead of guessing.

## Configuration

| Input | Type | Default | Description |
|-------|------|---------|-------------|
| `error_report` | string (1..20000 chars) | **required** | The error as production produced it: message + stack trace |
| `source_files` | object | **required** | `{path: contents}` — the files the stack points at |
| `repo_context` | string (0..4000 chars) | `""` | What the service is, which framework, the conventions to follow |
| `playbook` | object | `{}` | The consumer's own record of a known issue that this error matched |

## The playbook

Not every error has a position. A failed dynamic import — `Load failed` in
Safari, `Failed to fetch dynamically imported module` in Chrome — happens
before there is a stack frame to point at, and there is nothing to resolve.
The playbook is the answer: the consumer writes down the errors they already
know about and the fix each of them gets, and the pipeline is told about the
one that matched.

It is configuration, not code. The pipeline and the workflow are the same in
every consumer's repository; the specifics of a consumer's errors live in the
consumer's own file. The reference wiring reads it from
`.error-playbook.json` in the repository root:

```json
{
  "issues": [
    {
      "signature": "Load failed",
      "match": "contains",
      "approach": "The lazy chunk is gone after a deploy: catch the failed import and reload once, guarded by a sessionStorage flag.",
      "files_hint": ["src/pages/_app.tsx"],
      "needs_location": false
    }
  ]
}
```

| Key | Meaning |
|-----|---------|
| `signature` | What to match against the error. Required. |
| `match` | `contains` (default, the message only), `exact` (the message only), or `regex` (the whole report) |
| `approach` | The fix the consumer expects, in their words |
| `files_hint` | The files the fix belongs in |
| `needs_location` | `false` when the error carries no position at all — the analysis then reports line `0` instead of inventing one |

The first entry that matches wins, so the order in the file is the order of
precedence. The reference wiring matches the signature itself, in code: a
model deciding whether an error is a known issue is a model that decides
differently twice.

## Output envelope

```json
{
  "analysis": {
    "error_class": "TypeError",
    "root_cause": "user.name is read before the null check that guarantees it",
    "file": "src/api/users.ts",
    "line": 42,
    "explanation": "getName() is called with a user that may be null, and the first thing it does is read user.name.",
    "fixable": true,
    "confidence": 0.9
  },
  "fix": {
    "file": "src/api/users.ts",
    "old_snippet": "  const name = user.name;",
    "new_snippet": "  const name = user?.name ?? '';",
    "explanation": "The name is read through an optional chain, so a missing user yields an empty name instead of a TypeError.",
    "test_path": "tests/users.test.ts",
    "test_content": "test('returns an empty name for a missing user', () => {\n  expect(getName(null)).toBe('');\n});",
    "confidence": 0.9
  }
}
```

## The rule the caller has to enforce

**`old_snippet` has to be in the file, byte for byte.** The caller replaces that
exact text and refuses the fix when it is not there. That is the whole reason
the pipeline returns snippets and not a diff: a diff written by a model does not
apply, and a patch that does not apply is a pull request that cannot be
reviewed.

So the caller checks three things before it opens anything:

1. `old_snippet` occurs exactly once in `file`;
2. the resulting patch is not empty;
3. a test was written.

One file changed, a non-empty patch, a test — then it is a pull request. Anything
else is an issue with the analysis attached. The reference wiring is
[`workflows/ai-error-autofix.yml`](../../workflows/ai-error-autofix.yml) in this
repository.

## Installation

```bash
agentsmarket pipeline install error-autofix
# → creates .agentsmarket/pipelines/error-autofix@<version>/{pipeline.yaml, README.md, metadata.json}
```

Without a version this installs the latest release. To pin one:

```bash
agentsmarket pipeline info error-autofix
```

`MINIMAX_API_KEY` in the environment. The stages are pinned to the MiniMax
provider and model today.

## Usage in GitHub Actions

```yaml
- name: Install pipeline
  run: agentsmarket pipeline install error-autofix@<version>

- name: Run the autofix
  uses: agents-market/pipeline-action@6bd47c46ae97d1f9e2beaea3738849b33db65adf # v0.4.4 (verified; newer may exist)
  env:
    MINIMAX_API_KEY: ${{ secrets.MINIMAX_API_KEY }}
  with:
    pipeline_file: .agentsmarket/pipelines/error-autofix@<version>/pipeline.yaml
    inputs_json: |
      {
        "error_report": "TypeError: ...\n    at getName (src/api/users.ts:42:18)",
        "source_files": { "src/api/users.ts": "export function getName(user) {...}" },
        "repo_context": "Node 20, TypeScript, vitest for tests.",
        "playbook": {}
      }
```

## What it will not do

- **It does not invent a file.** If the stack points at code that was not given
  to it, `fixable` is false and `explanation` says what is missing.
- **It does not count.** There are no counts in the output — the caller counts.
- **It does not open anything.** No token, no branch, no pull request. That is
  the caller's job, and it is where the decision to open a pull request at all
  belongs.

## Pricing

Free to download. A server call costs the tokens it uses — two stages on
MiniMax-M3.

## License

MIT — see [`LICENSE`](../../LICENSE) in the repo root.
