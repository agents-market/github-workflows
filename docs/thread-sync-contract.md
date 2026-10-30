# The inline thread sync — contract

**Contract version:** `1.0`
**Implemented by:** [`scripts/thread-sync.mjs`](../scripts/thread-sync.mjs)
**Called by:** [`workflows/thread-sync.yml`](../.github/workflows/thread-sync.yml) (reusable) and
[`.github/workflows/ai-review.yml`](../.github/workflows/ai-review.yml) (the reference consumer, which
dogfoods the same module — there is one implementation, not two).

A review comment on a pull request is either a **new finding** or **the same finding one line lower**.
Deciding which is the job of the thread sync. This document says how it decides, so a consumer can rely
on it and so a change to it is a change on purpose.

## Why it is written down

The thread sync used to be a two-hundred-line block inside `ai-review.yml`, and every consumer that
wanted it copied it. The fork `web3eco/shared-actions` ([PR #103](https://github.com/web3eco/shared-actions/pull/103))
copied it and had to make two decisions upstream never had to make, because upstream was the only
implementation:

- **what happens to a finding that did not move** — upstream closed the old thread of the class and
  posted a fresh one; the fork kept the standing comment;
- **what the class marker and the `CANON` map mean** — both are contract now, and neither was written
  down anywhere.

Both forks ended up with the same step and two different behaviours, because the behaviour was not
specified. This document is the specification.

The measurement that started it: `web3eco/shared-actions#99` collected **36 threads over 7 pushes and
resolved 0 of them**; `web3eco/verification-tools#26` collected 7 threads over 3 pushes and resolved 0.
Both keyed the live thread by `path:line`, and the line moves.

## The class of a finding

The **class** is the identity of a finding. The line is not: the same weakness comes back one line
lower after an unrelated edit above it.

The class of a finding is **what the pipeline says it is**:

| Pipeline | Class |
|---|---|
| security audit | its CWE id — `CWE-89` |
| style review | the category tag its message opens with — `[naming]` → `NAMING` |

The class is **not** read out of the prose of the message. The message is written from the diff, and a
diff can mention any CWE in a comment; a class read out of the prose is a class nobody chose, and it
changes from run to run. That was the reason the fork's first version disagreed with itself.

A finding with **no class at all** is classless. A classless thread is never closed by a class that
moved, because it cannot be told apart from any other.

### The CANON map

Two ids that name one weakness are one weakness. The catalogue carries both `CWE-330` and `CWE-338`
for "a random number that is not random", so the model picks either from run to run — the run of
2026-10-22 called the same `Math.random` token `CWE-330` and then `CWE-338`, and the comment for the
first id never closed. The reader saw the weakness twice.

`CANON` folds these pairs:

| Id | Folds into |
|---|---|
| `CWE-330` | `CWE-338` |
| `CWE-259` | `CWE-798` |
| `CWE-915` | `CWE-1321` |
| `CWE-321` | `CWE-798` |

The map is deliberately short. A pair belongs here when the two ids name the same defect: 321 (a
hard-coded cryptographic key) and 798 (hard-coded credentials) are the same line of code. `CWE-200`
(information exposure) is **left out on purpose** — it is a wider class than 209 (an error message
with a secret in it), and merging them would hide one of two different exposures in the same file.
Two comments for one weakness is the smaller fault: a hidden finding is worse than a duplicate.

## The marker

Every body this step writes carries the pipeline marker on its **first line**:

```
<!-- am:<marker> -->
```

and, when the finding has a class, the **class marker** on its third line:

```
<!-- am:class:CWE-89 -->
```

The full body of a security finding:

```
<!-- am:code-review-security-audit -->
🔴 **HIGH** `CWE-89` — Injection
<!-- am:class:CWE-89 -->
 (conf 90%): the query is built from the request body
```

The class marker is a hidden HTML comment: the reader never sees it, and the next run reads it back out
of the body.

## The decisions

### A finding that did not move — the standing comment stays

**A thread of the same class on the same line is that finding, already said. It is left where it is,
and nothing is posted for it.**

This is the canonical behaviour, and it is the one upstream and the fork disagreed on. The alternative
— close the old thread of the class and post a fresh one — bounds the thread count just as well, but it
rewrites every comment of every finding on every push: the reader is pinged N times a push for N
findings. That is the churn the measurement complains about. A reader wants to be told once, and to be
told again only when the finding actually changes.

Concretely, for a finding of class `CWE-89` on `src/a.ts`:

| The pull request has | The sync does |
|---|---|
| a `CWE-89` thread on line 10, the finding is on line 10 | nothing — the thread stays, nothing is posted |
| a `CWE-89` thread on line 10, the finding is on line 24 | the thread on line 10 is closed, the finding is posted on line 24 |
| a `CWE-89` thread on line 10, the finding is on line 24, and the thread cannot be closed | nothing is posted — a standing comment the reader can see beats two they cannot |
| no `CWE-89` thread | the finding is posted |
| a thread of another class on the same line | the finding is posted — another weakness does not hide this one |
| a classless thread on the same line | the finding is not posted — it cannot be told apart from this one |
| a `CWE-89` thread, and a **second** `CWE-89` finding on another line of the same file | the second finding gets the thread that is on its line; the thread on the other line is closed and the second finding is posted |

The match happens **before** any thread is closed. Two weaknesses of one class in one file must not
take each other's comments away.

### A thread that says nothing about the code any more

A thread whose file left the diff, or whose line went outdated, is closed — deleted when nobody
answered it, resolved when it is a conversation (a thread with replies is never deleted).

### Counting

The log line says what happened:

```
threads(<marker>) — <posted> posted, <resolved> resolved, <replaced> replaced, <suppressed> suppressed
```

`replaced` is the counter that says "the finding moved and the old comment was closed". Without it,
"the finding went away" and "nobody looked" look the same.

## What a consumer may rely on

1. **The class marker format** — `<!-- am:class:<CLASS> -->`, where `<CLASS>` is upper case and
   letters, digits, `-` and `_`. It is on the third line of the body.
2. **The pipeline marker** — `<!-- am:<marker> -->`, on the first line.
3. **The class of a finding** — its CWE id, or the leading category tag of its message, folded through
   `CANON`.
4. **The decisions above** — a finding that did not move keeps its comment; a finding that moved has
   its old thread closed and is posted afresh.
5. **The body layout** — the pipeline marker, the severity, the class marker, then the confidence and
   the message. The confidence is `(conf N%)`, and the style category tag sits immediately after it.

## What breaks when this changes

- **The marker format changes.** A consumer that reads its own comments back stops recognising them.
  The old comments become classless and are never closed — the run accumulates threads again, silently,
  with no error. This is why the version is a major bump: a consumer pinned to the old version has to
  re-read its comments.
- **`CANON` changes.** Same failure, same silence: a thread written under the old map has a class the
  new map folds differently, and the two no longer match. A *new* pair added to the map is safe — it
  only merges two threads that were already the same weakness.
- **The decision about a finding that did not move changes.** The consumer's pull requests change
  shape: the standing comment is either replaced every push or left alone. This is a minor bump: the
  shape of the contract is the same, the behaviour is not.
- **The body layout changes.** The legacy fallback — the class of a thread posted before the marker
  existed — reads the CWE id from the structured place after the severity, and the category tag from
  after `(conf N%)`. Move either, and the legacy threads stop being recognised.

## The fallback for threads posted before the marker existed

A thread posted before the class marker existed carries no class marker. Its class is read:

1. from the **class marker**, anywhere in the body — the normal path;
2. from the **CWE id** in backticks right after the severity, on the second line — the legacy security
   thread;
3. from the **category tag after `(conf N%)`** — the legacy style thread.

Step 3 is where the bug in issue #38 was: the old code anchored the tag at the **start** of the body,
and a body starts with the pipeline marker, so the tag was never found. Every legacy style thread was
classless, and a classless thread is never closed.

## Where the version lives

The version is `CONTRACT_VERSION` in [`scripts/thread-sync.mjs`](../scripts/thread-sync.mjs), and this
document quotes it. `scripts/check-thread-sync.mjs` checks that the two agree, so the document cannot
drift away from the code.

## Calling it

```yaml
  - name: Sync inline review threads
    uses: agents-market/github-workflows/.github/workflows/thread-sync.yml@<full-commit-sha>
    with:
      findings: ${{ steps.review.outputs.findings_json }}
      marker: code-review-security-audit
    secrets: inherit
```

Pin the full commit SHA, per `CONTRIBUTING.md` — never a tag.

The token needs `pull-requests: write`. The default `GITHUB_TOKEN` may not be allowed to resolve a
thread — the run of 2026-10-22 showed it refused with "Resource not accessible by integration" — so a
consumer that has a token which can should pass it as `THREAD_SYNC_TOKEN`.
