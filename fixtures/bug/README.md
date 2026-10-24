# The end-to-end fixture

A bug on purpose, and the proof that the whole chain works: a real error, a
real model, a real fix, a real branch, and something filed for a human to
look at.

`src/users.ts` reads `user.name` on a parameter that may be `null`. The
error it produces is the one the workflow was given:

```
TypeError: Cannot read properties of null (reading 'name')
    at getName (fixtures/bug/src/users.ts:8:12)
```

## How it was run

```bash
cp workflows/ai-error-autofix.yml .github/workflows/ai-error-autofix.yml
git commit -am "the proof" && git push
gh workflow run ai-error-autofix.yml --ref main \
  -f error_report="TypeError: Cannot read properties of null (reading 'name')
    at getName (fixtures/bug/src/users.ts:8:12)" \
  -f repo_context="TypeScript, vitest. The function is used by the pages; keep the signature."
```

What came out of it, on 24 October 2026:

- the model named the fault — `getName` dereferences the nullable parameter —
  and changed one line: `user?.name ?? ''`;
- it wrote the test that fails before and passes after
  (`tests/users.test.ts`);
- the patch was computed by the script from the snippets, not by the model,
  and the branch `fix/auto-3f2e7ed9` carried it;
- the canonical review — security audit and style review — ran on it and
  passed;
- the fix was filed for a human.

The fix was filed as an **issue**, not a pull request, and that is the
repository's setting, not the workflow's: the organization forbids GitHub
Actions from creating pull requests, so `gh pr create` is refused with
"GitHub Actions is not permitted to create or approve pull requests". The
workflow does not lose the fix when that happens — it pushes the branch and
files the issue — and it says which of the two happened.

Two things only a real run could have found, and both were found:

1. `gh label create` needs `--repo` in a job that never checks the repository
   out. The label was never created, and the pull request that followed could
   not carry it.
2. The pull request itself can be forbidden. The fix has to survive that.

Both are fixed, and the workflow checker now refuses a `gh` call without
`--repo` in a job with no checkout.

## After the proof

The workflow file is copied into `.github/workflows/` for the run and removed
afterwards: two copies of it in one repository is one copy too many, and the
copy in `workflows/` is the one that is published.
