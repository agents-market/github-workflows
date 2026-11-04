# The inline thread sync — contract

**Contract version:** `1.1`
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
| a finding a human decided about | nothing is posted — a verdict covers it, and the thread stays ([the verdict layer](#the-verdict-layer)) |

The match happens **before** any thread is closed. Two weaknesses of one class in one file must not
take each other's comments away.

### A thread that says nothing about the code any more

A thread whose file left the diff, or whose line went outdated, is closed — deleted when nobody
answered it, resolved when it is a conversation (a thread with replies is never deleted).

### Counting

The log line says what happened:

```
threads(<marker>) — <posted> posted, <resolved> resolved, <replaced> replaced, <suppressed> suppressed, <verdict> by verdict
```

`replaced` is the counter that says "the finding moved and the old comment was closed". Without it,
"the finding went away" and "nobody looked" look the same.

`<verdict>` counts the findings a human's verdict covered. It is a part of
`<suppressed>`: those findings were not reported because a verdict says so,
not because a comment of the same class was already there.

## The verdict layer

A thread says what the pipeline found. A **verdict** says what a human decided
about it.

The measurement behind it: `web3eco/blockchain#83` collected 22 inline
threads over 4 pushes, 14 of them on one file that is a frozen archival copy
Dependabot never reads, and 8 of them got a "not fixing, by design" reply —
and the finding came back on the next push. The workflow layer could not
help: it knew what it had already said, not what a human had already decided.

So the decision is written down, and the next run reads it.

### The key

A verdict is filed under the same identity the sync keys a thread by:

| the key | it covers |
|---|---|
| `path` | every finding in that file |
| `path::CLASS` | every finding of that class in that file |

`CLASS` is the class the sync uses: the CWE id of a security finding, the
category tag of a style finding — folded through `CANON`, so a verdict filed
under `CWE-330` covers a `CWE-338` finding, because they are one weakness.

The line is not part of the key, and that is measured, not guessed: over 26
findings of `code-review-security-audit` 3.4.7 on three real diffs, **not one
repeated with the same line**. A verdict keyed by a coordinate would expire
every time an unrelated edit moved the code above it.

### The file

The verdicts are a file the human writes and the repository keeps:

```json
{
  ".github/dependabot.yml.reference": {
    "verdict": "accepted",
    "reason": "frozen archival copy; Dependabot does not read it",
    "until": "2027-01-01"
  },
  "src/api/user.ts::CWE-89": {
    "verdict": "accepted",
    "reason": "the string is a column name, not a query",
    "until": "2026-12-01"
  }
}
```

JSON, because the step runs on a runner with no packages: the module is
fetched with a sparse checkout and nothing else. A YAML parser is not
available there.

| field | meaning |
|---|---|
| `verdict` | what the human decided. `accepted` by default. It is recorded, not acted upon: any verdict covers the finding. |
| `reason` | why. Shown to the reader next to the finding. |
| `until` | a date (`YYYY-MM-DD`), and it is **required**. After it the verdict covers nothing and the finding is reported again. |

**Every verdict expires.** A verdict with no date is not a decision about a
finding — it is a decision never to be told about it again — so it does not
apply. A date further out than a year is capped to a year, for the same
reason: a verdict that hides a finding for ever hides a defect that appears
tomorrow too. A date nobody can read is treated as passed.

**A file that does not parse hides nothing.** An unreadable verdict leaves
every finding reported, and the run says what it could not read.

### Where the verdicts may be read from

**From the base of the pull request, not from the pull request — and never
from the caller.**

This is the security property of the whole layer, and it is not a detail: a
verdict silences a finding, so a pull request that carries its own verdicts
is a pull request that silences its own review. The verdicts of the merge
commit are the verdicts the pull request author wrote.

So **the step reads the file itself**, from the base commit, and a verdict
takes effect when it is merged — which is when it was agreed to.

**The caller says nothing at all about the verdicts — not where they live,
and not what they are.** The reusable workflow has no input for them: an
input that carries the content is an input a caller can fill with anything it
likes, and an input that carries the path lets a caller point the step at a
file of their choosing instead of the one the maintainer agreed to.

This is not a detail of the implementation, it is the shape of the API: a
feature that silences a review has to be one where the silencing is decided
by the maintainer, and a maintainer is a branch, not a caller.

### What a verdict does

- the finding is **not posted** — not as a comment, and not as a new thread;
- the comment that is already there **stays** — it is the record of the
  decision, and closing it would erase the reason the finding is not
  reported;
- the run says so: the log line counts the findings a verdict covered, and the
  summary lists them with their reasons;
- the summary also lists the key of every finding no verdict covers, so a
  reader who does not want a finding can write its verdict down without
  reading the contract first.

A verdict covers what its key covers. A verdict on `path::CWE-89` covers every
SQL finding in that file, including one that is not the finding the human had
in mind. That is the granularity the sync already uses — one comment per
(file, class) — so a verdict hides no more than the comment already hid. The
`until` date is the way out.

### What goes into the comment is text, not markup

The key carries a path the model read out of the diff, and the reason is
whatever a human wrote. What the step posts is attributed to the bot, so
neither may change the shape of the comment: no code span may be closed, no
link, no image, no mention, and not more than a line's worth. The paths and
the reasons are escaped before they are printed.

The message of a failure is the same kind of text — it can carry a path from
the diff — and it is escaped by the same function, in the same module, so the
two callers cannot drift.

### Where the file lives

The file is `.github/ai-review-verdicts.json`, in the repository being
reviewed, and the path is fixed — the step reads that file and no other. A
consumer that keeps its verdicts elsewhere has to keep them there; the path
is not an input, because "which file" is the thing a caller must not decide.

The step reads it over the API, at the base commit of the pull request, so it
needs no checkout of the reviewed repository: a reusable workflow is called
from another repository, and a checkout of the caller's repository does not
work on a pull request from a fork.

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
6. **The verdict key** — `path` for a whole file, `path::CLASS` for one class in it, with the class
   folded through `CANON`.
7. **The verdict file** — JSON, with `verdict`, `reason` and `until`. The date is required, a date
   further out than a year is capped, and a file that does not parse hides nothing: every finding is
   reported and the run says what it could not read.
8. **Where the verdicts are read from** — the base of the pull request, by the step itself, from a
   fixed path. A verdict read from the pull request lets its author silence the review of their own
   pull request, and nothing in the step can tell that apart from a legitimate verdict. The caller
   says nothing about the verdicts at all: neither where they live nor what they are.
9. **What the step posts** — text, not markup: the key and the reason are escaped, cut to a line, and
   carry no link, no image and no mention.

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
- **The verdict key changes.** Same failure, same silence: the findings the human decided about come
  back, and nothing says why. The verdict report in the summary is the only place it shows, so a
  consumer that reads its own verdicts back has to notice it. This is a minor bump — the marker format
  and the CANON map did not move, so a consumer that reads its own *comments* back is unaffected.

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

There is nothing else to pass. The verdicts are not an input: the step reads
`.github/ai-review-verdicts.json` from the base of the pull request itself.
A repository that has no such file behaves exactly as it did before the
verdict layer: every finding is reported unless a comment of the same class is
already there.

Pin the full commit SHA, per `CONTRIBUTING.md` — never a tag.

The token needs `pull-requests: write`. The default `GITHUB_TOKEN` may not be allowed to resolve a
thread — the run of 2026-10-22 showed it refused with "Resource not accessible by integration" — so a
consumer that has a token which can should pass it as `THREAD_SYNC_TOKEN`.
